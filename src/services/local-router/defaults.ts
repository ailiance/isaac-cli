import type { WorkerEndpoint } from "./types"

/**
 * Default ailiance worker endpoints.
 * Users can override via setting `localRouterWorkers` (array of WorkerEndpoint).
 *
 * ctxMax reflects the runtime context window of each worker (mesured live).
 * Values that are too small for isaac's ~8k system prompt will be skipped by
 * LocalRouter.pickWorker() to avoid "context exceeded" errors.
 */
export const DEFAULT_WORKERS: WorkerEndpoint[] = [
	{
		// Default: the public ailiance gateway. It does its own sovereign routing
		// (domain classify → cascade → FC force-route → LoRA mascarade) and returns
		// native OpenAI tool_calls, so the client treats it as a single tool-capable
		// worker. For a direct local stack, override `localRouterWorkers` with the
		// real per-worker Tailscale endpoints.
		id: "ailiance-gateway",
		url: "https://gateway.ailiance.fr/v1",
		modelId: "ailiance-gateway",
		capabilities: ["general", "code", "reason", "fr"],
		priority: 10,
		ctxMax: 131072, // gateway force-routes to a large-context worker; real ctx surfaces via X-Ailiance-Context-Window
		supportsTools: true, // gateway returns native OpenAI tool_calls (FC force-route)
	},
]
