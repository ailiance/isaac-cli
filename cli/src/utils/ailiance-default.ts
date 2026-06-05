// ailiance-agent fork: ailiance default fallback
//
// When no provider is configured (no API key env vars, no persisted
// auth state), default to the ailiance gateway via the OpenAI-compatible
// code path. The user can override by setting AILIANCE_GATEWAY=<url>
// (AGENT_KIKI_GATEWAY remains supported as deprecated alias) or by
// configuring any of the standard upstream provider env vars.
//
// Behaviour matrix:
//   - AILIANCE_GATEWAY=<url> set      -> session override with that url
//   - AGENT_KIKI_GATEWAY=<url> set    -> session override (deprecated)
//   - upstream provider env present   -> skip (env-config wins)
//   - persisted welcomeViewCompleted  -> skip (user already onboarded)
//   - otherwise                       -> persist ailiance defaults so
//                                        first-run + later runs both work

import type { StateManager } from "@/core/storage/StateManager"

// Public gateway endpoint. Cloudflare Tunnel
// (2c6b04a3-9cac-4336-9dbd-9f1d432b08d8) routes
// https://gateway.ailiance.fr to the FastAPI :9300 on electron-server.
// Auto-terminated TLS (CF Flexible SSL), no auth — the gateway accepts
// any bearer string (AILIANCE_DEFAULT_API_KEY sentinel below). Reachable
// from anywhere without Tailscale; on-tailnet users can override to the
// LAN endpoint via AILIANCE_GATEWAY=http://electron-server:9300/v1 for
// lower latency / no CF dependency.
//
// The /v1 suffix is REQUIRED: the OpenAI-compatible SDK appends
// /chat/completions to the configured baseUrl, and the gateway only
// matches the OpenAI route prefix /v1/*. Without it, every request
// 404s. resolveAilianceGatewayUrl normalises trailing slashes and the
// /chat/completions suffix when present in the override URL.
export const AILIANCE_DEFAULT_GATEWAY = "https://gateway.ailiance.fr/v1"
export const AILIANCE_DEFAULT_MODEL = "ailiance"

/**
 * Sentinel value, never a real credential. The ailiance gateway does not
 * validate API keys — it is an internal LiteLLM proxy on the trusted
 * network. This string is required only because the openai-compatible
 * provider code path expects a non-empty key field; passing "" would
 * cause the SDK client to refuse to construct.
 *
 * Important: any code that passes a key to setSecret("openAiApiKey", ...)
 * for the ailiance default MUST reference this constant by name rather
 * than re-inlining the literal "unused", so a future rename / rotation
 * cannot leave a stray copy behind. No telemetry path logs this value.
 */
export const AILIANCE_DEFAULT_API_KEY = "unused"

export type AilianceDefaultReason =
	| "env-provider-already-set"
	| "auth-already-configured"
	| "applied-from-env"
	| "applied-fallback"
	| "migrated-stale-default"

/**
 * Returns true when a previously-persisted baseUrl is a known-broken
 * or superseded ailiance default that this CLI version must heal.
 * Covers the historical leak points and the v0.6.0 Tailscale-internal
 * defaults that v0.6.1 promotes to the public Cloudflare endpoint:
 *
 *   - http://studio:9300* — wrong host (gateway is on electron-server)
 *   - http://studio:9303* / direct worker ports — bypassed gateway
 *   - http://electron-server:9300* — v0.6.0 Tailscale-internal default
 *   - http://electron-server.tail*.ts.net:9300* — same, FQDN form
 *   - http://100.78.191.52:9300* — same, raw Tailscale IP
 *
 * Conservative: only matches the exact patterns shipped by prior
 * defaults, never a user-supplied custom URL (an operator pointing at
 * https://my-proxy/v1 or http://10.x.x.x:9300 stays untouched).
 */
