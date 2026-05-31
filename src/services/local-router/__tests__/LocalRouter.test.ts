import * as assert from "assert"
import * as sinon from "sinon"
import type { ChatStreamChunk } from "../LocalRouter"
import { LocalRouter } from "../LocalRouter"
import { routingObserver } from "../RoutingObserver"
import type { ChatRequest, ChatResponse, ChatTool, WorkerEndpoint } from "../types"

const makeEndpoint = (overrides: Partial<WorkerEndpoint> = {}): WorkerEndpoint => ({
	id: "test-worker",
	url: "http://localhost:9999/v1",
	modelId: "test-model",
	capabilities: ["general"],
	priority: 10,
	ctxMax: Number.POSITIVE_INFINITY,
	supportsTools: false,
	...overrides,
})

const makeResponse = (): ChatResponse => ({
	id: "resp-1",
	choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
})

const makeRequest = (): ChatRequest => ({
	messages: [{ role: "user", content: "hello" }],
})

describe("LocalRouter", () => {
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

	it("pickWorker selects by capability and health", () => {
		const workers = [
			makeEndpoint({ id: "fr-worker", capabilities: ["fr", "general"], priority: 10 }),
			makeEndpoint({ id: "code-worker", capabilities: ["code", "general"], priority: 8 }),
		]
		const router = new LocalRouter(workers)
		// Both start as "unknown" health — pickWorker includes unknowns
		const req: ChatRequest = { messages: [{ role: "user", content: "Comment ça fonctionne ?" }] }
		const picked = router.pickWorker(req)
		// French message → "fr" cap → fr-worker wins (priority 10)
		assert.ok(picked !== null)
		assert.strictEqual(picked?.id, "fr-worker")
		router.dispose()
	})

	it("chat() returns cached response on second call", async () => {
		const resp = makeResponse()
		fetchStub.resolves(new Response(JSON.stringify(resp), { status: 200 }))

		const router = new LocalRouter([makeEndpoint()])
		const req = makeRequest()

		await router.chat(req)
		await router.chat(req)

		// Second call should use cache — fetch only called once
		assert.strictEqual(fetchStub.callCount, 1)
		router.dispose()
	})

	it("chat() fetches from worker on cache miss", async () => {
		const resp = makeResponse()
		fetchStub.resolves(new Response(JSON.stringify(resp), { status: 200 }))

		const router = new LocalRouter([makeEndpoint()])
		const result = await router.chat(makeRequest())

		assert.strictEqual(fetchStub.callCount, 1)
		assert.strictEqual(result.id, resp.id)
		router.dispose()
	})

	it("chat() throws when no worker is available", async () => {
		const router = new LocalRouter([])
		await assert.rejects(() => router.chat(makeRequest()), /no worker available/)
		router.dispose()
	})

	it("chat() cache hit emits cacheHit: true", async () => {
		const resp = makeResponse()
		fetchStub.resolves(new Response(JSON.stringify(resp), { status: 200 }))

		const router = new LocalRouter([makeEndpoint()])
		const req = makeRequest()
		await router.chat(req) // cache miss — populates cache
		routingObserver.reset() // clear first event

		await router.chat(req) // cache hit
		const event = routingObserver.last()
		assert.ok(event !== null)
		assert.strictEqual(event?.cacheHit, true)
		assert.strictEqual(event?.workerId, "test-worker")
		router.dispose()
	})

	it("chat() cache miss emits cacheHit: false", async () => {
		const resp = makeResponse()
		fetchStub.resolves(new Response(JSON.stringify(resp), { status: 200 }))

		const router = new LocalRouter([makeEndpoint()])
		await router.chat(makeRequest())
		const event = routingObserver.last()
		assert.ok(event !== null)
		assert.strictEqual(event?.cacheHit, false)
		assert.strictEqual(event?.workerId, "test-worker")
		router.dispose()
	})

	it("chat() no worker does not emit", async () => {
		const router = new LocalRouter([])
		await assert.rejects(() => router.chat(makeRequest()), /no worker available/)
		assert.strictEqual(routingObserver.last(), null)
		router.dispose()
	})

	// ── chatStream ──────────────────────────────────────────────────────────

	it("chatStream() yields SSE deltas", async () => {
		const sseBody = [
			'data: {"choices":[{"delta":{"content":"Hello"}}]}',
			"",
			'data: {"choices":[{"delta":{"content":" world"}}]}',
			"",
			"data: [DONE]",
			"",
		].join("\n")

		const encoder = new TextEncoder()
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(sseBody))
				controller.close()
			},
		})
		fetchStub.resolves(new Response(stream, { status: 200 }))

		const router = new LocalRouter([makeEndpoint()])
		const chunks: ChatStreamChunk[] = []
		for await (const chunk of router.chatStream(makeRequest())) {
			chunks.push(chunk)
		}
		assert.deepStrictEqual(chunks, [
			{ type: "text", text: "Hello" },
			{ type: "text", text: " world" },
		])
		router.dispose()
	})

	it("chatStream() throws when no worker is available", async () => {
		const router = new LocalRouter([])
		await assert.rejects(async () => {
			// Need to actually start iterating to trigger the throw
			for await (const _ of router.chatStream(makeRequest())) {
				// noop
			}
		}, /no worker available/)
		router.dispose()
	})

	it("chatStream() throws on worker error response", async () => {
		fetchStub.resolves(new Response("Internal error", { status: 500 }))

		const router = new LocalRouter([makeEndpoint()])
		await assert.rejects(async () => {
			for await (const _ of router.chatStream(makeRequest())) {
				// noop
			}
		}, /worker test-worker returned 500/)
		router.dispose()
	})

	// ── tool emulation ──────────────────────────────────────────────────────

	it("chatStream() passes tools natively when supportsTools:true", async () => {
		const sseBody = ['data: {"choices":[{"delta":{"content":"done"}}]}', "", "data: [DONE]", ""].join("\n")
		const encoder = new TextEncoder()
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(sseBody))
				controller.close()
			},
		})
		fetchStub.resolves(new Response(stream, { status: 200 }))

		const tool: ChatTool = {
			type: "function",
			function: { name: "read_file", description: "Read a file", parameters: { type: "object", properties: {} } },
		}
		const router = new LocalRouter([makeEndpoint({ supportsTools: true })])
		for await (const _ of router.chatStream({ ...makeRequest(), tools: [tool] })) {
			// consume
		}

		const callBody = JSON.parse(fetchStub.firstCall.args[1].body)
		assert.ok(Array.isArray(callBody.tools), "body should have tools array")
		assert.strictEqual(callBody.tools[0].function.name, "read_file")
		assert.strictEqual(callBody.tool_choice, "auto")
		router.dispose()
	})

	it("chatStream() injects tools into system prompt when supportsTools:false", async () => {
		const sseBody = ['data: {"choices":[{"delta":{"content":"done"}}]}', "", "data: [DONE]", ""].join("\n")
		const encoder = new TextEncoder()
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(sseBody))
				controller.close()
			},
		})
		fetchStub.resolves(new Response(stream, { status: 200 }))

		const tool: ChatTool = {
			type: "function",
			function: { name: "read_file", description: "Read a file", parameters: { type: "object", properties: {} } },
		}
		const req: ChatRequest = {
			messages: [
				{ role: "system", content: "You are an assistant." },
				{ role: "user", content: "hello" },
			],
			tools: [tool],
		}
		const router = new LocalRouter([makeEndpoint({ supportsTools: false })])
		for await (const _ of router.chatStream(req)) {
			// consume
		}

		const callBody = JSON.parse(fetchStub.firstCall.args[1].body)
		assert.strictEqual(callBody.tools, undefined, "tools should not be passed natively")
		const sysMsg = callBody.messages.find((m: { role: string }) => m.role === "system")
		assert.ok(sysMsg, "system message should be present")
		assert.ok(sysMsg.content.includes("read_file"), "tool name should appear in system prompt")
		assert.ok(
			sysMsg.content.includes("execute_command") || sysMsg.content.includes("json"),
			"tool call instructions should be in system prompt",
		)
		router.dispose()
	})

	it("chatStream() emulation: parses <tool_call> and yields tool_call chunk", async () => {
		// Send the whole response as a single SSE chunk with embedded tool_call
		const content = 'Hello <tool_call>\n{"name":"foo","arguments":{"x":1}}\n</tool_call>'
		const sseBody = [`data: {"choices":[{"delta":{"content":${JSON.stringify(content)}}}]}`, "", "data: [DONE]", ""].join(
			"\n",
		)
		const encoder = new TextEncoder()
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(sseBody))
				controller.close()
			},
		})
		fetchStub.resolves(new Response(stream, { status: 200 }))

		const tool: ChatTool = {
			type: "function",
			function: { name: "foo", description: "Foo tool", parameters: { type: "object", properties: {} } },
		}
		const router = new LocalRouter([makeEndpoint({ supportsTools: false })])
		const chunks: ChatStreamChunk[] = []
		for await (const chunk of router.chatStream({ ...makeRequest(), tools: [tool] })) {
			chunks.push(chunk)
		}

		const toolChunks = chunks.filter((c) => c.type === "tool_call")
		assert.ok(toolChunks.length >= 1, "should yield at least one tool_call chunk")
		const tc = toolChunks[0] as Extract<ChatStreamChunk, { type: "tool_call" }>
		assert.strictEqual(tc.name, "foo")
		assert.strictEqual(tc.argumentsRaw, JSON.stringify({ x: 1 }))

		const textChunks = chunks.filter((c) => c.type === "text")
		const allText = textChunks.map((c) => (c as Extract<ChatStreamChunk, { type: "text" }>).text).join("")
		assert.ok(allText.includes("Hello"), "text before tool_call should be yielded")
		router.dispose()
	})

	// ── pickWorker tool routing ─────────────────────────────────────────────

	it("pickWorker() force routes to tool-capable worker when tools present", () => {
		const workers = [
			makeEndpoint({ id: "gemma-emulated", capabilities: ["general"], priority: 10, supportsTools: false }),
			makeEndpoint({ id: "eurollm-native", capabilities: ["general"], priority: 5, supportsTools: true }),
		]
		const router = new LocalRouter(workers)
		const req: ChatRequest = {
			messages: [{ role: "user", content: "hello" }],
			tools: [
				{
					type: "function",
					function: { name: "read_file", description: "", parameters: { type: "object", properties: {} } },
				},
			],
		}
		const picked = router.pickWorker(req)
		// eurollm wins despite lower priority because supportsTools:true
		assert.strictEqual(picked?.id, "eurollm-native")
		router.dispose()
	})

	it("pickWorker() logs warning and falls back to emulated worker when no tool-capable worker", () => {
		const workers = [makeEndpoint({ id: "gemma-emulated", capabilities: ["general"], priority: 10, supportsTools: false })]
		const router = new LocalRouter(workers)
		const req: ChatRequest = {
			messages: [{ role: "user", content: "hello" }],
			tools: [
				{
					type: "function",
					function: { name: "read_file", description: "", parameters: { type: "object", properties: {} } },
				},
			],
		}
		const picked = router.pickWorker(req)
		// Only emulated worker available — still returned
		assert.strictEqual(picked?.id, "gemma-emulated")
		router.dispose()
	})

	// ── json fence / bash fence emulation ───────────────────────────────────

	it("chatStream() emulation: parses ```json fenced tool call", async () => {
		const content = 'Sure!\n```json\n{"name":"read_file","arguments":{"path":"/tmp/x"}}\n```'
		const sseBody = [`data: {"choices":[{"delta":{"content":${JSON.stringify(content)}}}]}`, "", "data: [DONE]", ""].join(
			"\n",
		)
		const encoder = new TextEncoder()
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(sseBody))
				controller.close()
			},
		})
		fetchStub.resolves(new Response(stream, { status: 200 }))

		const tool: ChatTool = {
			type: "function",
			function: { name: "read_file", description: "Read a file", parameters: { type: "object", properties: {} } },
		}
		const router = new LocalRouter([makeEndpoint({ supportsTools: false })])
		const chunks: ChatStreamChunk[] = []
		for await (const chunk of router.chatStream({ ...makeRequest(), tools: [tool] })) {
			chunks.push(chunk)
		}

		const toolChunks = chunks.filter((c) => c.type === "tool_call")
		assert.ok(toolChunks.length >= 1, "should yield at least one tool_call chunk")
		const tc = toolChunks[0] as Extract<ChatStreamChunk, { type: "tool_call" }>
		assert.strictEqual(tc.name, "read_file")
		assert.strictEqual(tc.argumentsRaw, JSON.stringify({ path: "/tmp/x" }))
		router.dispose()
	})

	it("chatStream() emulation: parses ```bash fence as execute_command when tool listed", async () => {
		const content = "```bash\nls -la /tmp\n```"
		const sseBody = [`data: {"choices":[{"delta":{"content":${JSON.stringify(content)}}}]}`, "", "data: [DONE]", ""].join(
			"\n",
		)
		const encoder = new TextEncoder()
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(sseBody))
				controller.close()
			},
		})
		fetchStub.resolves(new Response(stream, { status: 200 }))

		const tool: ChatTool = {
			type: "function",
			function: {
				name: "execute_command",
				description: "Run a shell command",
				parameters: { type: "object", properties: {} },
			},
		}
		const router = new LocalRouter([makeEndpoint({ supportsTools: false })])
		const chunks: ChatStreamChunk[] = []
		for await (const chunk of router.chatStream({ ...makeRequest(), tools: [tool] })) {
			chunks.push(chunk)
		}

		const toolChunks = chunks.filter((c) => c.type === "tool_call")
		assert.ok(toolChunks.length >= 1, "should yield at least one tool_call chunk")
		const tc = toolChunks[0] as Extract<ChatStreamChunk, { type: "tool_call" }>
		assert.strictEqual(tc.name, "execute_command")
		const args = JSON.parse(tc.argumentsRaw) as { command: string; requires_approval: boolean }
		assert.strictEqual(args.command, "ls -la /tmp")
		// Commands parsed from a model's markdown fence must default to requiring
		// approval — they are untrusted and must hit the approval gate.
		assert.strictEqual(args.requires_approval, true)
		router.dispose()
	})

	it("chatStream() emulation: ignores ```bash fence when execute_command not in tools", async () => {
		const content = "```bash\nls -la /tmp\n```"
		const sseBody = [`data: {"choices":[{"delta":{"content":${JSON.stringify(content)}}}]}`, "", "data: [DONE]", ""].join(
			"\n",
		)
		const encoder = new TextEncoder()
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(sseBody))
				controller.close()
			},
		})
		fetchStub.resolves(new Response(stream, { status: 200 }))

		// Only read_file in tools — no execute_command
		const tool: ChatTool = {
			type: "function",
			function: { name: "read_file", description: "Read a file", parameters: { type: "object", properties: {} } },
		}
		const router = new LocalRouter([makeEndpoint({ supportsTools: false })])
		const chunks: ChatStreamChunk[] = []
		for await (const chunk of router.chatStream({ ...makeRequest(), tools: [tool] })) {
			chunks.push(chunk)
		}

		// bash fence should not produce a tool_call since execute_command is absent
		const toolChunks = chunks.filter((c) => c.type === "tool_call")
		assert.strictEqual(toolChunks.length, 0, "no tool_call should be yielded")
		// The content should come through as text
		const textChunks = chunks.filter((c) => c.type === "text")
		const allText = textChunks.map((c) => (c as Extract<ChatStreamChunk, { type: "text" }>).text).join("")
		assert.ok(allText.includes("ls -la /tmp"), "bash content should be yielded as text")
		router.dispose()
	})

	it("chatStream() emulation: holds buffer at partial marker and flushes on completion", async () => {
		// Deliver content in two chunks — first ends mid-fence
		const part1 = "Hello ```"
		const part2 = 'json\n{"name":"foo","arguments":{}}\n```'
		const sseBody = [
			`data: {"choices":[{"delta":{"content":${JSON.stringify(part1)}}}]}`,
			"",
			`data: {"choices":[{"delta":{"content":${JSON.stringify(part2)}}}]}`,
			"",
			"data: [DONE]",
			"",
		].join("\n")
		const encoder = new TextEncoder()
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(sseBody))
				controller.close()
			},
		})
		fetchStub.resolves(new Response(stream, { status: 200 }))

		const tool: ChatTool = {
			type: "function",
			function: { name: "foo", description: "", parameters: { type: "object", properties: {} } },
		}
		const router = new LocalRouter([makeEndpoint({ supportsTools: false })])
		const chunks: ChatStreamChunk[] = []
		for await (const chunk of router.chatStream({ ...makeRequest(), tools: [tool] })) {
			chunks.push(chunk)
		}

		const toolChunks = chunks.filter((c) => c.type === "tool_call")
		assert.ok(toolChunks.length >= 1, "should yield tool_call chunk once complete")
		const tc = toolChunks[0] as Extract<ChatStreamChunk, { type: "tool_call" }>
		assert.strictEqual(tc.name, "foo")
		// Text before the fence should be yielded
		const textChunks = chunks.filter((c) => c.type === "text")
		const allText = textChunks.map((c) => (c as Extract<ChatStreamChunk, { type: "text" }>).text).join("")
		assert.ok(allText.includes("Hello"), "text before partial marker should be yielded")
		router.dispose()
	})

	// ── multi-format emulation (few-shot) ────────────────────────────────────

	it("chatStream() emulation: parses ```tool fence as preferred format", async () => {
		const content = '```tool\n{"name":"read_file","arguments":{"path":"foo.txt"}}\n```'
		const sseBody = [`data: {"choices":[{"delta":{"content":${JSON.stringify(content)}}}]}`, "", "data: [DONE]", ""].join(
			"\n",
		)
		const encoder = new TextEncoder()
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(sseBody))
				controller.close()
			},
		})
		fetchStub.resolves(new Response(stream, { status: 200 }))

		const tool: ChatTool = {
			type: "function",
			function: {
				name: "read_file",
				description: "Read a file",
				parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
			},
		}
		const router = new LocalRouter([makeEndpoint({ supportsTools: false })])
		const chunks: ChatStreamChunk[] = []
		for await (const chunk of router.chatStream({ ...makeRequest(), tools: [tool] })) {
			chunks.push(chunk)
		}

		const toolChunks = chunks.filter((c) => c.type === "tool_call")
		assert.ok(toolChunks.length >= 1, "should yield tool_call from ```tool fence")
		const tc = toolChunks[0] as Extract<ChatStreamChunk, { type: "tool_call" }>
		assert.strictEqual(tc.name, "read_file")
		assert.strictEqual(tc.argumentsRaw, JSON.stringify({ path: "foo.txt" }))
		router.dispose()
	})

	it('chatStream() emulation: parses plain read_file("foo.txt") syntax', async () => {
		const content = 'read_file("foo.txt")'
		const sseBody = [`data: {"choices":[{"delta":{"content":${JSON.stringify(content)}}}]}`, "", "data: [DONE]", ""].join(
			"\n",
		)
		const encoder = new TextEncoder()
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(sseBody))
				controller.close()
			},
		})
		fetchStub.resolves(new Response(stream, { status: 200 }))

		const tool: ChatTool = {
			type: "function",
			function: {
				name: "read_file",
				description: "Read a file",
				parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
			},
		}
		const router = new LocalRouter([makeEndpoint({ supportsTools: false })])
		const chunks: ChatStreamChunk[] = []
		for await (const chunk of router.chatStream({ ...makeRequest(), tools: [tool] })) {
			chunks.push(chunk)
		}

		const toolChunks = chunks.filter((c) => c.type === "tool_call")
		assert.ok(toolChunks.length >= 1, "should yield tool_call from plain function-call syntax")
		const tc = toolChunks[0] as Extract<ChatStreamChunk, { type: "tool_call" }>
		assert.strictEqual(tc.name, "read_file")
		const args = JSON.parse(tc.argumentsRaw) as { path: string }
		assert.strictEqual(args.path, "foo.txt")
		router.dispose()
	})

	it("chatStream() emulation: parses plain list_files(path='src/', recursive=true) named args", async () => {
		const content = "list_files(path='src/', recursive=true)"
		const sseBody = [`data: {"choices":[{"delta":{"content":${JSON.stringify(content)}}}]}`, "", "data: [DONE]", ""].join(
			"\n",
		)
		const encoder = new TextEncoder()
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(sseBody))
				controller.close()
			},
		})
		fetchStub.resolves(new Response(stream, { status: 200 }))

		const tool: ChatTool = {
			type: "function",
			function: {
				name: "list_files",
				description: "List files",
				parameters: {
					type: "object",
					properties: { path: { type: "string" }, recursive: { type: "boolean" } },
					required: ["path"],
				},
			},
		}
		const router = new LocalRouter([makeEndpoint({ supportsTools: false })])
		const chunks: ChatStreamChunk[] = []
		for await (const chunk of router.chatStream({ ...makeRequest(), tools: [tool] })) {
			chunks.push(chunk)
		}

		const toolChunks = chunks.filter((c) => c.type === "tool_call")
		assert.ok(toolChunks.length >= 1, "should yield tool_call from named arg function-call syntax")
		const tc = toolChunks[0] as Extract<ChatStreamChunk, { type: "tool_call" }>
		assert.strictEqual(tc.name, "list_files")
		const args = JSON.parse(tc.argumentsRaw) as { path: string; recursive: boolean }
		assert.strictEqual(args.path, "src/")
		assert.strictEqual(args.recursive, true)
		router.dispose()
	})

	it("chatStream() emulation: ignores tool name not in tools[] for plain func-call", async () => {
		// console.log is a JS function but not in tools — must not be matched
		const content = 'console.log("hello")'
		const sseBody = [`data: {"choices":[{"delta":{"content":${JSON.stringify(content)}}}]}`, "", "data: [DONE]", ""].join(
			"\n",
		)
		const encoder = new TextEncoder()
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(sseBody))
				controller.close()
			},
		})
		fetchStub.resolves(new Response(stream, { status: 200 }))

		const tool: ChatTool = {
			type: "function",
			function: {
				name: "read_file",
				description: "Read a file",
				parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
			},
		}
		const router = new LocalRouter([makeEndpoint({ supportsTools: false })])
		const chunks: ChatStreamChunk[] = []
		for await (const chunk of router.chatStream({ ...makeRequest(), tools: [tool] })) {
			chunks.push(chunk)
		}

		const toolChunks = chunks.filter((c) => c.type === "tool_call")
		assert.strictEqual(toolChunks.length, 0, "console.log should not be matched as a tool_call")
		router.dispose()
	})

	it("chatStream() emulation: rejects malformed JSON in ```tool fence gracefully", async () => {
		const content = "```tool\n{bad json here\n```"
		const sseBody = [`data: {"choices":[{"delta":{"content":${JSON.stringify(content)}}}]}`, "", "data: [DONE]", ""].join(
			"\n",
		)
		const encoder = new TextEncoder()
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(sseBody))
				controller.close()
			},
		})
		fetchStub.resolves(new Response(stream, { status: 200 }))

		const tool: ChatTool = {
			type: "function",
			function: {
				name: "read_file",
				description: "Read a file",
				parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
			},
		}
		const router = new LocalRouter([makeEndpoint({ supportsTools: false })])
		// Should not throw — malformed JSON falls through gracefully
		const chunks: ChatStreamChunk[] = []
		await assert.doesNotReject(async () => {
			for await (const chunk of router.chatStream({ ...makeRequest(), tools: [tool] })) {
				chunks.push(chunk)
			}
		})
		// No tool_call should be emitted — malformed JSON is ignored
		const toolChunks = chunks.filter((c) => c.type === "tool_call")
		assert.strictEqual(toolChunks.length, 0, "malformed JSON should not produce a tool_call")
		router.dispose()
	})

	it("chatStream() emulation: holds buffer on partial ```tool prefix", async () => {
		// Deliver content split right after the opening fence
		const part1 = "Hello ```"
		const part2 = 'tool\n{"name":"read_file","arguments":{"path":"bar.txt"}}\n```'
		const sseBody = [
			`data: {"choices":[{"delta":{"content":${JSON.stringify(part1)}}}]}`,
			"",
			`data: {"choices":[{"delta":{"content":${JSON.stringify(part2)}}}]}`,
			"",
			"data: [DONE]",
			"",
		].join("\n")
		const encoder = new TextEncoder()
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(sseBody))
				controller.close()
			},
		})
		fetchStub.resolves(new Response(stream, { status: 200 }))

		const tool: ChatTool = {
			type: "function",
			function: {
				name: "read_file",
				description: "Read a file",
				parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
			},
		}
		const router = new LocalRouter([makeEndpoint({ supportsTools: false })])
		const chunks: ChatStreamChunk[] = []
		for await (const chunk of router.chatStream({ ...makeRequest(), tools: [tool] })) {
			chunks.push(chunk)
		}

		const toolChunks = chunks.filter((c) => c.type === "tool_call")
		assert.ok(toolChunks.length >= 1, "should yield tool_call once fence is complete")
		const tc = toolChunks[0] as Extract<ChatStreamChunk, { type: "tool_call" }>
		assert.strictEqual(tc.name, "read_file")
		const textChunks = chunks.filter((c) => c.type === "text")
		const allText = textChunks.map((c) => (c as Extract<ChatStreamChunk, { type: "text" }>).text).join("")
		assert.ok(allText.includes("Hello"), "text before partial marker should be yielded")
		router.dispose()
	})

	it("chatStream() emulation: holds buffer on partial function-call starter (read_file(", async () => {
		// Hold begins when we see "read_file(" — before the closing paren arrives
		const part1 = 'Sure, read_file("'
		const part2 = 'baz.txt")'
		const sseBody = [
			`data: {"choices":[{"delta":{"content":${JSON.stringify(part1)}}}]}`,
			"",
			`data: {"choices":[{"delta":{"content":${JSON.stringify(part2)}}}]}`,
			"",
			"data: [DONE]",
			"",
		].join("\n")
		const encoder = new TextEncoder()
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(sseBody))
				controller.close()
			},
		})
		fetchStub.resolves(new Response(stream, { status: 200 }))

		const tool: ChatTool = {
			type: "function",
			function: {
				name: "read_file",
				description: "Read a file",
				parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
			},
		}
		const router = new LocalRouter([makeEndpoint({ supportsTools: false })])
		const chunks: ChatStreamChunk[] = []
		for await (const chunk of router.chatStream({ ...makeRequest(), tools: [tool] })) {
			chunks.push(chunk)
		}

		// After both parts, the complete read_file("baz.txt") should be parsed
		const toolChunks = chunks.filter((c) => c.type === "tool_call")
		assert.ok(toolChunks.length >= 1, "should yield tool_call once function-call is complete")
		const tc = toolChunks[0] as Extract<ChatStreamChunk, { type: "tool_call" }>
		assert.strictEqual(tc.name, "read_file")
		const args = JSON.parse(tc.argumentsRaw) as { path: string }
		assert.strictEqual(args.path, "baz.txt")
		router.dispose()
	})

	it("emulation prompt contains the 4 required EXAMPLES (few-shot)", async () => {
		const sseBody = ['data: {"choices":[{"delta":{"content":"done"}}]}', "", "data: [DONE]", ""].join("\n")
		const encoder = new TextEncoder()
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(sseBody))
				controller.close()
			},
		})
		fetchStub.resolves(new Response(stream, { status: 200 }))

		const tools: ChatTool[] = [
			{
				type: "function",
				function: {
					name: "read_file",
					description: "Read a file",
					parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
				},
			},
		]
		const router = new LocalRouter([makeEndpoint({ supportsTools: false })])
		for await (const _ of router.chatStream({ ...makeRequest(), tools })) {
			// consume
		}

		const callBody = JSON.parse(fetchStub.firstCall.args[1].body)
		const sysMsg = callBody.messages.find((m: { role: string }) => m.role === "system")
		assert.ok(sysMsg, "system message should exist")
		const content: string = sysMsg.content
		// Verify all 4 few-shot EXAMPLES are present
		assert.ok(content.includes('"read_file"'), "prompt should include read_file example")
		assert.ok(content.includes('"list_files"'), "prompt should include list_files example")
		assert.ok(content.includes('"write_to_file"'), "prompt should include write_to_file example")
		assert.ok(content.includes('"execute_command"'), "prompt should include execute_command example")
		assert.ok(content.includes("```tool"), "prompt should use ```tool fence format")
		router.dispose()
	})

	it("chatStream() passes through native tool_calls delta from supportsTools worker", async () => {
		const sseBody = [
			'data: {"choices":[{"delta":{"tool_calls":[{"id":"call_abc","function":{"name":"bar","arguments":"{\\"y\\":2}"}}]}}]}',
			"",
			"data: [DONE]",
			"",
		].join("\n")
		const encoder = new TextEncoder()
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(sseBody))
				controller.close()
			},
		})
		fetchStub.resolves(new Response(stream, { status: 200 }))

		const router = new LocalRouter([makeEndpoint({ supportsTools: true })])
		const chunks: ChatStreamChunk[] = []
		for await (const chunk of router.chatStream(makeRequest())) {
			chunks.push(chunk)
		}

		const toolChunks = chunks.filter((c) => c.type === "tool_call")
		assert.strictEqual(toolChunks.length, 1)
		const tc = toolChunks[0] as Extract<ChatStreamChunk, { type: "tool_call" }>
		assert.strictEqual(tc.id, "call_abc")
		assert.strictEqual(tc.name, "bar")
		assert.strictEqual(tc.argumentsRaw, '{"y":2}')
		router.dispose()
	})
})
