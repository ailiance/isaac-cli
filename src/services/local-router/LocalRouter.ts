import { Logger } from "@shared/services/Logger"
import { renderEmulationPrompt } from "./EmulationPrompts"
import { estimateTokens } from "./estimateTokens"
import { HealthMonitor } from "./HealthMonitor"
import { getToolProfile, type ToolCallFormat } from "./ModelRegistry"
import { PromptClassifier } from "./PromptClassifier"
import { ResponseCache } from "./ResponseCache"
import { routingObserver } from "./RoutingObserver"
import type { ChatRequest, ChatResponse, ChatTool, WorkerEndpoint } from "./types"

export type ChatStreamChunk =
	| { type: "text"; text: string }
	| { type: "tool_call"; id: string; name: string; argumentsRaw: string }

/**
 * Thrown when the SSE stream from a local worker exceeds the configured
 * timeout. Distinguishes between total wall-clock ("total") and heartbeat
 * silence ("idle") so callers can pick a sensible fallback strategy.
 */
export class LocalRouterTimeoutError extends Error {
	readonly kind: "total" | "idle"
	readonly workerId: string
	readonly timeoutMs: number
	constructor(kind: "total" | "idle", workerId: string, timeoutMs: number) {
		const what = kind === "total" ? "did not finish streaming" : "produced no chunk"
		super(`LocalRouter timeout: worker ${workerId} ${what} within ${timeoutMs}ms (${kind}).`)
		this.name = "LocalRouterTimeoutError"
		this.kind = kind
		this.workerId = workerId
		this.timeoutMs = timeoutMs
	}
}

/**
 * Build an internal AbortController whose abort() also fires when any of the
 * provided external signals abort. Caller is responsible for invoking the
 * returned `dispose()` to detach listeners (preventing leaks when the same
 * external signal is shared across many requests).
 */
function combineAbortSignals(signals: (AbortSignal | undefined)[]): {
	controller: AbortController
	dispose: () => void
} {
	const controller = new AbortController()
	const detachers: Array<() => void> = []
	for (const s of signals) {
		if (!s) continue
		if (s.aborted) {
			controller.abort(s.reason)
			break
		}
		const onAbort = () => controller.abort(s.reason)
		s.addEventListener("abort", onAbort, { once: true })
		detachers.push(() => s.removeEventListener("abort", onAbort))
	}
	return {
		controller,
		dispose: () => {
			for (const d of detachers) d()
		},
	}
}

/**
 * Default SSE timeouts (mirrors localRouterTimeoutMs / localRouterIdleTimeoutMs
 * in state-keys.ts). Kept local so this module stays buildable from contexts
 * where StateManager isn't initialized (unit tests, CLI bootstrap).
 */
const DEFAULT_LOCAL_ROUTER_TOTAL_TIMEOUT_MS = 60_000
const DEFAULT_LOCAL_ROUTER_IDLE_TIMEOUT_MS = 20_000

function sanitizeTimeout(v: number | undefined, fallback: number): number {
	return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : fallback
}

function formatToolsAsPromptText(tools: ChatTool[]): string {
	let out = "## Available tools\n\n"
	for (const t of tools) {
		out += `### \`${t.function.name}\`\n${t.function.description ?? ""}\n\nParameters:\n\`\`\`json\n${JSON.stringify(t.function.parameters, null, 2)}\n\`\`\`\n\n`
	}
	return out.trim()
}

export class LocalRouter {
	private workers = new Map<string, WorkerEndpoint>()
	private cache = new ResponseCache()
	private classifier = new PromptClassifier()
	private health: HealthMonitor

	constructor(endpoints: WorkerEndpoint[]) {
		for (const e of endpoints) this.workers.set(e.id, e)
		this.health = new HealthMonitor(this.workers)
	}

	start(): void {
		this.health.start()
	}

	dispose(): void {
		this.health.stop()
		this.cache.clear()
	}

