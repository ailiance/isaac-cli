// ailiance-agent: capture X-Ailiance-* response headers
//
// The gateway (see ailiance/ailiance PR #78) emits five response
// headers exposing the actual routing decision:
//
//   X-Ailiance-Worker-Port    the port the request landed on after
//                             cascade override + FC force-route +
//                             chain dispatch
//   X-Ailiance-Domain         classifier top-1 domain
//   X-Ailiance-Chain          policy engaged (direct / mixture /
//                             sequential / deliberate / validate)
//   X-Ailiance-Backend        upstream system_fingerprint
//   X-Ailiance-Upstream-Model the model_id the worker reports
//
// This module intercepts every fetch response for paths ending in
// `/chat/completions` and stores the latest set of headers in a
// session-local cache. UI layers can read the cache via
// getLastWorkerInfo() to display the actual worker that served the
// most recent turn — useful for debugging routing decisions and for
// showing the user which LoRA was applied (mascarade-kicad,
// devstral-python, etc. surface in X-Ailiance-Upstream-Model).
//
// Failure-tolerant by design: when the gateway is non-ailiance (an
// OpenAI proxy without our headers), getLastWorkerInfo() returns
// undefined and the UI falls back to showing the OpenAI body fields.

export interface WorkerInfo {
	workerPort?: string
	domain?: string
	chain?: string
	backend?: string
	upstreamModel?: string
	contextWindow?: number
	capturedAt: number
}

let lastWorkerInfo: WorkerInfo | undefined

/**
 * Get the most recent worker-info captured from a /chat/completions
 * response, or undefined if no ailiance response has been observed
 * in this process.
 */
export function getLastWorkerInfo(): WorkerInfo | undefined {
	return lastWorkerInfo
}

export function clearWorkerInfo(): void {
	lastWorkerInfo = undefined
}

/**
 * Internal: parse the X-Ailiance-* headers off a Response and
 * update the session cache if any of them are present. Idempotent;
 * called from the fetch interceptor for every response.
 */
function captureFromResponse(response: Response): void {
	const port = response.headers.get("x-ailiance-worker-port")
	const domain = response.headers.get("x-ailiance-domain")
	const chain = response.headers.get("x-ailiance-chain")
	const backend = response.headers.get("x-ailiance-backend")
	const upstream = response.headers.get("x-ailiance-upstream-model")
	const ctxRaw = response.headers.get("x-ailiance-context-window")
	// Skip when none of the headers are present (non-ailiance gateway).
	if (!port && !domain && !backend && !upstream && !chain && !ctxRaw) {
		return
	}
	let contextWindow: number | undefined
	if (ctxRaw) {
		const parsed = Number.parseInt(ctxRaw, 10)
		if (Number.isFinite(parsed) && parsed > 0) {
			contextWindow = parsed
		}
	}
	lastWorkerInfo = {
		workerPort: port ?? undefined,
		domain: domain ?? undefined,
		chain: chain ?? undefined,
		backend: backend ?? undefined,
		upstreamModel: upstream ?? undefined,
		contextWindow,
		capturedAt: Date.now(),
	}
}

/**
 * Wrap a fetch implementation so every response to a
 * `/chat/completions` path captures its X-Ailiance-* headers. The
 * wrapper is a pass-through for the body — it never reads the
 * response, only the headers, so streaming consumers are unaffected.
 */
export function wrapFetchForWorkerInfo(baseFetch: typeof globalThis.fetch): typeof globalThis.fetch {
	return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const response = await baseFetch(input, init)
		try {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
			if (url.includes("/chat/completions")) {
				captureFromResponse(response)
			}
		} catch {
			// Best-effort capture; never let a header parse error break
			// the request.
		}
		return response
	}
}

/**
 * Format the captured worker info as a one-line summary suitable for
 * an output channel or footer display. Returns null when no info has
 * been captured yet.
 */
export function formatWorkerInfo(info: WorkerInfo | undefined = lastWorkerInfo): string | null {
	if (!info) return null
	const parts: string[] = []
	if (info.upstreamModel) parts.push(`model=${info.upstreamModel}`)
	if (info.workerPort) parts.push(`port=${info.workerPort}`)
	if (info.domain) parts.push(`domain=${info.domain}`)
	if (info.chain) parts.push(`chain=${info.chain}`)
	if (info.contextWindow) {
		// Format as Xk for compact display (196608 -> "192k").
		const kilo = Math.round(info.contextWindow / 1024)
		parts.push(`ctx=${kilo}k`)
	}
	if (info.backend) parts.push(`backend=${info.backend}`)
	if (parts.length === 0) return null
	return `[ailiance ${parts.join(" · ")}]`
}
