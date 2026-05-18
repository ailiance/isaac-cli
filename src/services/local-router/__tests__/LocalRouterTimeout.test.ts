import * as assert from "assert"
import * as sinon from "sinon"
import { LocalRouter, LocalRouterTimeoutError } from "../LocalRouter"
import { routingObserver } from "../RoutingObserver"
import type { ChatRequest, WorkerEndpoint } from "../types"

const makeEndpoint = (overrides: Partial<WorkerEndpoint> = {}): WorkerEndpoint => ({
	id: "timeout-worker",
	url: "http://localhost:9999/v1",
	modelId: "test-model",
	capabilities: ["general"],
	priority: 10,
	ctxMax: Number.POSITIVE_INFINITY,
	supportsTools: true,
	...overrides,
})

const makeRequest = (overrides: Partial<ChatRequest> = {}): ChatRequest => ({
	messages: [{ role: "user", content: "hello" }],
	...overrides,
})

/**
 * Build an SSE Response whose body is a ReadableStream the test can drive
 * manually. Returns helpers to push chunks, push [DONE], or hang forever.
 *
 * The response.body is wired with the controller's signal so that abort()
 * propagates to reader.read() exactly as the real fetch behaves.
 */
function makeControllableStream(signal?: AbortSignal): {
	response: Response
	push: (text: string) => void
	pushDone: () => void
	close: () => void
} {
	const enc = new TextEncoder()
	let controller!: ReadableStreamDefaultController<Uint8Array>
	const stream = new ReadableStream<Uint8Array>({
		start(c) {
			controller = c
			if (signal) {
				const onAbort = () => {
					try {
						c.error(signal.reason ?? new DOMException("aborted", "AbortError"))
					} catch {
						// already closed
					}
				}
				if (signal.aborted) onAbort()
				else signal.addEventListener("abort", onAbort, { once: true })
			}
		},
	})
	const response = new Response(stream, {
		status: 200,
		headers: { "Content-Type": "text/event-stream" },
	})
	return {
		response,
		push: (text: string) => controller.enqueue(enc.encode(text)),
		pushDone: () => {
			controller.enqueue(enc.encode("data: [DONE]\n\n"))
			try {
				controller.close()
			} catch {
				// ignore
			}
		},
		close: () => {
			try {
				controller.close()
			} catch {
				// ignore
			}
		},
	}
}

const sseChunk = (content: string): string => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`

const drainChunks = async (gen: AsyncGenerator<unknown>): Promise<unknown[]> => {
	const out: unknown[] = []
	for await (const c of gen) out.push(c)
	return out
}

describe("LocalRouter timeouts", () => {
	let sandbox: sinon.SinonSandbox
	let fetchStub: sinon.SinonStub

	beforeEach(() => {
		sandbox = sinon.createSandbox()
		fetchStub = sandbox.stub(globalThis, "fetch")
		routingObserver.reset()
	})

	afterEach(() => {
		sandbox.restore()
		routingObserver.reset()
	})

	it("throws LocalRouterTimeoutError(kind=total) when worker never finishes", async () => {
		fetchStub.callsFake((_url: string, init?: RequestInit) => {
			const { response } = makeControllableStream(init?.signal ?? undefined)
			return Promise.resolve(response)
		})
		const router = new LocalRouter([makeEndpoint()])
		try {
			const req = makeRequest({ timeoutMs: 80, idleTimeoutMs: 5_000 })
			await assert.rejects(
				() => drainChunks(router.chatStream(req)),
				(err: unknown) => {
					assert.ok(err instanceof LocalRouterTimeoutError, `expected LocalRouterTimeoutError, got ${err}`)
					assert.strictEqual((err as LocalRouterTimeoutError).kind, "total")
					assert.strictEqual((err as LocalRouterTimeoutError).workerId, "timeout-worker")
					return true
				},
			)
		} finally {
			router.dispose()
		}
	})

	it("throws LocalRouterTimeoutError(kind=idle) after a chunk then silence", async () => {
		let pushFn: ((s: string) => void) | null = null
		fetchStub.callsFake((_url: string, init?: RequestInit) => {
			const { response, push } = makeControllableStream(init?.signal ?? undefined)
			pushFn = push
			return Promise.resolve(response)
		})
		const router = new LocalRouter([makeEndpoint()])
		try {
			// idle 1.2s — first chunk arrives shortly, then silence beyond idleTimeoutMs.
			// idleInterval = max(1000, 1200/4) = 1000, so abort fires within ~2s.
			const req = makeRequest({ timeoutMs: 30_000, idleTimeoutMs: 1_200 })
			const gen = router.chatStream(req)
			// Push one chunk so lastChunkAt is reset, then go silent.
			setTimeout(() => pushFn?.(sseChunk("hi")), 50)
			await assert.rejects(
				() => drainChunks(gen),
				(err: unknown) => {
					assert.ok(err instanceof LocalRouterTimeoutError)
					assert.strictEqual((err as LocalRouterTimeoutError).kind, "idle")
					return true
				},
			)
		} finally {
			router.dispose()
		}
	}).timeout(8_000)

	it("completes normally when stream finishes before timeout", async () => {
		fetchStub.callsFake((_url: string, init?: RequestInit) => {
			const { response, push, pushDone } = makeControllableStream(init?.signal ?? undefined)
			setImmediate(() => {
				push(sseChunk("hello "))
				push(sseChunk("world"))
				pushDone()
			})
			return Promise.resolve(response)
		})
		const router = new LocalRouter([makeEndpoint()])
		try {
			const req = makeRequest({ timeoutMs: 5_000, idleTimeoutMs: 5_000 })
			const chunks = (await drainChunks(router.chatStream(req))) as Array<{ type: string; text?: string }>
			const text = chunks
				.filter((c) => c.type === "text")
				.map((c) => c.text)
				.join("")
			assert.strictEqual(text, "hello world")
		} finally {
			router.dispose()
		}
	})

	it("aborts immediately when caller passes a pre-aborted signal", async () => {
		fetchStub.callsFake((_url: string, init?: RequestInit) => {
			// fetch should reject because signal is already aborted
			if (init?.signal?.aborted) {
				return Promise.reject(new DOMException("aborted", "AbortError"))
			}
			const { response } = makeControllableStream(init?.signal ?? undefined)
			return Promise.resolve(response)
		})
		const router = new LocalRouter([makeEndpoint()])
		try {
			const ac = new AbortController()
			ac.abort()
			const req = makeRequest({ signal: ac.signal })
			await assert.rejects(() => drainChunks(router.chatStream(req)))
		} finally {
			router.dispose()
		}
	})

	it("external AbortSignal during stream cleans up timers", async () => {
		let pushFn: ((s: string) => void) | null = null
		fetchStub.callsFake((_url: string, init?: RequestInit) => {
			const { response, push } = makeControllableStream(init?.signal ?? undefined)
			pushFn = push
			return Promise.resolve(response)
		})
		const router = new LocalRouter([makeEndpoint()])
		try {
			const ac = new AbortController()
			const req = makeRequest({ signal: ac.signal, timeoutMs: 30_000, idleTimeoutMs: 30_000 })
			const gen = router.chatStream(req)
			setTimeout(() => {
				pushFn?.(sseChunk("partial"))
				ac.abort()
			}, 30)
			await assert.rejects(
				() => drainChunks(gen),
				(err: unknown) => {
					// External abort should NOT be wrapped as LocalRouterTimeoutError
					assert.ok(!(err instanceof LocalRouterTimeoutError), "external abort must not be reported as a timeout")
					return true
				},
			)
		} finally {
			router.dispose()
		}
	}).timeout(5_000)
})
