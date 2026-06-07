import http from "node:http"

/**
 * Minimal OpenAI-compatible mock LLM server for CLI E2E tests.
 *
 * Zero dependencies (Node's native `http`). It serves two endpoints the
 * `openai` provider code path exercises:
 *
 *   - GET  /v1/models           -> {"data":[]} (the boot-time prewarm probe)
 *   - POST /v1/chat/completions -> text/event-stream (native OpenAI tool calls)
 *
 * The completions endpoint is a tiny state machine driven by the request body:
 *   - Turn 1 (no `role:"tool"` message present yet) -> emit a `write_to_file`
 *     tool call that creates `hello.txt` with `HELLO_E2E`.
 *   - Turn 2 (a tool result is now in the history) -> emit `attempt_completion`
 *     to end the agent loop with exit code 0.
 *
 * The SSE shape mirrors what `src/core/api/providers/openai.ts` +
 * `ToolCallProcessor` consume: streamed `delta.tool_calls`, a terminal
 * `finish_reason:"tool_calls"`, a `usage` chunk (REQUIRED — every ApiHandler
 * must yield a final usage chunk), then `data: [DONE]`.
 */

export interface MockLlmServer {
	port: number
	baseUrl: string
	hits: string[]
	close: () => Promise<void>
}

const WRITE_TOOL_NAME = "write_to_file"
const COMPLETION_TOOL_NAME = "attempt_completion"

interface ChatMessage {
	role?: string
	[key: string]: unknown
}

function sseChunk(res: http.ServerResponse, obj: unknown): void {
	res.write(`data: ${JSON.stringify(obj)}\n\n`)
}

function streamToolCall(res: http.ServerResponse, toolName: string, args: Record<string, unknown>): void {
	const id = "chatcmpl-e2e"
	const created = Math.floor(Date.now() / 1000)
	const model = "mock-e2e"

	res.writeHead(200, {
		"Content-Type": "text/event-stream",
		"Cache-Control": "no-cache",
		Connection: "keep-alive",
	})

	// Opening assistant role chunk.
	sseChunk(res, {
		id,
		object: "chat.completion.chunk",
		created,
		model,
		choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
	})

	// Native tool call delta: id + name + full arguments in one delta.
	// ToolCallProcessor yields once it has id, name and arguments together.
	sseChunk(res, {
		id,
		object: "chat.completion.chunk",
		created,
		model,
		choices: [
			{
				index: 0,
				delta: {
					tool_calls: [
						{
							index: 0,
							id: "call_e2e_1",
							type: "function",
							function: { name: toolName, arguments: JSON.stringify(args) },
						},
					],
				},
				finish_reason: null,
			},
		],
	})

	// Terminal finish_reason for tool calls.
	sseChunk(res, {
		id,
		object: "chat.completion.chunk",
		created,
		model,
		choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
	})

	// Usage chunk — REQUIRED. Every ApiHandler must yield a final usage chunk.
	sseChunk(res, {
		id,
		object: "chat.completion.chunk",
		created,
		model,
		choices: [],
		usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
	})

	res.write("data: [DONE]\n\n")
	res.end()
}

/**
 * Start the mock LLM server on an ephemeral loopback port.
 */
export function startMockLlmServer(): Promise<MockLlmServer> {
	const hits: string[] = []
	const server = http.createServer((req, res) => {
		const chunks: Buffer[] = []
		req.on("data", (c: Buffer) => chunks.push(c))
		req.on("end", () => {
			const url = req.url ?? ""
			hits.push(`${req.method} ${url}`)

			// Prewarm probe.
			if (req.method === "GET" && url.startsWith("/v1/models")) {
				res.writeHead(200, { "Content-Type": "application/json" })
				res.end(JSON.stringify({ data: [] }))
				return
			}

			// Chat completions (the only streaming endpoint we care about).
			if (req.method === "POST" && url.includes("/chat/completions")) {
				const body = Buffer.concat(chunks).toString("utf8")
				let messages: ChatMessage[] = []
				try {
					const parsed = JSON.parse(body) as { messages?: ChatMessage[] }
					messages = parsed.messages ?? []
				} catch {
					messages = []
				}

				// A `role:"tool"` message only exists after the first tool call's
				// result was fed back -> that signals turn 2.
				const hasToolResult = messages.some((m) => m.role === "tool")

				if (hasToolResult) {
					streamToolCall(res, COMPLETION_TOOL_NAME, { result: "done" })
				} else {
					streamToolCall(res, WRITE_TOOL_NAME, { path: "hello.txt", content: "HELLO_E2E" })
				}
				return
			}

			res.writeHead(404)
			res.end()
		})
	})

	return new Promise((resolve, reject) => {
		server.on("error", reject)
		server.listen(0, "127.0.0.1", () => {
			const address = server.address()
			if (address === null || typeof address === "string") {
				reject(new Error("Failed to bind mock LLM server to a TCP port"))
				return
			}
			const port = address.port
			resolve({
				port,
				baseUrl: `http://127.0.0.1:${port}/v1`,
				hits,
				close: () =>
					new Promise<void>((res, rej) => {
						server.close((err) => (err ? rej(err) : res()))
					}),
			})
		})
	})
}