	/**
	 * Pick the best worker for a request based on capability classification
	 * and current health. Returns null if no suitable worker is up.
	 *
	 * When req.tools is non-empty, workers with supportsTools:true are
	 * preferred. If no tool-capable worker is available, the router falls
	 * back to emulated workers with a warning.
	 */
	pickWorker(req: ChatRequest): WorkerEndpoint | null {
		const cap = this.classifier.classify(req.messages)
		const estTokens = estimateTokens(req)

		let candidates = [...this.workers.values()]
			.filter((w) => this.health.isUp(w.id) || this.health.getHealth(w.id) === "unknown")
			.filter((w) => w.capabilities.includes(cap))
			.filter((w) => w.ctxMax >= estTokens)
			.sort((a, b) => b.priority - a.priority)

		// When tools are requested, prefer native tool-capable workers.
		if (req.tools && req.tools.length > 0 && candidates.length > 0) {
			const native = candidates.filter((w) => w.supportsTools)
			if (native.length > 0) {
				candidates = native
			} else {
				Logger.warn("[LocalRouter] No tool-capable worker available; falling back to emulation")
			}
		}

		if (candidates.length > 0) return candidates[0]

		// Fallback: any up worker with sufficient ctx, ignoring capability
		let fallback = [...this.workers.values()]
			.filter((w) => this.health.isUp(w.id))
			.filter((w) => w.ctxMax >= estTokens)
			.sort((a, b) => b.priority - a.priority)

		if (req.tools && req.tools.length > 0 && fallback.length > 0) {
			const native = fallback.filter((w) => w.supportsTools)
			if (native.length > 0) {
				fallback = native
			} else {
				Logger.warn("[LocalRouter] No tool-capable worker available in fallback; falling back to emulation")
			}
		}

		if (fallback[0]) return fallback[0]

		// Last-resort: largest-ctx up worker even if undersized — let the
		// worker fail explicitly rather than throwing "no worker" silently.
		const lastResort = [...this.workers.values()].filter((w) => this.health.isUp(w.id)).sort((a, b) => b.ctxMax - a.ctxMax)
		if (lastResort[0]) {
			Logger.warn(
				`[LocalRouter] Request ~${estTokens} tokens, largest worker ${lastResort[0].id} has ctxMax=${lastResort[0].ctxMax}. Expect "context exceeded".`,
			)
		}
		return lastResort[0] ?? null
	}

