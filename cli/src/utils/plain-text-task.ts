/**
 * Plain-text task runner for non-TTY environments (piped output, file redirection)
 * Optimized for CI/CD and piping - only outputs the final completion result to stdout.
 *
 * Design goals:
 * - stdout: Only the final completion result text (no prefix) - perfect for piping
 * - stderr: Errors and verbose output (won't break pipes)
 * - Enables workflows like: git diff | dirac 'explain' | dirac 'summarize'
 */

/* eslint-disable no-console */
// Console output is intentional here for plain text mode

import type { DiracMessage, ExtensionState } from "@shared/ExtensionMessage"
import { StringRequest } from "@shared/proto/dirac/common"
import type { Controller } from "@/core/controller"
import { getRequestRegistry } from "@/core/controller/grpc-handler"
import { subscribeToState } from "@/core/controller/state/subscribeToState"
import { showTaskWithId } from "@/core/controller/task/showTaskWithId"
import { emitTaskStartedMessage } from "./task-start-output"
import { getApiMetrics } from "@shared/getApiMetrics"

export interface PlainTextTaskOptions {
	controller: Controller
	/** Prompt for new task or message to send to resumed task */
	prompt?: string
	imageDataUrls?: string[]
	verbose?: boolean
	jsonOutput?: boolean
	/** Timeout in seconds (only applied when explicitly provided) */
	timeoutSeconds?: number
	/** Task ID to resume an existing task */
	taskId?: string
	yolo?: boolean
}

/**
 * Run a task with plain text output (no Ink, no ANSI codes)
 * Returns true if task completed successfully, false if error
 *
 * Output behavior:
 * - Non-JSON mode: Only writes final completion_result text to stdout
 * - JSON mode: Streams JSON lines to stdout as messages arrive (unchanged)
 * - Verbose mode: Progress info goes to stderr
 * - Errors: Always go to stderr
 */