export function needsStaleDefaultMigration(url: string): boolean {
	const trimmed = url.replace(/\/+$/, "")
	const noV1 = trimmed.replace(/\/v1$/, "")
	if (noV1 === "http://studio:9300") return true
	if (noV1.startsWith("http://studio:930")) return true // 9301..9309 direct workers
	if (noV1 === "http://electron-server:9300") return true
	if (/^http:\/\/electron-server\.tail[a-z0-9]+\.ts\.net:9300$/.test(noV1)) return true
	if (noV1 === "http://100.78.191.52:9300") return true
	return false
}

export interface AilianceDefaultDecision {
	applied: boolean
	reason: AilianceDefaultReason
	gatewayUrl?: string
}

/**
 * Derive the ailiance gateway URL from env (AILIANCE_GATEWAY, or the
 * deprecated AGENT_KIKI_GATEWAY alias) or the built-in default.
 * Trailing slashes and `/chat/completions` suffix are stripped to
 * mirror provider-config normalisation.
 */
export function resolveAilianceGatewayUrl(env: NodeJS.ProcessEnv = process.env): string {
	const raw = (env.AILIANCE_GATEWAY || env.AGENT_KIKI_GATEWAY || AILIANCE_DEFAULT_GATEWAY).trim()
	let url = raw.replace(/\/chat\/completions\/?$/, "")
	url = url.replace(/\/+$/, "")
	return url
}

/**
 * Returns true when at least one upstream provider env var is present.
 * AILIANCE_GATEWAY / AGENT_KIKI_GATEWAY are intentionally excluded —
 * they are our opt-in, not competing providers.
 */
export function hasNonAilianceProviderEnv(env: NodeJS.ProcessEnv = process.env): boolean {
	const sentinels = [
		"ANTHROPIC_API_KEY",
		"OPENAI_API_KEY",
		"OPENROUTER_API_KEY",
		"GEMINI_API_KEY",
		"GROQ_API_KEY",
		"XAI_API_KEY",
		"MISTRAL_API_KEY",
		"MOONSHOT_API_KEY",
		"HF_TOKEN",
		"ZAI_API_KEY",
		"MINIMAX_API_KEY",
		"MINIMAX_CN_API_KEY",
		"CEREBRAS_API_KEY",
		"AI_GATEWAY_API_KEY",
		"OPENCODE_API_KEY",
		"KIMI_API_KEY",
		"DEEPSEEK_API_KEY",
		"QWEN_API_KEY",
		"TOGETHER_API_KEY",
		"FIREWORKS_API_KEY",
		"NEBIUS_API_KEY",
		"OPENAI_COMPATIBLE_CUSTOM_KEY",
		"OPENAI_API_BASE",
		"AWS_ACCESS_KEY_ID",
		"AWS_BEDROCK_MODEL",
		"GOOGLE_CLOUD_PROJECT",
		"GCP_PROJECT",
	]
	return sentinels.some((key) => !!env[key])
}

interface ApplyOptions {
	env?: NodeJS.ProcessEnv
}

/**
 * Apply the ailiance defaults to the StateManager.
 * Returns a decision object so callers can log what happened.
 *
 * Precedence:
 *   1. Any non-kiki upstream provider env var -> skip.
 *   2. AGENT_KIKI_GATEWAY env var present     -> session override
 *      (does NOT persist; respects per-run overrides).
 *   3. welcomeViewCompleted=true && persisted provider already set -> skip.
 *   4. Otherwise -> persist ailiance defaults + mark welcomeViewCompleted.
 */
