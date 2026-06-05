import { describe, expect, it } from "vitest"
import {
	AILIANCE_DEFAULT_API_KEY,
	AILIANCE_DEFAULT_GATEWAY,
	AILIANCE_DEFAULT_MODEL,
	applyAilianceDefault,
	hasNonAilianceProviderEnv,
	needsStaleDefaultMigration,
	resolveAilianceGatewayUrl,
} from "../ailiance-default"

/**
 * Lightweight in-memory StateManager double matching the methods used by
 * applyAilianceDefault. Avoids spinning up the full StateManager (filesystem,
 * VS Code shim, etc.) for a unit-level test of the decision logic.
 */
function makeFakeStateManager() {
	const settings: Record<string, unknown> = {}
	const globalState: Record<string, unknown> = {}
	const secrets: Record<string, unknown> = {}
	const sessionOverrides: Record<string, unknown> = {}
	return {
		settings,
		globalState,
		secrets,
		sessionOverrides,
		setSessionOverride(key: string, value: unknown) {
			sessionOverrides[key] = value
		},
		setGlobalState(key: string, value: unknown) {
			globalState[key] = value
		},
		setSecret(key: string, value: unknown) {
			secrets[key] = value
		},
		getGlobalSettingsKey(key: string) {
			return sessionOverrides[key] ?? settings[key] ?? globalState[key]
		},
		getGlobalStateKey(key: string) {
			return globalState[key]
		},
		getSecretKey(key: string) {
			return secrets[key]
		},
	}
}

