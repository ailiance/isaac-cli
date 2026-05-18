import * as assert from "assert"
import * as sinon from "sinon"
import type { ChatStreamChunk } from "../LocalRouter"
import { LocalRouter } from "../LocalRouter"
import { routingObserver } from "../RoutingObserver"
import type { ChatRequest, ChatTool, WorkerEndpoint } from "../types"

/**
 * Edge-case coverage for the priority-aware tool-call parser exercised
 * indirectly through chatStream(). Sprint 4 task D.
 *
 * These tests focus on failure modes that the audit flagged:
 *   - malformed JSON inside fences / XML / inline
 *   - truncated streams (no closing marker, no [DONE])
 *   - native streaming with split argument deltas + parallel calls
 *   - format auto-detect across registry profiles
 *   - tool-name validation (S4-C) integration
 *   - bash fence whitelist
 *   - false positives in conversational text
 */

const makeEndpoint = (overrides: Partial<WorkerEndpoint> = {}): WorkerEndpoint => ({
	id: "edge-worker",
	url: "http://localhost:9999/v1",
	modelId: "eu-kiki-gemma-3-4b-it",
	capabilities: ["general"],
	priority: 10,
	ctxMax: Number.POSITIVE_INFINITY,
	supportsTools: false,
	...overrides,
})

const makeRequest = (): ChatRequest => ({
	messages: [{ role: "user", content: "hello" }],
})

/** Build an SSE Response from raw SSE-formatted strings. */
function makeSseResponse(chunks: string[]): Response {
	const encoder = new TextEncoder()
	let i = 0
	const stream = new ReadableStream<Uint8Array>({
		pull(ctrl) {
			if (i < chunks.length) {
				ctrl.enqueue(encoder.encode(chunks[i++]))
			} else {
				ctrl.close()
			}
		},
	})
	return new Response(stream, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	})
}

