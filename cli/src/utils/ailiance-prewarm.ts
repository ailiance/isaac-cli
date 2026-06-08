// ailiance-agent: boot-time gateway prewarm
//
// Goal: by the time the first user prompt is accepted, the CLI has
// already (1) resolved the configured gateway URL, (2) confirmed the
// gateway responds, (3) cached the available model list. This turns
// the silent "Retrying... (1/3) Connection error" failure mode at
// first-prompt into a loud, actionable error at boot, and avoids the
// extra round-trip cost on the first chat completion.

import type { StateManager } from "@/core/storage/StateManager"

export interface PrewarmResult {
	ok: boolean
	gatewayUrl: string
	modelCount?: number
	models?: string[]
	error?: string
	durationMs: number
}

export interface PrewarmCacheEntry {
	url: string
	fetchedAt: number
	models: string[]
}

const PREWARM_TIMEOUT_MS = 5000

// Module-local session cache. StateManager's setSessionOverride has a
// strict key union that does not accept arbitrary cache slots, so the
// cache lives here for the CLI process lifetime. Read it via
// getAilianceGatewayCache() from command handlers to avoid a second
// /v1/models round-trip on the first prompt.
let sessionModelsCache: PrewarmCacheEntry | undefined

export function getAilianceGatewayCache(): PrewarmCacheEntry | undefined {
	return sessionModelsCache
}

export function clearAilianceGatewayCache(): void {
	sessionModelsCache = undefined
}

/**
 * Probe the configured gateway and cache its model list.
 *
 * Reads the resolved baseUrl from StateManager (set earlier by
 * applyAilianceDefault) and issues a GET /v1/models with a tight
 * timeout. Result is stored in the StateManager session cache under
 * PREWARM_CACHE_KEY so command handlers can read the model list
 * without a second round-trip.
 *
 * Never throws — the CLI must boot even when the gateway is down, so
 * the caller can surface the failure and let the user override
 * AILIANCE_GATEWAY before retrying.
 */
export async function prewarmAilianceGateway(stateManager: StateManager): Promise<PrewarmResult> {
	const start = Date.now()
	// openAiBaseUrl lives in global settings (not state); read via the
	// settings accessor. Cast through unknown to dodge the strict literal
	// key union — `openAiBaseUrl` is a valid settings key at runtime.
	const rawBaseUrl =
		((stateManager.getGlobalSettingsKey as unknown as (k: string) => string | undefined)("openAiBaseUrl") as
			| string
			| undefined) ?? ""
	const baseUrl = rawBaseUrl.replace(/\/+$/, "")

	if (!baseUrl) {
		return {
			ok: false,
			gatewayUrl: "",
			error: "no baseUrl configured (applyAilianceDefault must run first)",
			durationMs: Date.now() - start,
		}
	}

	const modelsUrl = baseUrl.endsWith("/v1") ? `${baseUrl}/models` : `${baseUrl}/v1/models`
	const apiKey =
		((stateManager.getSecretKey as unknown as (k: string) => string | undefined)("openAiApiKey") as string | undefined) ??
		"unused"

	const controller = new AbortController()
	const timeout = setTimeout(() => controller.abort(), PREWARM_TIMEOUT_MS)

	try {
		const res = await fetch(modelsUrl, {
			method: "GET",
			headers: { Authorization: `Bearer ${apiKey}` },
			signal: controller.signal,
		})
		clearTimeout(timeout)
		if (!res.ok) {
			return {
				ok: false,
				gatewayUrl: baseUrl,
				error: `HTTP ${res.status} from ${modelsUrl}`,
				durationMs: Date.now() - start,
			}
		}
		const body = (await res.json()) as { data?: Array<{ id: string }> }
		const models = (body.data ?? []).map((m) => m.id)
		// Cache for the rest of the session — avoids a second /v1/models
		// call on the first prompt. Module-local; cleared on next process.
		sessionModelsCache = { url: baseUrl, fetchedAt: Date.now(), models }
		return {
			ok: true,
			gatewayUrl: baseUrl,
			modelCount: models.length,
			models,
			durationMs: Date.now() - start,
		}
	} catch (err) {
		clearTimeout(timeout)
		const msg = err instanceof Error ? err.message : String(err)
		return {
			ok: false,
			gatewayUrl: baseUrl,
			error: controller.signal.aborted ? `timeout after ${PREWARM_TIMEOUT_MS}ms` : msg,
			durationMs: Date.now() - start,
		}
	}
}

/**
 * Format a one-line summary suitable for the CLI output channel.
 * Includes override hint on failure.
 */
export function formatPrewarmLog(r: PrewarmResult): string {
	if (r.ok) {
		return `ailiance gateway ready: ${r.modelCount} models in ${r.durationMs}ms via ${r.gatewayUrl}`
	}
	return `ailiance gateway NOT ready (${r.error}) — first prompt will fail. Set AILIANCE_GATEWAY=<reachable-url> and retry.`
}