	async chat(req: ChatRequest): Promise<ChatResponse> {
		const worker = this.pickWorker(req)
		if (!worker) throw new Error("LocalRouter: no worker available")

		const category = this.classifier.classify(req.messages)
		const estTokens = estimateTokens(req)

		const cacheKey = ResponseCache.keyOf(req, worker.id)
		const cached = this.cache.get(cacheKey)
		if (cached) {
			Logger.info(`[LocalRouter] cache hit for ${worker.id}`)
			routingObserver.emit({ ts: Date.now(), category, workerId: worker.id, cacheHit: true, estTokens })
			return cached
		}

		const url = worker.url.replace(/\/$/, "")
		const body = { ...req, model: worker.modelId, stream: false }
		const res = await fetch(`${url}/chat/completions`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		})
		if (!res.ok) {
			const text = await res.text().catch(() => "")
			throw new Error(`[LocalRouter] worker ${worker.id} returned ${res.status}: ${text.slice(0, 200)}`)
		}
		const data = (await res.json()) as ChatResponse
		this.cache.set(cacheKey, data)
		routingObserver.emit({ ts: Date.now(), category, workerId: worker.id, cacheHit: false, estTokens })
		return data
	}

	/**
	 * Try to extract a tool call from the accumulated text buffer.
	 * Accepts five formats in priority order:
	 *   1. ```tool\n{...}\n```  (preferred few-shot format)
	 *   2. <tool_call>{...}</tool_call>
	 *   3. ```json\n{...}\n```  (JSON fence with a "name" field)
	 *   4. ```bash|sh|shell|console\n<cmd>\n```  → execute_command (only when listed in tools)
	 *   5. plain function-call syntax: read_file("foo.txt") or read_file(path="foo.txt")
	 */
	private static tryExtract(
		buf: string,
		tools: ChatTool[],
	): { match: RegExpMatchArray; toolCall: { name: string; arguments: Record<string, unknown> } } | null {
		const toolNames = new Set(tools.map((t) => t.function.name))

		// 1. ```tool fence (preferred)
		const toolFence = buf.match(/```tool\s*(\{[\s\S]*?\})\s*```/)
		if (toolFence) {
			try {
				const parsed = JSON.parse(toolFence[1]) as { name?: string; arguments?: unknown; args?: unknown }
				if (parsed.name && toolNames.has(parsed.name)) {
					return {
						match: toolFence,
						toolCall: {
							name: parsed.name,
							arguments: (parsed.arguments ?? parsed.args ?? {}) as Record<string, unknown>,
						},
					}
				}
			} catch {
				// malformed JSON — fall through
			}
		}

		// 2. <tool_call>{...}</tool_call>
		const xml = buf.match(/<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/)
		if (xml) {
			try {
				const parsed = JSON.parse(xml[1]) as { name?: string; arguments?: unknown; args?: unknown }
				if (parsed.name && toolNames.has(parsed.name)) {
					return {
						match: xml,
						toolCall: {
							name: parsed.name,
							arguments: (parsed.arguments ?? parsed.args ?? {}) as Record<string, unknown>,
						},
					}
				}
			} catch {
				// malformed JSON — fall through
			}
		}

		// 3. ```json fence with name field
		const jsonFence = buf.match(/```json\s*(\{[\s\S]*?\})\s*```/)
		if (jsonFence) {
			try {
				const parsed = JSON.parse(jsonFence[1]) as { name?: string; arguments?: unknown; args?: unknown }
				if (parsed.name && toolNames.has(parsed.name)) {
					return {
						match: jsonFence,
						toolCall: {
							name: parsed.name,
							arguments: (parsed.arguments ?? parsed.args ?? {}) as Record<string, unknown>,
						},
					}
				}
			} catch {
				// malformed JSON — fall through
			}
		}

		// 4. ```bash | ```sh | ```shell | ```console → execute_command
		if (toolNames.has("execute_command")) {
			const bashFence = buf.match(/```(?:bash|sh|shell|console)\s*([\s\S]*?)```/)
			if (bashFence) {
				const command = bashFence[1].trim()
				if (command) {
					return {
						match: bashFence,
						toolCall: { name: "execute_command", arguments: { command, requires_approval: false } },
					}
				}
			}
		}

		// 5. Plain function-call syntax: read_file("foo.txt") or read_file(path="foo.txt")
		for (const toolName of toolNames) {
			const re = new RegExp(`\\b${toolName}\\s*\\(([^)]*)\\)`)
			const m = buf.match(re)
			if (m) {
				const argsStr = m[1].trim()
				const args = LocalRouter.parsePlainArgs(
					argsStr,
					tools.find((t) => t.function.name === toolName),
				)
				if (args !== null) {
					return { match: m, toolCall: { name: toolName, arguments: args } }
				}
			}
		}

		return null
	}

	/**
	 * Parse plain function-call args: "foo.txt", "path='foo.txt'", "path='foo.txt', recursive=true"
	 * Returns null if parsing fails or unsupported.
	 */
	private static parsePlainArgs(s: string, tool: ChatTool | undefined): Record<string, unknown> | null {
		if (!tool) return null
		const params = tool.function.parameters as { properties?: Record<string, { type?: string }>; required?: string[] }
		const propNames = Object.keys(params?.properties ?? {})
		if (propNames.length === 0) return null

		const trimmed = s.trim()
		if (!trimmed) return {}

		// Single positional arg → assign to first required param (or first prop)
		if (!trimmed.includes("=") && !trimmed.includes(":")) {
			// Strip quotes
			const value = trimmed.replace(/^["']|["']$/g, "")
			const firstParam = (params.required && params.required[0]) || propNames[0]
			return { [firstParam]: value }
		}

		// Named args: key=value, key="value", key='value'
		const out: Record<string, unknown> = {}
		const re = /(\w+)\s*[=:]\s*(?:"([^"]*)"|'([^']*)'|(\w+))/g
		let match: RegExpExecArray | null
		// biome-ignore lint/suspicious/noAssignInExpressions: regex exec loop idiom
		while ((match = re.exec(trimmed)) !== null) {
			const key = match[1]
			const val = match[2] ?? match[3] ?? match[4]
			if (val === "true") out[key] = true
			else if (val === "false") out[key] = false
			else if (/^-?\d+$/.test(val)) out[key] = Number.parseInt(val, 10)
			else out[key] = val
		}
		return Object.keys(out).length > 0 ? out : null
	}

	async *chatStream(req: ChatRequest): AsyncGenerator<ChatStreamChunk> {
		const worker = this.pickWorker(req)
		if (!worker) throw new Error("LocalRouter: no worker available")

		const cap = this.classifier.classify(req.messages)
		const estTokens = estimateTokens(req)

		routingObserver.emit({
			ts: Date.now(),
			category: cap,
			workerId: worker.id,
			cacheHit: false,
			estTokens,
		})

		// biome-ignore lint/suspicious/noExplicitAny: dynamic body assembly
		const body: any = { ...req, model: worker.modelId, stream: true }
		let needsEmulation = false

		// Registry-driven format selection. Backward-compat: a worker advertising
		// supportsTools:true keeps the native path as long as the profile allows
		// it (isNative); a worker with supportsTools:false always emulates.
		const profile = getToolProfile(worker.modelId)
		const useNative = profile.isNative && worker.supportsTools
		// Format used for emulation prompt rendering. When the worker is
		// non-native but the profile is native (registry thinks "deepseek" is
		// OpenAI native but a local worker doesn't expose it), fall back to
		// markdown_fence which is the safest emulated format.
		const emulationFormat: ToolCallFormat = profile.isNative ? "markdown_fence" : profile.format

		// Strip transport-only fields that should never hit the wire.
		delete body.signal
		delete body.timeoutMs
		delete body.idleTimeoutMs

		if (req.tools && req.tools.length > 0) {
			if (useNative) {
				// Pass tools natively to the worker
				body.tools = req.tools
				body.tool_choice = "auto"
			} else {
				// Emulate via system prompt injection — template chosen by format.
				needsEmulation = true
				const emulationPreamble = renderEmulationPrompt(emulationFormat, req.tools)
				const sysIdx = body.messages.findIndex((m: { role: string }) => m.role === "system")
				if (sysIdx >= 0) {
					body.messages[sysIdx] = {
						...body.messages[sysIdx],
						content: body.messages[sysIdx].content + emulationPreamble,
					}
				} else {
					body.messages.unshift({ role: "system", content: emulationPreamble })
				}
				delete body.tools
			}
		}

		const url = worker.url.replace(/\/$/, "")

		// Resolve timeouts: per-request override → built-in default.
		// Callers (e.g. providers/litellm.ts) read user settings via StateManager
		// and pass them through req.timeoutMs / req.idleTimeoutMs; LocalRouter
		// stays free of any storage dependency so it can run in tests/CLI bootstrap.
		const totalTimeoutMs = sanitizeTimeout(req.timeoutMs, DEFAULT_LOCAL_ROUTER_TOTAL_TIMEOUT_MS)
		const idleTimeoutMs = sanitizeTimeout(req.idleTimeoutMs, DEFAULT_LOCAL_ROUTER_IDLE_TIMEOUT_MS)

		// Compose internal abort controller with caller's signal (if any).
		const { controller, dispose: detachSignals } = combineAbortSignals([req.signal])

		// Track which side fired so we can wrap AbortError → LocalRouterTimeoutError.
		let timeoutKind: "total" | "idle" | null = null
		const totalTimer: ReturnType<typeof setTimeout> = setTimeout(() => {
			timeoutKind = "total"
			controller.abort(new LocalRouterTimeoutError("total", worker.id, totalTimeoutMs))
		}, totalTimeoutMs)

		let lastChunkAt = Date.now()
		// Idle check fires at most ~4×/s, never more often than once per second.
		const idleInterval = Math.max(1000, Math.floor(idleTimeoutMs / 4))
		const idleTimer: ReturnType<typeof setInterval> = setInterval(() => {
			if (Date.now() - lastChunkAt > idleTimeoutMs) {
				timeoutKind = "idle"
				controller.abort(new LocalRouterTimeoutError("idle", worker.id, idleTimeoutMs))
			}
		}, idleInterval)

		const cleanup = () => {
			clearTimeout(totalTimer)
			clearInterval(idleTimer)
			detachSignals()
			if (!controller.signal.aborted) controller.abort()
		}

		let res: Response
		try {
			res = await fetch(`${url}/chat/completions`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Accept: "text/event-stream",
				},
				body: JSON.stringify(body),
				signal: controller.signal,
			})
		} catch (err) {
			cleanup()
			if (timeoutKind) {
				throw new LocalRouterTimeoutError(
					timeoutKind,
					worker.id,
					timeoutKind === "total" ? totalTimeoutMs : idleTimeoutMs,
				)
			}
			throw err
		}
		if (!res.ok) {
			cleanup()
			const errText = await res.text().catch(() => "")
			throw new Error(`[LocalRouter] worker ${worker.id} returned ${res.status}: ${errText.slice(0, 200)}`)
		}
		if (!res.body) {
			cleanup()
			throw new Error("[LocalRouter] worker did not return a body for streaming")
		}

		// Parse SSE: "data: {...}\n\n" lines
		const reader = (res.body as ReadableStream<Uint8Array>).getReader()
		const decoder = new TextDecoder("utf-8")
		let lineBuffer = ""
		// For emulation: accumulate text to detect <tool_call>...</tool_call>
		let textBuffer = ""

		try {
			while (true) {
				const { value, done } = await reader.read()
				if (done) break
				lastChunkAt = Date.now()
				lineBuffer += decoder.decode(value, { stream: true })
				let nl: number
				// biome-ignore lint/suspicious/noAssignInExpressions: SSE parser idiom
				while ((nl = lineBuffer.indexOf("\n")) !== -1) {
					const line = lineBuffer.slice(0, nl).trim()
					lineBuffer = lineBuffer.slice(nl + 1)
					if (!line.startsWith("data:")) continue
					const data = line.slice(5).trim()
					if (data === "[DONE]") {
						// Flush any pending text on DONE
						if (textBuffer && !needsEmulation) {
							yield { type: "text", text: textBuffer }
						} else if (textBuffer && needsEmulation) {
							// Emulation: try one last parse, then flush remaining as text
							const extracted = LocalRouter.tryExtract(textBuffer, req.tools ?? [])
							if (extracted) {
								const { match, toolCall } = extracted
								const before = textBuffer.slice(0, match.index!)
								if (before.trim()) yield { type: "text", text: before }
								yield {
									type: "tool_call",
									id: `call_${Date.now()}_done`,
									name: toolCall.name,
									argumentsRaw: JSON.stringify(toolCall.arguments),
								}
							} else if (textBuffer.trim()) {
								yield { type: "text", text: textBuffer }
							}
						}
						return
					}
					try {
						const chunk = JSON.parse(data) as {
							choices?: Array<{ delta?: { content?: string; tool_calls?: any[] } }>
						}
						const delta = chunk.choices?.[0]?.delta
						if (!delta) continue

						// Native tool_calls from a supportsTools worker (eurollm streaming)
						if (delta.tool_calls) {
							for (const tc of delta.tool_calls) {
								yield {
									type: "tool_call",
									id: tc.id ?? `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
									name: tc.function?.name ?? "",
									argumentsRaw: tc.function?.arguments ?? "{}",
								}
							}
						}

						if (delta.content) {
							if (needsEmulation) {
								textBuffer += delta.content
								// Extract complete tool call blocks (XML, json fence, bash fence)
								for (;;) {
									const extracted = LocalRouter.tryExtract(textBuffer, req.tools ?? [])
									if (!extracted) break
									const { match, toolCall } = extracted
									const before = textBuffer.slice(0, match.index!)
									if (before.trim()) yield { type: "text", text: before }
									yield {
										type: "tool_call",
										id: `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
										name: toolCall.name,
										argumentsRaw: JSON.stringify(toolCall.arguments),
									}
									textBuffer = textBuffer.slice(match.index! + match[0].length)
								}
								// Yield text before any partial marker; hold the rest.
								// "```" alone is a prefix of all fence markers — hold it too.
								const partialMarkers = [
									"<tool_call",
									"```tool",
									"```json",
									"```bash",
									"```sh",
									"```shell",
									"```console",
									"```",
								]
								// Also hold if we see a tool name followed by "(" (plain function-call pattern)
								const toolCallStarters = (req.tools ?? []).map((t) => `${t.function.name}(`)
								let earliestPartial = -1
								for (const m of [...partialMarkers, ...toolCallStarters]) {
									const i = textBuffer.indexOf(m)
									if (i !== -1 && (earliestPartial === -1 || i < earliestPartial)) earliestPartial = i
								}
								if (earliestPartial > 0) {
									yield { type: "text", text: textBuffer.slice(0, earliestPartial) }
									textBuffer = textBuffer.slice(earliestPartial)
								} else if (earliestPartial === -1) {
									// No partial marker — flush all accumulated text
									if (textBuffer) {
										yield { type: "text", text: textBuffer }
										textBuffer = ""
									}
								}
								// else earliestPartial === 0 — wait for more data
							} else {
								yield { type: "text", text: delta.content }
							}
						}
					} catch {
						// ignore malformed SSE chunks
					}
				}
			}
			// Final flush of any remaining buffered text
			if (textBuffer) {
				const extracted = LocalRouter.tryExtract(textBuffer, req.tools ?? [])
				if (extracted) {
					const { match, toolCall } = extracted
					const before = textBuffer.slice(0, match.index!)
					if (before.trim()) yield { type: "text", text: before }
					yield {
						type: "tool_call",
						id: `call_${Date.now()}_final`,
						name: toolCall.name,
						argumentsRaw: JSON.stringify(toolCall.arguments),
					}
				} else if (!needsEmulation) {
					yield { type: "text", text: textBuffer }
				} else if (textBuffer.trim()) {
					// Emulation mode but no tool_call pattern — yield as plain text
					yield { type: "text", text: textBuffer }
				}
			}
		} catch (err) {
			// If a timeout fired, the underlying reader.read() rejects with an
			// AbortError. Translate that into the typed timeout error so callers
			// can fallback. Otherwise, surface the original error untouched —
			// caller-driven aborts (req.signal) keep their AbortError shape.
			if (timeoutKind) {
				throw new LocalRouterTimeoutError(
					timeoutKind,
					worker.id,
					timeoutKind === "total" ? totalTimeoutMs : idleTimeoutMs,
				)
			}
			throw err
		} finally {
			try {
				reader.releaseLock()
			} catch {
				// ignore
			}
			cleanup()
		}
	}
}