/** Wrap arbitrary content as one SSE delta line. */
const sseContent = (content: string): string => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`

/** Wrap a native tool_calls delta as one SSE line. */
const sseToolCallDelta = (delta: { index?: number; id?: string; function?: { name?: string; arguments?: string } }): string =>
	`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [delta] } }] })}\n\n`

const SSE_DONE = "data: [DONE]\n\n"

const READ_FILE_TOOL: ChatTool = {
	type: "function",
	function: {
		name: "read_file",
		description: "Read a file",
		parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
	},
}

const EXECUTE_COMMAND_TOOL: ChatTool = {
	type: "function",
	function: {
		name: "execute_command",
		description: "Run a shell command",
		parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
	},
}

async function drain(router: LocalRouter, req: ChatRequest): Promise<ChatStreamChunk[]> {
	const out: ChatStreamChunk[] = []
	for await (const c of router.chatStream(req)) out.push(c)
	return out
}

const toolChunks = (chunks: ChatStreamChunk[]) =>
	chunks.filter((c): c is Extract<ChatStreamChunk, { type: "tool_call" }> => c.type === "tool_call")

const allText = (chunks: ChatStreamChunk[]) =>
	chunks
		.filter((c): c is Extract<ChatStreamChunk, { type: "text" }> => c.type === "text")
		.map((c) => c.text)
		.join("")

describe("LocalRouter parser edge cases (Sprint 4 task D)", () => {
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

	// ── Malformed JSON in markdown fence ─────────────────────────────────────

	it("malformed JSON in ```tool fence does not yield a tool_call", async () => {
		const content = '```tool\n{"name": "read_file", "arguments": {invalid syntax\n```'
		fetchStub.resolves(makeSseResponse([sseContent(content), SSE_DONE]))

		const router = new LocalRouter([makeEndpoint()])
		try {
			const chunks = await drain(router, { ...makeRequest(), tools: [READ_FILE_TOOL] })
			assert.strictEqual(toolChunks(chunks).length, 0, "no tool_call for malformed fence body")
		} finally {
			router.dispose()
		}
	})

	// BUG: invalid fence body greedily matches second fence's closing brace,
	// preventing the recovery. Documented in report — not fixed here.
	it.skip("[BUG] valid ```tool fence after a malformed one is recovered (parser limitation)", async () => {
		const content = '```tool\n{bad json\n```\n```tool\n{"name":"read_file","arguments":{"path":"ok.txt"}}\n```'
		fetchStub.resolves(makeSseResponse([sseContent(content), SSE_DONE]))
		const router = new LocalRouter([makeEndpoint()])
		try {
			const chunks = await drain(router, { ...makeRequest(), tools: [READ_FILE_TOOL] })
			const tcs = toolChunks(chunks)
			assert.strictEqual(tcs.length, 1, "should recover from the second valid fence")
			assert.strictEqual(tcs[0].name, "read_file")
		} finally {
			router.dispose()
		}
	})

	// ── Malformed JSON in XML tag ────────────────────────────────────────────

	it("malformed JSON in <tool_call> XML does not yield", async () => {
		const content = '<tool_call>{"name": "read_file", "arguments": invalid}</tool_call>'
		fetchStub.resolves(makeSseResponse([sseContent(content), SSE_DONE]))
		const router = new LocalRouter([makeEndpoint({ modelId: "qwen-coder-7b" })])
		try {
			const chunks = await drain(router, { ...makeRequest(), tools: [READ_FILE_TOOL] })
			assert.strictEqual(toolChunks(chunks).length, 0)
		} finally {
			router.dispose()
		}
	})

	it("unterminated <tool_call> tag is held in buffer and never yields", async () => {
		const content = '<tool_call>{"name":"read_file","arguments":{"path":"x"}}'
		fetchStub.resolves(makeSseResponse([sseContent(content), SSE_DONE]))
		const router = new LocalRouter([makeEndpoint({ modelId: "qwen-coder-7b" })])
		try {
			const chunks = await drain(router, { ...makeRequest(), tools: [READ_FILE_TOOL] })
			assert.strictEqual(toolChunks(chunks).length, 0, "no tool_call without closing </tool_call>")
		} finally {
			router.dispose()
		}
	})

	// ── Malformed JSON inline ────────────────────────────────────────────────

	it("truncated inline JSON does not yield a tool_call", async () => {
		const content = '\n{"name": "read_file", "arguments":\n'
		fetchStub.resolves(makeSseResponse([sseContent(content), SSE_DONE]))
		const router = new LocalRouter([makeEndpoint({ modelId: "mistral-7b-instruct" })])
		try {
			const chunks = await drain(router, { ...makeRequest(), tools: [READ_FILE_TOOL] })
			assert.strictEqual(toolChunks(chunks).length, 0)
		} finally {
			router.dispose()
		}
	})

	// ── Truncated stream ─────────────────────────────────────────────────────

	// FINDING: a payload like `\n{"name":...,"arguments":{...}}` matches the
	// json_inline extractor even when emitted inside an unterminated ```tool
	// fence. The fence opener and trailing ``` line are not required for that
	// extractor — by design it accepts bare inline JSON. So a worker that
	// crashes mid-emission can still produce a fully-formed tool_call.
	// This is arguably correct (recover what we can) but worth pinning.
	it("stream closing mid-fence still yields if inner JSON is well-formed (json_inline fallback)", async () => {
		const partial = '```tool\n{"name":"read_file","arguments":{"path":"foo"}}'
		fetchStub.resolves(makeSseResponse([sseContent(partial)]))
		const router = new LocalRouter([makeEndpoint()])
		try {
			const chunks = await drain(router, { ...makeRequest(), tools: [READ_FILE_TOOL] })
			const tcs = toolChunks(chunks)
			// Documents current behaviour: the inline JSON is recovered via the
			// json_inline extractor at final flush, even with no closing fence.
			assert.strictEqual(tcs.length, 1, "well-formed inner JSON is recovered by json_inline at flush")
			assert.strictEqual(tcs[0].name, "read_file")
		} finally {
			router.dispose()
		}
	})

	it("stream closing mid-fence with malformed inner JSON does not yield", async () => {
		// Truly broken — no extractor can recover anything.
		const partial = '```tool\n{"name":"read_file","arguments":{bad'
		fetchStub.resolves(makeSseResponse([sseContent(partial)]))
		const router = new LocalRouter([makeEndpoint()])
		try {
			const chunks = await drain(router, { ...makeRequest(), tools: [READ_FILE_TOOL] })
			assert.strictEqual(toolChunks(chunks).length, 0, "no extractor recovers a broken payload")
		} finally {
			router.dispose()
		}
	})

	it("stream closing mid native tool_call delta cleans up without yielding bogus calls", async () => {
		// First delta: id + name. Second delta: partial arguments. Stream then closes.
		fetchStub.resolves(
			makeSseResponse([
				sseToolCallDelta({ index: 0, id: "call_xyz", function: { name: "read_file", arguments: "" } }),
				sseToolCallDelta({ index: 0, function: { arguments: '{"path":"hal' } }),
				// no [DONE], stream just ends
			]),
		)
		const router = new LocalRouter([makeEndpoint({ modelId: "eurollm-22b", supportsTools: true })])
		try {
			const chunks = await drain(router, makeRequest())
			// LocalRouter currently passes deltas through verbatim — assert the
			// arguments are not falsified into something parseable downstream.
			const tcs = toolChunks(chunks)
			for (const tc of tcs) {
				if (tc.argumentsRaw && tc.argumentsRaw !== "{}") {
					assert.ok(
						!tc.argumentsRaw.endsWith("}") || tc.argumentsRaw === "{}",
						"partial arguments should remain partial, not be pseudo-closed",
					)
				}
			}
		} finally {
			router.dispose()
		}
	})

	// ── Args partiels (streaming natif) ──────────────────────────────────────

	it("native streaming: 3 deltas for the same call are passed through; downstream concatenates by id", async () => {
		// LocalRouter forwards each delta as a separate tool_call chunk.
		// Aggregation by tc.id is the consumer's responsibility — this test
		// pins the contract: id is preserved, name is from delta1, args from
		// delta2+delta3 are forwarded individually.
		fetchStub.resolves(
			makeSseResponse([
				sseToolCallDelta({ index: 0, id: "call_aaa", function: { name: "read_file", arguments: "" } }),
				sseToolCallDelta({ index: 0, function: { arguments: '{"pa' } }),
				sseToolCallDelta({ index: 0, function: { arguments: 'th":"a.txt"}' } }),
				`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\n`,
				SSE_DONE,
			]),
		)
		const router = new LocalRouter([makeEndpoint({ modelId: "eurollm-22b", supportsTools: true })])
		try {
			const chunks = await drain(router, makeRequest())
			const tcs = toolChunks(chunks)
			assert.ok(tcs.length >= 1, "at least one delta should produce a tool_call chunk")
			// The first delta carries name + id.
			assert.strictEqual(tcs[0].id, "call_aaa")
			assert.strictEqual(tcs[0].name, "read_file")
			// Concatenated args across all forwarded deltas (in stream order)
			// form valid JSON. Note: subsequent deltas without explicit id get
			// a synthetic random id from LocalRouter — aggregation by id is
			// the consumer's job and out of scope here. We just check that
			// the raw fragments line up to a parseable object.
			const concatenatedArgs = tcs.map((tc) => (tc.argumentsRaw === "{}" ? "" : tc.argumentsRaw)).join("")
			assert.doesNotThrow(() => JSON.parse(concatenatedArgs), "concatenated args must parse")
			const parsed = JSON.parse(concatenatedArgs) as { path: string }
			assert.strictEqual(parsed.path, "a.txt")
		} finally {
			router.dispose()
		}
	})

	it("native streaming: 2 parallel tool_calls (index 0 and 1) both yielded", async () => {
		fetchStub.resolves(
			makeSseResponse([
				sseToolCallDelta({ index: 0, id: "call_a", function: { name: "read_file", arguments: '{"path":"a"}' } }),
				sseToolCallDelta({ index: 1, id: "call_b", function: { name: "read_file", arguments: '{"path":"b"}' } }),
				SSE_DONE,
			]),
		)
		const router = new LocalRouter([makeEndpoint({ modelId: "eurollm-22b", supportsTools: true })])
		try {
			const chunks = await drain(router, makeRequest())
			const tcs = toolChunks(chunks)
			assert.strictEqual(tcs.length, 2)
			const ids = tcs.map((t) => t.id)
			assert.ok(ids.includes("call_a"))
			assert.ok(ids.includes("call_b"))
		} finally {
			router.dispose()
		}
	})

	// ── Format auto-detect ───────────────────────────────────────────────────

	it("gemma worker (priority=markdown_fence) parses XML output via fallback extractor", async () => {
		const content = '<tool_call>\n{"name":"read_file","arguments":{"path":"src/x.ts"}}\n</tool_call>'
		fetchStub.resolves(makeSseResponse([sseContent(content), SSE_DONE]))
		const router = new LocalRouter([makeEndpoint({ modelId: "eu-kiki-gemma-3-4b-it" })])
		try {
			const chunks = await drain(router, { ...makeRequest(), tools: [READ_FILE_TOOL] })
			const tcs = toolChunks(chunks)
			assert.strictEqual(tcs.length, 1, "fallback to xml extractor should succeed")
			assert.strictEqual(tcs[0].name, "read_file")
		} finally {
			router.dispose()
		}
	})

	it("qwen worker (priority=xml) parses ```tool fence via fallback extractor", async () => {
		const content = '```tool\n{"name":"read_file","arguments":{"path":"src/x.ts"}}\n```'
		fetchStub.resolves(makeSseResponse([sseContent(content), SSE_DONE]))
		const router = new LocalRouter([makeEndpoint({ modelId: "qwen-coder-7b" })])
		try {
			const chunks = await drain(router, { ...makeRequest(), tools: [READ_FILE_TOOL] })
			const tcs = toolChunks(chunks)
			assert.strictEqual(tcs.length, 1, "fallback to tool_fence extractor should succeed")
			assert.strictEqual(tcs[0].name, "read_file")
		} finally {
			router.dispose()
		}
	})

	// ── Tool-name validation (S4-C integration) ──────────────────────────────

	it("rejects tool name with ':' (digikey:search) regardless of fence format", async () => {
		const content = '```tool\n{"name":"digikey:search","arguments":{"q":"opamp"}}\n```'
		fetchStub.resolves(makeSseResponse([sseContent(content), SSE_DONE]))
		const router = new LocalRouter([makeEndpoint()])
		try {
			const chunks = await drain(router, { ...makeRequest(), tools: [READ_FILE_TOOL] })
			assert.strictEqual(toolChunks(chunks).length, 0, "colon-namespaced names must be rejected")
		} finally {
			router.dispose()
		}
	})

	it("rejects tool name with '.' (kicad.new_project)", async () => {
		const content = '```tool\n{"name":"kicad.new_project","arguments":{"path":"/tmp/p"}}\n```'
		fetchStub.resolves(makeSseResponse([sseContent(content), SSE_DONE]))
		const router = new LocalRouter([makeEndpoint()])
		try {
			const chunks = await drain(router, { ...makeRequest(), tools: [READ_FILE_TOOL] })
			assert.strictEqual(toolChunks(chunks).length, 0, "dotted names must be rejected")
		} finally {
			router.dispose()
		}
	})

	// ── Bash fence → execute_command ─────────────────────────────────────────

	it("```bash fence yields execute_command when whitelisted", async () => {
		const content = "```bash\nls -la\n```"
		fetchStub.resolves(makeSseResponse([sseContent(content), SSE_DONE]))
		const router = new LocalRouter([makeEndpoint()])
		try {
			const chunks = await drain(router, { ...makeRequest(), tools: [EXECUTE_COMMAND_TOOL] })
			const tcs = toolChunks(chunks)
			assert.strictEqual(tcs.length, 1)
			assert.strictEqual(tcs[0].name, "execute_command")
			const args = JSON.parse(tcs[0].argumentsRaw) as { command: string }
			assert.strictEqual(args.command, "ls -la")
		} finally {
			router.dispose()
		}
	})

	it("```bash fence is ignored when execute_command is not in tools", async () => {
		const content = "```bash\nrm -rf /\n```"
		fetchStub.resolves(makeSseResponse([sseContent(content), SSE_DONE]))
		const router = new LocalRouter([makeEndpoint()])
		try {
			const chunks = await drain(router, { ...makeRequest(), tools: [READ_FILE_TOOL] })
			assert.strictEqual(toolChunks(chunks).length, 0, "bash fence must be inert without execute_command")
			assert.ok(allText(chunks).includes("rm -rf /"), "bash content surfaces as text instead")
		} finally {
			router.dispose()
		}
	})

	// ── Faux positifs textuels ───────────────────────────────────────────────

	it("conversational backticks (separated, not a fence) do not yield", async () => {
		// Three backticks split across the prose — not a contiguous fence opener.
		const content = "Use the ` character or ` ` ` (three backticks) to format code."
		fetchStub.resolves(makeSseResponse([sseContent(content), SSE_DONE]))
		const router = new LocalRouter([makeEndpoint()])
		try {
			const chunks = await drain(router, { ...makeRequest(), tools: [READ_FILE_TOOL] })
			assert.strictEqual(toolChunks(chunks).length, 0)
		} finally {
			router.dispose()
		}
	})

	it("inline-quoted <tool_call> in prose (no JSON body) does not yield", async () => {
		const content = "The marker `<tool_call>` is used to wrap tool invocations in XML mode."
		fetchStub.resolves(makeSseResponse([sseContent(content), SSE_DONE]))
		const router = new LocalRouter([makeEndpoint({ modelId: "qwen-coder-7b" })])
		try {
			const chunks = await drain(router, { ...makeRequest(), tools: [READ_FILE_TOOL] })
			assert.strictEqual(toolChunks(chunks).length, 0, "documentation mention must not be parsed as a call")
		} finally {
			router.dispose()
		}
	})
})