export function applyAilianceDefault(
	stateManager: StateManager,
	options: ApplyOptions = {},
): AilianceDefaultDecision {
	const env = options.env ?? process.env

	if (hasNonAilianceProviderEnv(env)) {
		return { applied: false, reason: "env-provider-already-set" }
	}

	const gatewayUrl = resolveAilianceGatewayUrl(env)
	const explicitOverride = !!(env.AILIANCE_GATEWAY || env.AGENT_KIKI_GATEWAY)

	if (explicitOverride) {
		// In-memory override only; do not pollute persisted config so the
		// user can rotate AILIANCE_GATEWAY freely between runs.
		stateManager.setSessionOverride("actModeApiProvider", "openai")
		stateManager.setSessionOverride("planModeApiProvider", "openai")
		stateManager.setSessionOverride("actModeOpenAiModelId", AILIANCE_DEFAULT_MODEL)
		stateManager.setSessionOverride("planModeOpenAiModelId", AILIANCE_DEFAULT_MODEL)
		stateManager.setSessionOverride("openAiBaseUrl", gatewayUrl)
		// Secrets cannot be session-overridden; mirror them in cache via
		// setSecret so the API handler can build a client. We only do this
		// if the cache slot is empty so we never clobber a real key.
		const cachedKey = stateManager.getSecretKey("openAiApiKey")
		if (!cachedKey) {
			stateManager.setSecret("openAiApiKey", AILIANCE_DEFAULT_API_KEY)
		}
		const cachedCompatKey = stateManager.getSecretKey("openAiCompatibleCustomApiKey")
		if (!cachedCompatKey) {
			stateManager.setSecret("openAiCompatibleCustomApiKey", AILIANCE_DEFAULT_API_KEY)
		}
		return { applied: true, reason: "applied-from-env", gatewayUrl }
	}

	const welcomeViewCompleted = stateManager.getGlobalStateKey("welcomeViewCompleted")
	const existingProvider = stateManager.getGlobalSettingsKey("actModeApiProvider")
	if (welcomeViewCompleted === true && existingProvider) {
		// Stale-default migration: prior CLI versions persisted broken
		// baseUrls (http://studio:9300, http://electron-server:9300
		// without /v1 — gateway only matches /v1/* and 404s otherwise).
		// Detect those and silently fix without forcing a re-onboard.
		const persisted = stateManager.getGlobalSettingsKey("openAiBaseUrl") as string | undefined
		if (persisted && needsStaleDefaultMigration(persisted)) {
			stateManager.setGlobalState("openAiBaseUrl", gatewayUrl)
			return { applied: true, reason: "migrated-stale-default", gatewayUrl }
		}
		// v0.8.2 retrofit: enable useAutoCondense for already-onboarded
		// users whose persisted setting is still the upstream Isaac
		// default (undefined/false). The intelligent summary-at-75% beats
		// the truncate-at-80% path decisively on long tasks; this opt-in-
		// on-upgrade keeps existing user state intact while still
		// delivering the improvement without forcing a config tour.
		const persistedAutoCondense = stateManager.getGlobalSettingsKey("useAutoCondense")
		if (persistedAutoCondense === undefined || persistedAutoCondense === false) {
			stateManager.setGlobalState("useAutoCondense", true)
		}
		return { applied: false, reason: "auth-already-configured" }
	}

	// First-run fallback: persist so subsequent invocations still work.
	stateManager.setGlobalState("actModeApiProvider", "openai")
	stateManager.setGlobalState("planModeApiProvider", "openai")
	stateManager.setGlobalState("actModeOpenAiModelId", AILIANCE_DEFAULT_MODEL)
	stateManager.setGlobalState("planModeOpenAiModelId", AILIANCE_DEFAULT_MODEL)
	stateManager.setGlobalState("openAiBaseUrl", gatewayUrl)
	stateManager.setSecret("openAiApiKey", AILIANCE_DEFAULT_API_KEY)
	stateManager.setSecret("openAiCompatibleCustomApiKey", AILIANCE_DEFAULT_API_KEY)
	// useAutoCondense ON by default. Upstream Isaac ships this as `false`
	// which means the agent only truncates conversation history at 80% of
	// the context window (maxAllowedSize), then brute-forces a half/quarter
	// removal of intermediate turns. The auto-condense path instead invokes
	// the `summarize_task` tool at a 75% threshold, producing a structured
	// summary of work-so-far that preserves the agent's intent and the
	// files-touched ledger. For long tasks (Mistral-Medium 128B, Qwen-80B,
	// auto-router chains) on the ailiance gateway, the intelligent summary
	// is decisively better than the truncate-and-pray path. Set
	// `useAutoCondense=false` in the TUI settings to revert.
	stateManager.setGlobalState("useAutoCondense", true)
	stateManager.setGlobalState("welcomeViewCompleted", true)

	return { applied: true, reason: "applied-fallback", gatewayUrl }
}
