import { StateManager } from "@/core/storage/StateManager"

/**
 * Read LocalRouter SSE timeouts from user settings.
 *
 * Tolerates uninitialized StateManager (CLI bootstrap, unit tests) by
 * returning `undefined` for both fields — LocalRouter then applies its
 * built-in defaults (60s overall / 20s idle).
 *
 * Centralizes the try/catch pattern used by litellm/openai/openrouter
 * providers when delegating to `LocalRouter.chatStream(...)`.
 */
export function readLocalRouterTimeouts(): {
	timeoutMs?: number
	idleTimeoutMs?: number
} {
	try {
		const sm = StateManager.get()
		return {
			timeoutMs: sm.getGlobalSettingsKey("localRouterTimeoutMs"),
			idleTimeoutMs: sm.getGlobalSettingsKey("localRouterIdleTimeoutMs"),
		}
	} catch {
		// StateManager not initialized — defaults will apply downstream
		return {}
	}
}