describe("ailiance default fallback", () => {
	it("resolveAilianceGatewayUrl falls back to public gateway.ailiance.fr/v1", () => {
		expect(resolveAilianceGatewayUrl({})).toBe(AILIANCE_DEFAULT_GATEWAY)
		expect(AILIANCE_DEFAULT_GATEWAY).toBe("https://gateway.ailiance.fr/v1")
	})

	it("resolveAilianceGatewayUrl honours AILIANCE_GATEWAY", () => {
		expect(resolveAilianceGatewayUrl({ AILIANCE_GATEWAY: "http://example.com:9999/" })).toBe(
			"http://example.com:9999",
		)
	})

	it("resolveAilianceGatewayUrl honours deprecated AGENT_KIKI_GATEWAY", () => {
		expect(resolveAilianceGatewayUrl({ AGENT_KIKI_GATEWAY: "http://legacy:9999/" })).toBe("http://legacy:9999")
	})

	it("AILIANCE_GATEWAY takes precedence over AGENT_KIKI_GATEWAY", () => {
		expect(
			resolveAilianceGatewayUrl({
				AILIANCE_GATEWAY: "http://new:9300",
				AGENT_KIKI_GATEWAY: "http://old:9300",
			}),
		).toBe("http://new:9300")
	})

	it("resolveAilianceGatewayUrl strips /chat/completions suffix", () => {
		expect(resolveAilianceGatewayUrl({ AILIANCE_GATEWAY: "http://x:9300/chat/completions/" })).toBe(
			"http://x:9300",
		)
	})

	it("hasNonAilianceProviderEnv detects a real provider env", () => {
		expect(hasNonAilianceProviderEnv({ ANTHROPIC_API_KEY: "k" })).toBe(true)
		expect(hasNonAilianceProviderEnv({ AILIANCE_GATEWAY: "http://foo" })).toBe(false)
		expect(hasNonAilianceProviderEnv({ AGENT_KIKI_GATEWAY: "http://foo" })).toBe(false)
		expect(hasNonAilianceProviderEnv({})).toBe(false)
	})

	it("applies persisted defaults when nothing is configured", () => {
		const sm = makeFakeStateManager()
		const decision = applyAilianceDefault(sm as any, { env: {} })
		expect(decision.applied).toBe(true)
		expect(decision.reason).toBe("applied-fallback")
		expect(decision.gatewayUrl).toBe(AILIANCE_DEFAULT_GATEWAY)
		expect(sm.globalState.actModeApiProvider).toBe("openai")
		expect(sm.globalState.planModeApiProvider).toBe("openai")
		expect(sm.globalState.actModeOpenAiModelId).toBe(AILIANCE_DEFAULT_MODEL)
		expect(sm.globalState.openAiBaseUrl).toBe(AILIANCE_DEFAULT_GATEWAY)
		expect(sm.secrets.openAiApiKey).toBe(AILIANCE_DEFAULT_API_KEY)
		expect(sm.globalState.welcomeViewCompleted).toBe(true)
	})

	it("uses session overrides (no persistence) when AGENT_KIKI_GATEWAY is set", () => {
		const sm = makeFakeStateManager()
		const decision = applyAilianceDefault(sm as any, { env: { AGENT_KIKI_GATEWAY: "http://other:9300" } })
		expect(decision.applied).toBe(true)
		expect(decision.reason).toBe("applied-from-env")
		expect(decision.gatewayUrl).toBe("http://other:9300")
		expect(sm.sessionOverrides.openAiBaseUrl).toBe("http://other:9300")
		expect(sm.sessionOverrides.actModeApiProvider).toBe("openai")
		// Persisted slot stays untouched.
		expect(sm.globalState.openAiBaseUrl).toBeUndefined()
		// Secret cache populated only because slot was empty.
		expect(sm.secrets.openAiApiKey).toBe(AILIANCE_DEFAULT_API_KEY)
	})

	it("does not clobber an existing real openAiApiKey when overriding via env", () => {
		const sm = makeFakeStateManager()
		sm.secrets.openAiApiKey = "real-key"
		applyAilianceDefault(sm as any, { env: { AGENT_KIKI_GATEWAY: "http://x:9300" } })
		expect(sm.secrets.openAiApiKey).toBe("real-key")
	})

	it("skips when an upstream provider env var is set", () => {
		const sm = makeFakeStateManager()
		const decision = applyAilianceDefault(sm as any, { env: { ANTHROPIC_API_KEY: "k" } })
		expect(decision.applied).toBe(false)
		expect(decision.reason).toBe("env-provider-already-set")
		expect(sm.globalState.actModeApiProvider).toBeUndefined()
	})

	it("setSecret receives AILIANCE_DEFAULT_API_KEY by reference (not a literal copy)", () => {
		// Guard against drift: any setSecret call for the ailiance default
		// must pass the exported constant, so a future rename or rotation
		// updates every call site uniformly. Strict reference equality
		// (Object.is) catches both string-literal copies and accidental
		// trimmed/reformatted variants.
		const sm = makeFakeStateManager()
		applyAilianceDefault(sm as any, { env: {} })
		expect(Object.is(sm.secrets.openAiApiKey, AILIANCE_DEFAULT_API_KEY)).toBe(true)
		expect(Object.is(sm.secrets.openAiCompatibleCustomApiKey, AILIANCE_DEFAULT_API_KEY)).toBe(true)

		const sm2 = makeFakeStateManager()
		applyAilianceDefault(sm2 as any, { env: { AGENT_KIKI_GATEWAY: "http://x:9300" } })
		expect(Object.is(sm2.secrets.openAiApiKey, AILIANCE_DEFAULT_API_KEY)).toBe(true)
		expect(Object.is(sm2.secrets.openAiCompatibleCustomApiKey, AILIANCE_DEFAULT_API_KEY)).toBe(true)
	})

	it("skips when the user has already onboarded", () => {
		const sm = makeFakeStateManager()
		sm.globalState.welcomeViewCompleted = true
		sm.globalState.actModeApiProvider = "anthropic"
		const decision = applyAilianceDefault(sm as any, { env: {} })
		expect(decision.applied).toBe(false)
		expect(decision.reason).toBe("auth-already-configured")
	})

	describe("stale default migration", () => {
		it("identifies known-broken historical defaults (pre-v0.6)", () => {
			expect(needsStaleDefaultMigration("http://studio:9300")).toBe(true)
			expect(needsStaleDefaultMigration("http://studio:9300/")).toBe(true)
			expect(needsStaleDefaultMigration("http://studio:9303/v1")).toBe(true)
		})

		it("identifies v0.6.0 Tailscale-internal defaults (now promoted to public)", () => {
			expect(needsStaleDefaultMigration("http://electron-server:9300")).toBe(true)
			expect(needsStaleDefaultMigration("http://electron-server:9300/v1")).toBe(true)
			expect(needsStaleDefaultMigration("http://electron-server.tail78ae15.ts.net:9300")).toBe(true)
			expect(needsStaleDefaultMigration("http://electron-server.tail78ae15.ts.net:9300/v1")).toBe(true)
			expect(needsStaleDefaultMigration("http://100.78.191.52:9300")).toBe(true)
			expect(needsStaleDefaultMigration("http://100.78.191.52:9300/v1")).toBe(true)
		})

		it("leaves correct public and user-supplied URLs alone", () => {
			expect(needsStaleDefaultMigration("https://gateway.ailiance.fr/v1")).toBe(false)
			expect(needsStaleDefaultMigration("https://gateway.ailiance.fr")).toBe(false)
			expect(needsStaleDefaultMigration("http://my-custom-proxy:8080/v1")).toBe(false)
			expect(needsStaleDefaultMigration("https://api.openai.com/v1")).toBe(false)
		})

		it("heals stale pre-v0.6 baseUrl even when user is onboarded", () => {
			const sm = makeFakeStateManager()
			sm.globalState.welcomeViewCompleted = true
			sm.globalState.actModeApiProvider = "openai"
			sm.globalState.openAiBaseUrl = "http://studio:9300"
			const decision = applyAilianceDefault(sm as any, { env: {} })
			expect(decision.applied).toBe(true)
			expect(decision.reason).toBe("migrated-stale-default")
			expect(sm.globalState.openAiBaseUrl).toBe(AILIANCE_DEFAULT_GATEWAY)
		})

		it("promotes v0.6.0 Tailscale default to public on upgrade", () => {
			const sm = makeFakeStateManager()
			sm.globalState.welcomeViewCompleted = true
			sm.globalState.actModeApiProvider = "openai"
			sm.globalState.openAiBaseUrl = "http://electron-server:9300/v1"
			const decision = applyAilianceDefault(sm as any, { env: {} })
			expect(decision.applied).toBe(true)
			expect(decision.reason).toBe("migrated-stale-default")
			expect(sm.globalState.openAiBaseUrl).toBe("https://gateway.ailiance.fr/v1")
		})
	})
})
