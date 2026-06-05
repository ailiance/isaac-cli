import { IsaacSayTool } from "@shared/ExtensionMessage"
import { Logger } from "@shared/services/Logger"
import { PendingToolEntry, PendingToolRegistry } from "./PendingToolRegistry"
import { TaskMessenger } from "./TaskMessenger"

/**
 * Subset of {@link IsaacSayTool} fields a caller is expected to supply when
 * emitting an async-tool notification. The async-* fields are appended by
 * {@link notifyAsyncTool} itself, so callers should not set them.
 */
export type AsyncToolPayload = Omit<
	IsaacSayTool,
	"asyncTaskId" | "asyncStatus" | "asyncStartedAt" | "asyncFinishedAt" | "asyncDurationMs" | "asyncResult" | "asyncError"
>

export interface NotifyAsyncToolOptions {
	messenger: TaskMessenger
	registry: PendingToolRegistry
	entry: PendingToolEntry
	/** The tool block fields that exist regardless of async status (tool name, path, command, …). */
	initialPayload: AsyncToolPayload
	/**
	 * Extract a string representation of the result for UI display.
	 * Defaults to {@link defaultStringifyResult}.
	 */
	stringifyResult?: (result: unknown) => string
}

export interface AsyncToolNotificationHandle {
	/**
	 * Detach the registry listener early. Safe to call multiple times.
	 * Automatically invoked when the entry reaches a terminal state — callers only
	 * need to call this when they want to abandon the notification before
	 * the registry resolves (e.g. task teardown).
	 */
	dispose(): void
}

/** Coerces any tool result into a UI-friendly string. */
export function defaultStringifyResult(result: unknown): string {
	if (result === undefined || result === null) {
		return ""
	}
	if (typeof result === "string") {
		return result
	}
	try {
		return JSON.stringify(result)
	} catch {
		return String(result)
	}
}

/**
 * Push the initial "running" tool message and subscribe to the
 * {@link PendingToolRegistry} `"updated"` event so that — when the entry
 * transitions to a terminal state — a follow-up `say("tool", …)` is emitted
 * with the final result and `partial: false`.
 *
 * Caveat: TaskMessenger.say merges partials by `say` *type only*, not by
 * asyncTaskId. If two async tools of the same `say` type run concurrently,
 * the second initial-partial would overwrite the first. v0.6 Sprint 2-G
 * accepts this limitation; S2 work that runs more than one async tool in
 * parallel must serialize them or extend TaskMessenger to key on asyncTaskId.
 *
 * @returns a handle whose `dispose()` removes the listener early. The handle
 * also auto-disposes once the entry hits a terminal state.
 */
export async function notifyAsyncTool(opts: NotifyAsyncToolOptions): Promise<AsyncToolNotificationHandle> {
	const { messenger, registry, entry, initialPayload, stringifyResult = defaultStringifyResult } = opts

	// Step 1: emit the initial "running" partial say.
	const runningPayload: IsaacSayTool = {
		...initialPayload,
		asyncTaskId: entry.taskId,
		asyncStatus: "running",
		asyncStartedAt: entry.startedAt,
	}
	try {
		await messenger.say("tool", JSON.stringify(runningPayload), undefined, undefined, true)
	} catch (err) {
		Logger.error("[AsyncToolNotifier] Failed to emit running say (non-fatal):", err as Error)
	}

	// Step 2: listen for the terminal transition.
	let disposed = false

	const onUpdated = (updated: PendingToolEntry) => {
		if (updated.taskId !== entry.taskId) {
			return
		}
		if (updated.status === "running") {
			return
		}
		// Terminal state: emit the completion say + auto-dispose.
		const startedAt = updated.startedAt ?? entry.startedAt
		const finishedAt = updated.finishedAt ?? Date.now()
		const finalPayload: IsaacSayTool = {
			...initialPayload,
			asyncTaskId: updated.taskId,
			asyncStatus: updated.status,
			asyncStartedAt: startedAt,
			asyncFinishedAt: finishedAt,
			asyncDurationMs: Math.max(0, finishedAt - startedAt),
		}
		if (updated.status === "completed" && updated.result !== undefined) {
			finalPayload.asyncResult = stringifyResult(updated.result)
		}
		if (updated.status === "failed" && updated.error) {
			finalPayload.asyncError = updated.error
		}

		// Always cleanup the listener even if the say throws.
		dispose()

		void messenger.say("tool", JSON.stringify(finalPayload), undefined, undefined, false).catch((err: unknown) => {
			Logger.error("[AsyncToolNotifier] Failed to emit terminal say (non-fatal):", err as Error)
		})
	}

	const dispose = () => {
		if (disposed) {
			return
		}
		disposed = true
		registry.events.off("updated", onUpdated)
	}

	registry.events.on("updated", onUpdated)

	// In case the entry already terminated before we subscribed (race), fire
	// once synchronously based on its current status.
	if (entry.status !== "running") {
		onUpdated(entry)
	}

	return { dispose }
}
