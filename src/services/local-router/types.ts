export type WorkerCapability = "fr" | "code" | "embed" | "reason" | "general"

export interface WorkerEndpoint {
	id: string // "studio-eurollm", "studio-apertus", "tower-gemma", etc.
	url: string // "http://100.116.92.12:9303/v1"
	modelId: string // "eurollm-22b"
	capabilities: WorkerCapability[]
	priority: number // higher = preferred for matching cap
	/**
	 * Maximum context window of this worker (input tokens + max generation).
	 * Used by LocalRouter.pickWorker() to skip undersized workers.
	 * If unknown, set Number.POSITIVE_INFINITY.
	 */
	ctxMax: number
	/**
	 * Whether this worker supports OpenAI-style native function calling
	 * (tools[] param + tool_calls in response). When false, LocalRouter
	 * emulates tools by injecting them into the system prompt and parsing
	 * <tool_call>{...}</tool_call> patterns from the streamed text.
	 */
	supportsTools: boolean
}

export type WorkerHealth = "up" | "down" | "unknown"

export interface ChatTool {
	type: "function"
	function: {
		name: string
		description?: string
		parameters: object
	}
}

export interface ChatRequest {
	messages: Array<{ role: string; content: string }>
	model?: string
	max_tokens?: number
	temperature?: number
	stream?: boolean
	tools?: ChatTool[]
	/**
	 * Optional caller-supplied AbortSignal. When aborted, LocalRouter cancels
	 * the underlying fetch + SSE reader. Composed with internal timeout
	 * signals; caller-driven aborts surface as AbortError, timeout-driven
	 * aborts surface as LocalRouterTimeoutError.
	 */
	signal?: AbortSignal
	/**
	 * Total wall-clock timeout for the streaming response, in milliseconds.
	 * Overrides the LocalRouter default (60_000). When exceeded, the stream
	 * aborts with a LocalRouterTimeoutError{kind:"total"}.
	 */
	timeoutMs?: number
	/**
	 * Idle (heartbeat) timeout — abort if no SSE chunk is received for this
	 * many milliseconds. Overrides the LocalRouter default (20_000). Surfaces
	 * as LocalRouterTimeoutError{kind:"idle"}.
	 */
	idleTimeoutMs?: number
}

export interface ChatResponse {
	// OpenAI-compat shape
	id: string
	choices: Array<{
		message: { role: string; content: string }
		finish_reason: string
	}>
	usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
}
