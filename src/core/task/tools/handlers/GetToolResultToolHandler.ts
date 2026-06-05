import type { ToolUse } from "@core/assistant-message"
import { formatResponse } from "@core/prompts/responses"
import { IsaacDefaultTool } from "@/shared/tools"
import type { PendingToolEntry } from "../../PendingToolRegistry"
import type { ToolResponse } from "../../index"
import type { IFullyManagedTool } from "../ToolExecutorCoordinator"
import type { TaskConfig } from "../types/TaskConfig"
import type { StronglyTypedUIHelpers } from "../types/UIHelpers"

/**
 * Sprint 2 — task F.
 *
 * Lookup tool that lets the model retrieve the result of an asynchronous tool
 * invocation previously launched by `execute_command`, `search_files` or
 * `list_files` (recursive). Those tools may return a placeholder of the form
 *
 *   task_id: <ULID>
 *   status: running
 *
 * when their fast path expires. The model then calls `get_tool_result` with
 * that task_id to fetch the actual result.
 *
 * The handler itself stays synchronous — it never registers a new pending
 * entry. It either returns immediately (status=running with wait=false, or a
 * terminal status), or waits on a single `"updated"` event from the registry
 * with a hard timeout.
 */

const DEFAULT_TIMEOUT_MS = 60_000
const MAX_TIMEOUT_MS = 300_000

const formatElapsed = (entry: PendingToolEntry): number => Date.now() - entry.startedAt

const stringifyResult = (result: unknown): string => {
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

export class GetToolResultToolHandler implements IFullyManagedTool {
	readonly name = IsaacDefaultTool.GET_TOOL_RESULT

	getDescription(block: ToolUse): string {
		const taskId = (block.params.task_id as string) || ""
		return `[${block.name} for task_id '${taskId}']`
	}

	async handlePartialBlock(block: ToolUse, uiHelpers: StronglyTypedUIHelpers): Promise<void> {
		// Lightweight UI surface: this tool is metadata-only, so we render a
		// generic tool message that gets auto-approved like other read-only
		// queries.
		const config = uiHelpers.getConfig()
		if (config.isSubagentExecution) {
			return
		}

		const taskId = (block.params.task_id as string) || ""
		const message = JSON.stringify({
			tool: "getToolResult",
			content: `Retrieving result for task_id ${taskId}…`,
		})

		await uiHelpers.removeLastPartialMessageIfExistsWithType("ask", "tool")
		await uiHelpers.say("tool", message, undefined, undefined, block.partial)
	}

	async execute(config: TaskConfig, block: ToolUse): Promise<ToolResponse> {
		const taskIdRaw = block.params.task_id
		const taskId = typeof taskIdRaw === "string" ? taskIdRaw.trim() : ""
		if (!taskId) {
			config.taskState.consecutiveMistakeCount++
			return formatResponse.toolError("Missing required parameter 'task_id' for get_tool_result.")
		}

		// Parse optional params (booleans/numbers may arrive as strings).
		const waitRaw = block.params.wait
		const wait = waitRaw === undefined || waitRaw === null || waitRaw === "" ? true : String(waitRaw).toLowerCase() !== "false"

		const timeoutRaw = block.params.timeout_ms
		let timeoutMs = DEFAULT_TIMEOUT_MS
		if (timeoutRaw !== undefined && timeoutRaw !== null && timeoutRaw !== "") {
			const parsed = Number(timeoutRaw)
			if (Number.isFinite(parsed) && parsed > 0) {
				timeoutMs = parsed
			}
		}
		if (timeoutMs > MAX_TIMEOUT_MS) {
			timeoutMs = MAX_TIMEOUT_MS
		}

		const registry = config.taskState?.pendingTools
		if (!registry) {
			return formatResponse.toolError("Pending tool registry is not available on this task.")
		}

		const entry = registry.get(taskId)
		if (!entry) {
			config.taskState.consecutiveMistakeCount++
			return formatResponse.toolError(
				`task_id not found: ${taskId}. It may have been pruned or never existed. ` +
					`Only tasks launched by execute_command / search_files / list_files (recursive) are tracked.`,
			)
		}

		// Reset mistake count for a successful lookup.
		config.taskState.consecutiveMistakeCount = 0

		// Drop stale terminal entries so long autonomous sessions don't leak.
		registry.prune()

		// Terminal states return immediately.
		if (entry.status === "completed") {
			return this.formatCompleted(entry)
		}
		if (entry.status === "failed") {
			return formatResponse.toolError(
				`Async tool '${entry.toolName}' (task_id ${entry.taskId}) failed:\n${entry.error ?? "(no error message)"}`,
			)
		}
		if (entry.status === "cancelled") {
			return (
				`Async tool '${entry.toolName}' (task_id ${entry.taskId}) was cancelled before completion.\n` +
				`elapsed_ms: ${formatElapsed(entry)}`
			)
		}

		// status === "running"
		if (!wait) {
			return this.formatRunning(entry)
		}

		// Wait for transition or timeout.
		const settled = await new Promise<PendingToolEntry | "timeout">((resolve) => {
			let timer: NodeJS.Timeout | undefined
			const onUpdate = (updated: PendingToolEntry) => {
				if (updated.taskId !== taskId) {
					return
				}
				if (updated.status === "running") {
					return
				}
				cleanup()
				resolve(updated)
			}
			const cleanup = () => {
				if (timer) {
					clearTimeout(timer)
					timer = undefined
				}
				registry.events.off("updated", onUpdate)
			}
			timer = setTimeout(() => {
				cleanup()
				resolve("timeout")
			}, timeoutMs)
			registry.events.on("updated", onUpdate)

			// Race-guard: re-read after subscribing in case we just missed the
			// terminal transition.
			const current = registry.get(taskId)
			if (current && current.status !== "running") {
				cleanup()
				resolve(current)
			}
		})

		if (settled === "timeout") {
			const fresh = registry.get(taskId) ?? entry
			return (
				`Async tool '${fresh.toolName}' (task_id ${fresh.taskId}) is still running after ${timeoutMs}ms.\n` +
				`status: running\n` +
				`elapsed_ms: ${formatElapsed(fresh)}\n` +
				`message: still running, retry get_tool_result later (optionally with a larger timeout_ms).`
			)
		}

		if (settled.status === "completed") {
			return this.formatCompleted(settled)
		}
		if (settled.status === "failed") {
			return formatResponse.toolError(
				`Async tool '${settled.toolName}' (task_id ${settled.taskId}) failed:\n${settled.error ?? "(no error message)"}`,
			)
		}
		// cancelled
		return (
			`Async tool '${settled.toolName}' (task_id ${settled.taskId}) was cancelled before completion.\n` +
			`elapsed_ms: ${formatElapsed(settled)}`
		)
	}

	private formatRunning(entry: PendingToolEntry): string {
		return (
			`Async tool '${entry.toolName}' (task_id ${entry.taskId}) is still running.\n` +
			`status: running\n` +
			`started_at: ${new Date(entry.startedAt).toISOString()}\n` +
			`elapsed_ms: ${formatElapsed(entry)}\n` +
			`message: call get_tool_result again later (default wait=true blocks up to 60s).`
		)
	}

	private formatCompleted(entry: PendingToolEntry): string {
		const body = stringifyResult(entry.result)
		const header =
			`Async tool '${entry.toolName}' (task_id ${entry.taskId}) completed in ` +
			`${entry.finishedAt && entry.startedAt ? entry.finishedAt - entry.startedAt : formatElapsed(entry)}ms.`
		if (!body) {
			return `${header}\n(result was empty)`
		}
		return `${header}\n${body}`
	}
}