export async function runPlainTextTask(options: PlainTextTaskOptions): Promise<boolean> {
	const { controller, prompt, imageDataUrls, verbose, jsonOutput, yolo } = options

	let completionResolve: (reason?: any) => void
	let completionReject: (reason?: any) => void
	const completionPromise = new Promise<string>((res, rej) => {
		completionResolve = res
		completionReject = rej
	})

	let hasError = false
	let hasEmittedTaskStarted = false
	// Track which messages have been processed (by timestamp)
	const processedMessages = new Map<number, string>()
	const lastProcessedPartialMessages = new Map<number, DiracMessage>()

	const isViewTaskOnly = Boolean(options.taskId) && !prompt

	// When resuming a task, we need to ignore completion_result messages that existed
	// before we sent our new prompt. This timestamp marks the cutoff - only completion
	// results AFTER this time should trigger task completion.
	const completionCutoffTs = Date.now()

	const printPendingPartials = () => {
		for (const partialMsg of Array.from(lastProcessedPartialMessages.values()).sort(
			(a, b) => (a.ts || 0) - (b.ts || 0),
		)) {
			handleMessageForPipeMode(partialMsg, true, yolo || false)
		}
		lastProcessedPartialMessages.clear()
	}


	const emitTaskStarted = () => {
		if (hasEmittedTaskStarted) {
			return
		}

		const taskId = controller.task?.taskId
		if (!taskId) {
			return
		}

		emitTaskStartedMessage(taskId, Boolean(jsonOutput))
		hasEmittedTaskStarted = true
	}

	// Helper to process a message and track completion state
	const processMessage = (message: DiracMessage) => {
		const text = message.text || ""
		const ts = message.ts || 0

		if (message.partial) {
			// Special case: allow printing the initial api_req_started message even if it's partial
			// so the user knows the request has begun. Subsequent updates will be skipped until complete.
			if (message.say === "api_req_started" && !processedMessages.has(ts)) {
				handleMessageForPipeMode(message, verbose || false, yolo || false, false)
				processedMessages.set(ts, text)
				return
			}
			if (!jsonOutput && verbose) {
				lastProcessedPartialMessages.set(ts, message)
			}
			return
		}

		// Message is complete
		lastProcessedPartialMessages.delete(ts)

		if (processedMessages.has(ts) && processedMessages.get(ts) === text) {
			return
		}

		// JSON mode: stream all messages to stdout (existing behavior)
		if (jsonOutput) {
			process.stdout.write(JSON.stringify(message) + "\n")
		} else {
			handleMessageForPipeMode(message, verbose || false, yolo || false, processedMessages.has(ts))
		}

		processedMessages.set(ts, text)

		// Auto-approve if yolo mode is on and it's an approval request
		if (
			yolo &&
			message.type === "ask" &&
			(message.ask === "tool" ||
				message.ask === "command" ||
				message.ask === "browser_action_launch" ||
				message.ask === "plan_mode_respond" ||
				message.ask === "act_mode_respond" ||
				message.ask === "use_subagents" ||
				message.ask === "completion_result" ||
				message.ask === "new_task" ||
				message.ask === "condense" ||
				message.ask === "summarize_task" ||
				message.ask === "report_bug")
		) {
			controller.task?.handleWebviewAskResponse("yesButtonClicked")
		}

		// Check for completion (only on non-partial messages)
		// When resuming a task, only consider completion_result messages that appeared
		// AFTER we sent our resume message (ts > completionCutoffTs)
		if (message.say === "completion_result" || message.ask === "completion_result") {
			if (isViewTaskOnly || ts > completionCutoffTs) {
				completionResolve()
			}
		} else if (message.say === "error" || message.ask === "api_req_failed") {
			completionReject(message.text ?? "message.say error || message.ask api_req_failed")
		}
	}

	const requestId = "dirac-plain-text-task"
	subscribeToState(
		controller,
		{},
		async ({ stateJson }) => {
			try {
				const state = JSON.parse(stateJson) as ExtensionState
				for (const message of state.diracMessages ?? []) {
					processMessage(message)
				}
			} catch (error) {
				if (jsonOutput) {
					process.stdout.write(
						JSON.stringify({ type: "error", message: error instanceof Error ? error.message : String(error) }) +
							"\n",
					)
				} else {
					process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`)
				}
				completionReject(error)
			}
		},
		requestId,
	)

	try {
		// Either resume an existing task or start a new one
		if (options.taskId) {
			// Load the existing task
			await showTaskWithId(controller, StringRequest.create({ value: options.taskId }))
			emitTaskStarted()

			// If a prompt was provided, send it as a message to the resumed task
			if (prompt && controller.task) {
				// Wait a moment for the task to fully load
				await new Promise((resolve) => setTimeout(resolve, 100))

				// Send the prompt as a response to any pending ask, or as a new message
				await controller.task.handleWebviewAskResponse("messageResponse", prompt)
			}
		} else if (prompt) {
			// Start a new task with the prompt
			await controller.initTask(prompt, imageDataUrls)
			emitTaskStarted()
		} else {
			throw new Error("Either taskId or prompt must be provided")
		}

		// Wait for task completion, with optional timeout only when explicitly configured
		if (options.timeoutSeconds) {
			const timeoutMs = options.timeoutSeconds * 1000
			const timeoutPromise = new Promise((_, reject) =>
				setTimeout(() => reject(new Error("Timeout")), timeoutMs),
			)
			await Promise.race([completionPromise, timeoutPromise])
		} else {
			await completionPromise
		}
	} catch (error) {
		printPendingPartials()
		const errMsg = error instanceof Error ? error.message : String(error)
		if (jsonOutput) {
			process.stdout.write(JSON.stringify({ type: "error", message: errMsg }) + "\n")
		} else {
			process.stderr.write(`[${new Date().toLocaleTimeString("en-GB", { hour12: false })}] Error: ${errMsg}\n`)
		}
		hasError = true
	} finally {
		getRequestRegistry().cancelRequest(requestId)
	}

	// non json mode outputs only the final complete message
	// (it should be the completion_result message)
	if (!jsonOutput) {
		const msg = Array.from(processedMessages.entries())
			.sort(([aTs], [bTs]) => aTs - bTs)
			.map(([_, msg]) => msg)
			.at(-1)
		if (msg) {
			process.stdout.write(msg + "\n")
		}
	}

	// Print final summary if verbose or yolo
	if (!jsonOutput && (verbose || yolo)) {
		const messages = controller.task?.messageStateHandler.getDiracMessages() || []
		const metrics = getApiMetrics(messages)
		if (metrics.totalTokensIn > 0 || metrics.totalCost > 0) {
			process.stderr.write(`\n${"-".repeat(40)}\n`)
			process.stderr.write(`Task Summary:\n`)
			process.stderr.write(
				`Tokens: ${metrics.totalTokensIn.toLocaleString()} in, ${metrics.totalTokensOut.toLocaleString()} out${metrics.totalReasoningTokens ? ` (+${metrics.totalReasoningTokens.toLocaleString()} thinking)` : ""}\n`
			)
			if (metrics.totalCacheReads || metrics.totalCacheWrites) {
				process.stderr.write(
					`Cache: ${(metrics.totalCacheReads || 0).toLocaleString()} read, ${(metrics.totalCacheWrites || 0).toLocaleString()} write\n`,
				)
			}
			if (metrics.totalCost > 0) {
				process.stderr.write(`Total Cost: $${metrics.totalCost.toFixed(4)}\n`)
			}
			process.stderr.write(`${"-".repeat(40)}\n`)
		}
		// ISAAC: surface the last worker / domain / LoRA captured
		// from gateway X-Ailiance-* headers, so the user sees which backend
		// actually served the turn. Printed even when the metrics summary
		// is skipped (e.g. the agent errored before producing tokens) so
		// the user can still see which backend the failed request hit.
		// Falls back silently when talking to a non-ailiance gateway.
		try {
			const { formatWorkerInfo } = await import("@/utils/ailiance-worker-info")
			const line = formatWorkerInfo()
			if (line) {
				process.stderr.write(`${line}\n`)
			}
		} catch {
			// best-effort
		}
	}

	return !hasError
}

/**
 * Handle a message in pipe-optimized mode (non-JSON)
 * - Assistant response text (say: "text") is passed to the callback for buffering
 * - Errors go to stderr
 * - Verbose output goes to stderr
 * - Nothing else goes to stdout (stdout is reserved for final result only)
 */
function handleMessageForPipeMode(
	message: DiracMessage,
	verbose: boolean,
	yolo: boolean,
	isUpdate?: boolean,
): void {
	const timestamp = message.ts ? `[${new Date(message.ts).toLocaleTimeString("en-GB", { hour12: false })}] ` : ""
	const fullText = message.text ?? ""
	const reasoning = message.reasoning ?? ""
	const isPartial = message.partial ?? false
	const statusPrefix = verbose ? (isPartial ? "[partial]  " : (isUpdate ? "[update]   " : "[complete] ")) : ""

	// 1. Handle Errors (always stderr)
	if (message.say === "error" || message.ask === "api_req_failed") {
		process.stderr.write(`${timestamp}${statusPrefix}Error: ${fullText || "API request failed"}\n`)
		return
	}

	// Print reasoning if present (unless it's already the main content of a reasoning message)
	if (verbose && reasoning && message.say !== "reasoning") {
		process.stderr.write(`${timestamp}${statusPrefix}Reasoning: ${reasoning}\n`)
	}

	// 2. Handle Tool Calls (Triggering actions)
	const toolType = getToolType(message)
	if (toolType) {
		// Special handling for API requests to avoid raw JSON dump
		if (message.say === "api_req_started" || message.say === "api_req_finished" || message.say === "api_req_retried") {
			handleApiReqMessage(message, statusPrefix, isUpdate)
			return
		}

		let label = "Tool Call"
		let isTool = true

		if (message.type === "say") {
			switch (message.say) {
				case "task":
					label = "Task"
					isTool = false
					break
				case "text":
					label = "Assistant"
					isTool = false
					break
				case "reasoning":
					label = "Reasoning"
					isTool = false
					break
				case "subagent":
					label = "Subagent"
					isTool = false
					break
				case "subagent_usage":
					label = "Subagent Usage"
					isTool = false
					break
				case "checkpoint_created":
					label = "Checkpoint"
					isTool = false
					break
			}
		} else if (message.type === "ask") {
			switch (message.ask) {
				case "followup":
					label = "Question"
					isTool = false
					break
				case "plan_mode_respond":
					label = "Plan"
					isTool = false
					break
				case "act_mode_respond":
					label = "Act"
					isTool = false
					break
				case "completion_result":
					label = "Completion"
					isTool = false
					break
			}
		}

		let extra = ""
		if (message.type === "ask") {
			if (yolo) {
				extra = " [yolo]"
			} else {
				extra = " [waiting for approval]"
			}
		}

		if (isTool) {
			process.stderr.write(`${timestamp}${statusPrefix}${label}${extra}: ${toolType}: ${fullText}\n`)
		} else {
			process.stderr.write(`${timestamp}${statusPrefix}${label}${extra}: ${fullText}\n`)
		}
		return
	}

	// 3. Handle Verbose Output

	if (verbose) {

		if (message.type === "say") {
			switch (message.say) {
				case "task":
				case "text":
					if (fullText) {
						process.stderr.write(`${timestamp}${statusPrefix}${fullText}\n`)
					}
					break
				case "api_req_started":
				case "api_req_finished":
					handleApiReqMessage(message, statusPrefix, isUpdate)
					break
				case "completion_result":
					process.stderr.write(`${timestamp}${statusPrefix}Completion Result: ${fullText}\n`)
					break
				case "reasoning":
					const content = fullText || reasoning
					if (content) {
						process.stderr.write(`${timestamp}${statusPrefix}Reasoning: ${content}\n`)
					}
					break
				case "command":
					process.stderr.write(`${timestamp}${statusPrefix}Command: ${fullText}\n`)
					break
				case "command_output":
					process.stderr.write(`${timestamp}${statusPrefix}Command Output: ${fullText}\n`)
					break
				default:
					if (fullText) {
						process.stderr.write(`${timestamp}${statusPrefix}${message.say}: ${fullText}\n`)
					} else {
						process.stderr.write(`${timestamp}${statusPrefix}Event: ${message.say}\n`)
					}
			}
		} else if (message.type === "ask") {
			switch (message.ask) {
				case "completion_result":
					process.stderr.write(`${timestamp}${statusPrefix}Task completed\n`)
					break
				default:
					if (fullText) {
						process.stderr.write(`${timestamp}${statusPrefix}Question: ${fullText}\n`)
					} else {
						process.stderr.write(`${timestamp}${statusPrefix}Question Type: ${message.ask}\n`)
					}
			}
		}
	}
}

/**
 * Identify if a message is a tool call and return its type/name
 */
function getToolType(message: DiracMessage): string | null {
	if (message.type === "say") {
		const toolSays = [
			"tool",
			"command",
			"browser_action",
			"browser_action_launch",
			"use_subagents",
			"generate_explanation",
			"task",
			"text",
			"reasoning",
			"api_req_started",
			"api_req_finished",
			"api_req_retried",
			"subagent",
			"subagent_usage",
			"checkpoint_created",
		]
		if (message.say && toolSays.includes(message.say as any)) {
			if (message.say === "tool" && message.text) {
				try {
					const parsed = JSON.parse(message.text)
					return parsed.tool || "tool"
				} catch {
					return "tool"
				}
			}
			return message.say
		}
	}
	if (message.type === "ask") {
		const toolAsks = [
			"tool",
			"command",
			"browser_action_launch",
			"plan_mode_respond",
			"act_mode_respond",
			"use_subagents",
			"completion_result",
			"followup",
			"new_task",
			"condense",
			"summarize_task",
			"report_bug",
			"api_req_failed",
			"resume_task",
		]
		if (message.ask && toolAsks.includes(message.ask as any)) {
			if (message.ask === "tool" && message.text) {
				try {
					const parsed = JSON.parse(message.text)
					return parsed.tool || "tool"
				} catch {
					return "tool"
				}
			}
			return message.ask
		}
	}
	return message.say || message.ask || "unknown"
}

/**
 * Handle formatting and printing of API request messages
 */
function handleApiReqMessage(message: DiracMessage, statusPrefix: string, isUpdate?: boolean): void {
	const timestamp = message.ts ? `[${new Date(message.ts).toLocaleTimeString("en-GB", { hour12: false })}] ` : ""
	const fullText = message.text ?? ""
	let info: any = {}
	try {
		info = JSON.parse(fullText || "{}")
	} catch (e) {}

	const hasMetrics = info.cost !== undefined || info.tokensIn !== undefined

	let label = "API request"
	if (message.say === "api_req_started") {
		label = hasMetrics ? "API request finished" : "API request started"
	} else if (message.say === "api_req_finished") {
		label = "API request finished"
	} else if (message.say === "api_req_retried") {
		label = "API request retried"
	}

	if (hasMetrics || !isUpdate || info.retryStatus) {
		const costStr = info.cost !== undefined ? `Cost: $${info.cost.toFixed(4)}` : ""
		const tokensStr =
			info.tokensIn !== undefined
				? `Tokens: ${info.tokensIn.toLocaleString()} in, ${info.tokensOut.toLocaleString()} out${
						info.reasoningTokens ? ` (+${info.reasoningTokens.toLocaleString()} thinking)` : ""
					}`
				: ""
		const cacheStr =
			info.cacheReads !== undefined || info.cacheWrites !== undefined
				? ` (Cache: ${(info.cacheReads || 0).toLocaleString()} read, ${(info.cacheWrites || 0).toLocaleString()} write)`
				: ""
		const contextStr =
			info.contextWindow !== undefined
				? ` | Context: ${info.contextUsagePercentage}% of ${(info.contextWindow / 1000).toFixed(0)}K`
				: ""

		const retryStr = info.retryStatus
			? ` (Retry ${info.retryStatus.attempt}/${info.retryStatus.maxAttempts}${info.retryStatus.delaySec ? ` in ${info.retryStatus.delaySec}s` : ""}${info.retryStatus.errorSnippet ? `: ${info.retryStatus.errorSnippet}` : ""})`
			: ""

		const metricsStr = hasMetrics || retryStr ? ` [${tokensStr}${cacheStr}${contextStr}${retryStr} | ${costStr}]` : ""
		process.stderr.write(`${timestamp}${statusPrefix}${label}${metricsStr}\n`)
	}
}
