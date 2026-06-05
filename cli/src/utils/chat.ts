import type { IsaacAsk } from "@shared/ExtensionMessage"
import { jsonParseSafe } from "./parser"

/**
 * Yolo mode auto-approves tool use, commands, browser actions, etc. so the AI can work
 * uninterrupted. But some ask types genuinely need user input -- you can't auto-approve
 * "task completed, what next?" or a followup question the AI is asking the user.
 *
 * This whitelist defines which ask types should still show buttons and allow text input
 * even when yolo mode is enabled. Everything NOT in this set gets suppressed (buttons
 * hidden, input blocked), which is the correct behavior for tool/browser approvals
 * since core auto-approves those before they even reach the UI.
 */
export const YOLO_INTERACTIVE_ASKS = new Set<IsaacAsk>([
	"completion_result",
	// In yolo mode, ExecuteCommandToolHandler auto-approves commands via say() (not ask()) at line 176,
	// so command asks never reach the UI for regular tool use. The only command ask that reaches the UI
	// is from AttemptCompletionHandler (line 135), which uses askApprovalAndPushFeedback("command", ...)
	// to let the user choose whether to run the suggested verification command after task completion.
	"command",
	"followup",
	"plan_mode_respond",
	"resume_task",
	"resume_completed_task",
	"new_task",
])

export function isYoloSuppressed(yolo: boolean, ask: IsaacAsk | undefined): boolean {
	return yolo && (!ask || !YOLO_INTERACTIVE_ASKS.has(ask))
}

/**
 * Get the type of prompt needed for an ask message
 */
export function getAskPromptType(ask: IsaacAsk, text: string): "confirmation" | "text" | "options" | "none" {
	switch (ask) {
		case "followup":
		case "plan_mode_respond": {
			const parts = jsonParseSafe(text, { options: undefined as string[] | undefined })
			if (parts.options && parts.options.length > 0) {
				return "options"
			}
			return "text"
		}
		case "completion_result":
			return "text"
		case "resume_task":
		case "resume_completed_task":
		case "command":
		case "tool":
		case "browser_action_launch":
		case "api_req_failed":
			return "confirmation"
		default:
			return "none"
	}
}

/**
 * Parse options from an ask message
 */
export function parseAskOptions(text: string): string[] {
	const parts = jsonParseSafe(text, { options: [] as string[] })
	return parts.options || []
}

/**
 * Expand pasted text placeholders back to actual content
 * Replaces [Pasted text #N +X lines] with the stored content
 */
export function expandPastedTexts(text: string, pastedTexts: Map<number, string>): string {
	return text.replace(/\[Pasted text #(\d+) \+\d+ lines\]/g, (match, num) => {
		const content = pastedTexts.get(Number.parseInt(num, 10))
		return content ?? match
	})
}

export function getInputStorageKey(controller: any, taskId?: string): string {
	// Use taskId if available, otherwise fall back to controller instance
	return taskId || (controller?.task?.taskId ?? "default")
}
