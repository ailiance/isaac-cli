import type { ToolUse } from "@core/assistant-message"
import { formatResponse } from "@core/prompts/responses"
// ailiance-agent fork: hard-deny zone gate
import { classifyCommand, HARD_DENY_EXIT_CODE } from "@core/safety/zoneClassifier"
import { WorkspacePathAdapter } from "@core/workspace/WorkspacePathAdapter"
import { MultiCommandState } from "@shared/ExtensionMessage"
import { telemetryService } from "@/services/telemetry"
import { truncateHeadTail } from "@/shared/content-limits"
import { Logger } from "@/shared/services/Logger"
import { IsaacDefaultTool } from "@/shared/tools"
import { notifyAsyncTool } from "../../AsyncToolNotifier"
import type { ToolResponse } from "../../index"
import type { PendingToolEntry, PendingToolRegistry } from "../../PendingToolRegistry"
import type { TaskMessenger } from "../../TaskMessenger"
import { showNotificationForApproval } from "../../utils"
import type { IFullyManagedTool } from "../ToolExecutorCoordinator"
import type { ToolValidator } from "../ToolValidator"
import type { TaskConfig } from "../types/TaskConfig"
import type { StronglyTypedUIHelpers } from "../types/UIHelpers"
import { coerceToStringArray } from "../utils/coerceArray"
import { isSafeCommand } from "../utils/CommandSafetyChecker"
import { applyModelContentFixes } from "../utils/ModelContentProcessor"
import { ToolResultUtils } from "../utils/ToolResultUtils"

// Default timeout for commands in yolo mode and background exec mode
const DEFAULT_COMMAND_TIMEOUT_SECONDS = 30
const LONG_RUNNING_COMMAND_TIMEOUT_SECONDS = 300
const MAX_COMMAND_OUTPUT_SIZE = 10 * 1024 // 10KB limit to avoid context flooding, extra safety layer
const MAX_PATH_LENGTH = 255 // Linux/macOS single path component limit

// Sprint 2 — task C: async-by-default execute_command.
// If the command finishes within ASYNC_FAST_PATH_MS we keep the synchronous
// UX of v0.5 and return stdout inline. Otherwise we return a {task_id, running}
// payload so the model can keep working and later retrieve the result via
// get_tool_result (S2-F).
const ASYNC_FAST_PATH_MS = 500

const LONG_RUNNING_COMMAND_PATTERNS: RegExp[] = [
	/\b(npm|pnpm|yarn|bun)\s+(install|ci|build|test)\b/i,
	/\b(npm|pnpm|yarn|bun)\s+run\s+(build|test|lint|typecheck|check)\b/i,
	/\b(pip|pip3|uv)\s+install\b/i,
	/\b(poetry|pipenv)\s+install\b/i,
	/\b(cargo|go|mvn|gradle|gradlew)\s+(build|test|check|install)\b/i,
	/\b(make|cmake|ctest)\b/i,
	/\b(pytest|tox|nox|jest|vitest|mocha)\b/i,
	/\b(docker|podman)\s+build\b/i,
	/\b(torchrun|deepspeed|accelerate\s+launch)\b/i,
	/\b(sleep|wait|watch)\b/i,
	/\b(rails|rake|bundle\s+exec\s+rake)\s+db:(migrate|setup|seed)\b/i,
	/\b(alembic|flask\s+db)\s+(upgrade|downgrade)\b/i,
	/\b(prisma|npx\s+prisma)\s+(migrate|db\s+push)\b/i,
	/\b(sequelize|npx\s+sequelize)\s+db:migrate\b/i,
	/\b(django-admin|python\s+manage\.py)\s+migrate\b/i,
	/\bffmpeg\b/i,
	/\bpython(?:\d+(?:\.\d+)?)?\s+.*\b(train|finetune)\b/i,
]

export function isLikelyLongRunningCommand(command: string): boolean {
	const normalized = command.trim().replace(/\s+/g, " ")
	return LONG_RUNNING_COMMAND_PATTERNS.some((pattern) => pattern.test(normalized))
}

export function resolveCommandTimeoutSeconds(command: string, useManagedTimeout: boolean): number | undefined {
	if (!useManagedTimeout) {
		return undefined
	}

	return isLikelyLongRunningCommand(command) ? LONG_RUNNING_COMMAND_TIMEOUT_SECONDS : DEFAULT_COMMAND_TIMEOUT_SECONDS
}

export class ExecuteCommandToolHandler implements IFullyManagedTool {
	readonly name = IsaacDefaultTool.BASH

	constructor(private validator: ToolValidator) {}

	getDescription(block: ToolUse): string {
		const commands = coerceToStringArray(block.params.commands)
		const script = block.params.script as string | undefined
		const language = block.params.language as string | undefined

		if (script) {
			const langDisplay = language ? ` (${language})` : ""
			return `[${block.name} for script${langDisplay}]`
		}

		if (commands.length > 0) {
			return `[${block.name} for ${commands.length} commands]`
		}

		return `[${block.name} for '${commands[0] || ""}']`
	}

	async handlePartialBlock(block: ToolUse, uiHelpers: StronglyTypedUIHelpers): Promise<void> {
		const config = uiHelpers.getConfig()
		if (config.isSubagentExecution) {
			return
		}

		const rawCommands = coerceToStringArray(block.params.commands)
		const script = block.params.script as string | undefined
		const language = (block.params.language as string | undefined) || "bash"

		const commandsToProcess: { command: string; displayName?: string }[] = []
		for (const cmd of rawCommands) {
			if (cmd) {
				commandsToProcess.push({
					command: uiHelpers.removeClosingTag(block, "commands", cmd),
				})
			}
		}

		if (script) {
			const langDisplay = language.charAt(0).toUpperCase() + language.slice(1)
			commandsToProcess.push({
				command: uiHelpers.removeClosingTag(block, "script", script),
				displayName: `${langDisplay} script`,
			})
		}

		if (commandsToProcess.length === 0) {
			return
		}

		const multiCommandState: MultiCommandState = {
			commands: commandsToProcess.map((item) => ({
				command: item.command,
				displayName: item.displayName,
				status: "pending",
			})),
		}

		// Determine if we should use 'ask' or 'say' based on auto-approval
		// For simplicity, we check the first command's safety
		const firstCommand = commandsToProcess[0].command
		const isSafe = isSafeCommand(firstCommand)
		const autoApproveResult = uiHelpers.shouldAutoApproveTool(this.name)
		const autoApproveEnabled = Array.isArray(autoApproveResult) ? autoApproveResult[0] : autoApproveResult
		const isYolo = config.yoloModeToggled || config.services.stateManager.getGlobalSettingsKey("autoApproveAllToggled")

		const shouldAutoApprove = isYolo || (isSafe && autoApproveEnabled)

		if (shouldAutoApprove) {
			await uiHelpers.removeLastPartialMessageIfExistsWithType("ask", "tool")
			await uiHelpers.say("tool", firstCommand, undefined, undefined, block.partial, multiCommandState)
		} else {
			await uiHelpers.removeLastPartialMessageIfExistsWithType("say", "tool")
			await uiHelpers.ask("tool", firstCommand, block.partial, multiCommandState).catch(() => {})
		}
	}

	async execute(config: TaskConfig, block: ToolUse): Promise<ToolResponse> {
		const rawCommands = coerceToStringArray(block.params.commands)
		const script = block.params.script as string | undefined
		const language = (block.params.language as string | undefined) || "bash"

		// Validate required parameters
		let validation: { ok: boolean; error?: string; paramName?: string }
		if (block.params.commands) {
			validation = { ...this.validator.assertRequiredParams(block, "commands"), paramName: "commands" }
		} else if (block.params.script) {
			validation = { ...this.validator.assertRequiredParams(block, "script"), paramName: "script" }
		} else {
			validation = { ok: false, error: "Missing required parameter: 'commands' or 'script' must be provided." }
		}

		if (!validation.ok) {
			config.taskState.consecutiveMistakeCount++
			if (validation.paramName) {
				return await config.callbacks.sayAndCreateMissingParamError(this.name, validation.paramName as any)
			}
			await config.callbacks.say(
				"error",
				`Isaac tried to use ${this.name} without providing any commands or script. Retrying...`,
			)
			return formatResponse.toolError(validation.error!)
		}

		// Normalize to a list of commands
		const commandsToProcess: { command: string; displayName?: string }[] = []

		for (const cmd of rawCommands) {
			if (cmd) {
				commandsToProcess.push({ command: cmd })
			}
		}

		if (script) {
			const wrappedCommand = this.wrapScript(script, language)
			const langDisplay = language.charAt(0).toUpperCase() + language.slice(1)
			commandsToProcess.push({
				command: wrappedCommand,
				displayName: `${langDisplay} script`,
			})
		}

		if (commandsToProcess.length === 0) {
			return formatResponse.toolResult("No commands provided to execute.")
		}

		// 1b. Validate: reject path-like arguments exceeding OS filename length limit
		for (const cmd of commandsToProcess) {
			const parts = cmd.command.split(/\s+/)
			for (const part of parts) {
				if (
					(part.startsWith("/") || part.startsWith("./") || part.startsWith("../") || part.includes("/")) &&
					Buffer.byteLength(part) > MAX_PATH_LENGTH
				) {
					const preview = part.slice(0, 80)
					const resultObj = {
						ok: false,
						error: "PATH_TOO_LONG",
						message: `Path argument exceeds maximum allowed length (${MAX_PATH_LENGTH} bytes). Saw: ${preview}${part.length > 80 ? "..." : ""} (total ${Buffer.byteLength(part)} bytes). If you meant to pass file contents, use a pipe or write to a file first.`,
					}
					return formatResponse.toolResult(JSON.stringify(resultObj, null, 2))
				}
			}
		}

		// Extract provider
		const apiConfig = config.services.stateManager.getApiConfiguration()
		const currentMode = config.services.stateManager.getGlobalSettingsKey("mode")
		const provider = (currentMode === "plan" ? apiConfig.planModeApiProvider : apiConfig.actModeApiProvider) as string
		const isYolo = config.yoloModeToggled || config.services.stateManager.getGlobalSettingsKey("autoApproveAllToggled")

		// Initialize multi-command state
		const multiCommandState: MultiCommandState = {
			commands: commandsToProcess.map((item) => ({
				command: item.command,
				displayName: item.displayName,
				status: "pending",
			})),
		}

		// Check if any command requires manual approval BEFORE creating the initial message
		const commandsRequiringApproval = []
		for (const cmdState of multiCommandState.commands) {
			const actualCommand = cmdState.command.trim()
			const isSafe = isSafeCommand(actualCommand)
			const permissionResult = config.services.commandPermissionController.validateCommand(actualCommand)
			const isAllowedByRules = permissionResult.allowed
			const autoApproveResult = config.autoApprover?.shouldAutoApproveTool(block.name)
			const autoApproveEnabled =
				typeof autoApproveResult === "boolean"
					? autoApproveResult
					: Array.isArray(autoApproveResult)
						? autoApproveResult[0]
						: false

			if (!config.isSubagentExecution && !(isYolo || (isSafe && isAllowedByRules && autoApproveEnabled))) {
				commandsRequiringApproval.push(actualCommand)
				cmdState.requiresApproval = true
			}
		}

		let initialResult: any
		let messageTs: number | undefined

		// Clean up any previous partial messages
		await config.callbacks.removeLastPartialMessageIfExistsWithType("ask", "tool")
		await config.callbacks.removeLastPartialMessageIfExistsWithType("say", "tool")

		let wasManuallyApproved = false

		if (commandsRequiringApproval.length > 0) {
			showNotificationForApproval(
				`Isaac wants to execute ${commandsRequiringApproval.length} commands`,
				config.autoApprovalSettings.enableNotifications,
			)

			// Ask for approval once for all commands
			initialResult = await ToolResultUtils.askApprovalAndPushFeedback(
				"command",
				commandsToProcess[0].command,
				config,
				false,
				multiCommandState,
			)
			messageTs = initialResult.askTs

			if (!initialResult.didApprove) {
				for (const cmdState of multiCommandState.commands) {
					if (cmdState.status === "pending") {
						cmdState.requiresApproval = false
						cmdState.status = "skipped"
						cmdState.output = "Command denied by user."
					}
				}

				if (messageTs !== undefined) {
					const messages = config.callbacks.getIsaacMessages()
					const index = messages.findIndex((m) => m.ts === messageTs)
					if (index !== -1) {
						await config.callbacks.updateIsaacMessage(index, { multiCommandState: { ...multiCommandState } })
					}
				}

				return formatResponse.toolResult("Commands denied by user.")
			}

			wasManuallyApproved = true

			// Clear requiresApproval flag for all commands since they were approved
			for (const cmdState of multiCommandState.commands) {
				cmdState.requiresApproval = false
			}

			if (messageTs !== undefined) {
				const messages = config.callbacks.getIsaacMessages()
				const index = messages.findIndex((m) => m.ts === messageTs)
				if (index !== -1) {
					await config.callbacks.updateIsaacMessage(index, { multiCommandState: { ...multiCommandState } })
				}
			}
		} else {
			// Initial message to show all commands
			initialResult = await ToolResultUtils.askApprovalAndPushFeedback(
				"command",
				commandsToProcess[0].command,
				config,
				true,
				multiCommandState,
			)
			messageTs = initialResult.askTs
		}

		const updateMessage = async () => {
			if (messageTs === undefined) return
			const messages = config.callbacks.getIsaacMessages()
			const index = messages.findIndex((m) => m.ts === messageTs)
			if (index !== -1) {
				await config.callbacks.updateIsaacMessage(index, {
					multiCommandState: { ...multiCommandState },
					commandCompleted: false,
					partial: false,
				})
			}
		}

		const results: string[] = []
		let anyFailed = false
		let anySucceeded = false

		for (let i = 0; i < multiCommandState.commands.length; i++) {
			const cmdState = multiCommandState.commands[i]
			const originalCommand = cmdState.command
			const displayName = cmdState.displayName || originalCommand

			// Pre-process command (Gemini fix)
			let commandToExecute = originalCommand
			if (config.api.getModel().id.includes("gemini")) {
				commandToExecute = applyModelContentFixes(originalCommand)
			}

			// Handle multi-workspace hint
			let executionDir: string = config.cwd
			let actualCommand: string = commandToExecute
			let workspaceHint: string | undefined

			if (config.isMultiRootEnabled && config.workspaceManager) {
				const commandMatch = commandToExecute.match(/^@(\w+):(.+)$/)
				if (commandMatch) {
					workspaceHint = commandMatch[1]
					actualCommand = commandMatch[2].trim()
					const adapter = new WorkspacePathAdapter({
						cwd: config.cwd,
						isMultiRootEnabled: true,
						workspaceManager: config.workspaceManager,
					})
					executionDir = adapter.resolvePath(".", workspaceHint)
				}
			}

			// ailiance-agent fork: hard-deny zone gate — refuse destructive
			// commands BEFORE any approval flow, even under --yolo. Mirrors
			// the Python contract (exit_code=8, error surfaced to model).
			const zone = classifyCommand(actualCommand)
			if (zone === "hard_deny") {
				const errorMessage = `Command "${actualCommand}" was refused by hard-deny zone gate (exit_code=${HARD_DENY_EXIT_CODE}). Destructive commands are blocked even with --yolo.`
				cmdState.status = "failed"
				cmdState.output = errorMessage
				await updateMessage()
				results.push(`--- Output for '${displayName}' ---\n${errorMessage}`)
				anyFailed = true
				continue
			}

			// Permission validation
			const permissionResult = config.services.commandPermissionController.validateCommand(actualCommand, isYolo || config.isSubagentExecution)
			if (!permissionResult.allowed && !wasManuallyApproved && !isYolo && !config.isSubagentExecution) {
				let errorMessage = `Command "${actualCommand}" was denied by DIRAC_COMMAND_PERMISSIONS.`
				if (permissionResult.failedSegment) {
					errorMessage += ` Segment "${permissionResult.failedSegment}" ${permissionResult.reason}.`
				} else {
					const matched = permissionResult.matchedPattern
						? ` (matched pattern: ${permissionResult.matchedPattern})`
						: ""
					errorMessage += ` Reason: ${permissionResult.reason}${matched}`
				}

				cmdState.status = "failed"
				cmdState.output = errorMessage
				await updateMessage()

				results.push(`--- Output for '${displayName}' ---\n${errorMessage}`)
				anyFailed = true
				continue
			}

			// Isaacignore validation
			const ignoredFileAttemptedToAccess = config.services.diracIgnoreController.validateCommand(actualCommand)
			if (ignoredFileAttemptedToAccess) {
				cmdState.status = "failed"
				cmdState.output = `Isaacignore error: ${ignoredFileAttemptedToAccess}`
				await updateMessage()

				results.push(`--- Output for '${displayName}' ---\nIsaacignore error: ${ignoredFileAttemptedToAccess}`)
				anyFailed = true
				continue
			}

			// Safety check for auto-approval
			const isSafe = isSafeCommand(actualCommand)
			const autoApproveResult = config.autoApprover?.shouldAutoApproveTool(block.name)
			const autoApproveEnabled = Array.isArray(autoApproveResult) ? autoApproveResult[0] : autoApproveResult

			let didAutoApprove = false
			if (config.isSubagentExecution || isYolo || (isSafe && autoApproveEnabled)) {
				didAutoApprove = true
				cmdState.wasAutoApproved = true
			}

			// Telemetry
			telemetryService.captureToolUsage(
				config.ulid,
				block.name,
				config.api.getModel().id,
				provider,
				didAutoApprove,
				true,
				{
					isMultiRootEnabled: config.isMultiRootEnabled || false,
					usedWorkspaceHint: !!workspaceHint,
					resolvedToNonPrimary: executionDir !== config.cwd,
					resolutionMethod: workspaceHint ? "hint" : "primary_fallback",
				},
				block.isNativeToolCall,
			)

			// Pre-tool hook
			try {
				const { ToolHookUtils } = await import("../utils/ToolHookUtils")
				await ToolHookUtils.runPreToolUseIfEnabled(config, block)
			} catch (error) {
				const { PreToolUseHookCancellationError } = await import("@core/hooks/PreToolUseHookCancellationError")
				if (error instanceof PreToolUseHookCancellationError) {
					cmdState.status = "failed"
					cmdState.output = "Cancelled by pre-tool hook."
					await updateMessage()
					results.push(`--- Output for '${displayName}' ---\nCancelled by pre-tool hook.`)
					anyFailed = true
					continue
				}
				throw error
			}

			// Execution
			cmdState.status = "running"
			await updateMessage()

			let lastUpdate = 0
			const updateInterval = 200 // ms
			let updateTimer: NodeJS.Timeout | null = null

			const throttledUpdate = async () => {
				const now = Date.now()
				if (now - lastUpdate >= updateInterval) {
					lastUpdate = now
					if (updateTimer) {
						clearTimeout(updateTimer)
						updateTimer = null
					}
					await updateMessage()
				} else if (!updateTimer) {
					updateTimer = setTimeout(
						async () => {
							updateTimer = null
							await throttledUpdate()
						},
						updateInterval - (now - lastUpdate),
					)
				}
			}

			let finalCommand: string = actualCommand
			if (executionDir !== config.cwd) {
				finalCommand = `cd "${executionDir}" && ${actualCommand}`
			}

			const timeoutSeconds = resolveCommandTimeoutSeconds(actualCommand, true)
			const onOutputLine = (line: string) => {
				const currentOutput = cmdState.output || ""
				if (currentOutput.includes("... [Output truncated")) {
					return
				}
				const newOutput = currentOutput + line + "\n"
				if (newOutput.length >= MAX_COMMAND_OUTPUT_SIZE) {
					cmdState.output = truncateHeadTail(newOutput, MAX_COMMAND_OUTPUT_SIZE)
				} else {
					cmdState.output = newOutput
				}
				throttledUpdate()
			}

			// Sprint 2-C: if the task exposes a PendingToolRegistry we run the
			// command async-by-default with a fast-path timer. Otherwise (e.g.
			// isolated unit-test config) fall back to the original sync flow.
			const registry: PendingToolRegistry | undefined = config.taskState?.pendingTools
			let asyncEntry: PendingToolEntry | undefined
			let abortSignal: AbortSignal | undefined
			let asyncHandleDispose: (() => void) | undefined

			if (registry) {
				asyncEntry = registry.register({ toolName: "execute_command", blockId: block.call_id })
				abortSignal = asyncEntry.abortController.signal

				// Build a minimal messenger adapter from config.callbacks.say so
				// AsyncToolNotifier can push the running/terminal partials without
				// requiring a direct TaskMessenger reference inside the handler.
				const messengerAdapter = {
					say: (type: any, text?: string, images?: string[], files?: string[], partial?: boolean) =>
						config.callbacks.say(type, text, images, files, partial),
				} as unknown as TaskMessenger

				try {
					const handle = await notifyAsyncTool({
						messenger: messengerAdapter,
						registry,
						entry: asyncEntry,
						initialPayload: {
							tool: "executeCommand" as any,
							command: actualCommand,
						},
					})
					asyncHandleDispose = handle.dispose
				} catch (err) {
					Logger.warn(
						`[ExecuteCommandToolHandler] notifyAsyncTool failed (continuing sync): ${err instanceof Error ? err.message : String(err)}`,
					)
				}
			}

			const execPromise = (async () => {
				try {
					const [userRejected, result] = await config.callbacks.executeCommandTool(finalCommand, timeoutSeconds, {
						suppressUserInteraction: true,
						useBackgroundExecution: true,
						onOutputLine,
						...(abortSignal ? { abortSignal } : {}),
					})
					return { kind: "ok" as const, userRejected, result }
				} catch (error) {
					return { kind: "error" as const, error }
				}
			})()

			let raceResult: { kind: "ok"; userRejected: boolean; result: any } | { kind: "error"; error: unknown } | "timeout"
			if (registry && asyncEntry) {
				let timeoutHandle: NodeJS.Timeout | undefined
				const timeoutPromise = new Promise<"timeout">((resolve) => {
					timeoutHandle = setTimeout(() => resolve("timeout"), ASYNC_FAST_PATH_MS)
				})
				raceResult = await Promise.race([execPromise, timeoutPromise])
				if (timeoutHandle) {
					clearTimeout(timeoutHandle)
				}
			} else {
				raceResult = await execPromise
			}

			if (raceResult === "timeout") {
				// Slow command: hand it off to the background. The promise keeps
				// running and will call registry.complete/fail/cancel below.
				if (updateTimer) {
					clearTimeout(updateTimer)
					updateTimer = null
				}
				const taskId = asyncEntry!.taskId
				void execPromise
					.then((settled) => {
						if (settled.kind === "error") {
							const err = settled.error as any
							if (err?.name === "AbortError") {
								// already cancelled by registry.cancel — no-op
								return
							}
							registry!.fail(taskId, err instanceof Error ? err.message : String(err))
							return
						}
						if (settled.userRejected) {
							registry!.fail(taskId, "Command was rejected or interrupted during execution.")
							return
						}
						const rawOutput =
							typeof settled.result === "string"
								? settled.result
								: Array.isArray(settled.result)
									? settled.result.map((c: any) => c.text || "").join("\n")
									: JSON.stringify(settled.result)
						registry!.complete(taskId, truncateHeadTail(rawOutput, MAX_COMMAND_OUTPUT_SIZE))
					})
					.catch((err) => {
						Logger.warn(
							`[ExecuteCommandToolHandler] background settlement crashed: ${err instanceof Error ? err.message : String(err)}`,
						)
					})

				const placeholder =
					`Command launched in background (exceeded ${ASYNC_FAST_PATH_MS}ms fast-path).\n` +
					`task_id: ${taskId}\n` +
					`status: running\n` +
					`To retrieve the result, call get_tool_result with this task_id.`
				cmdState.status = "running"
				cmdState.output = placeholder
				await updateMessage()
				results.push(`--- Output for '${displayName}' ---\n${placeholder}`)
				anySucceeded = true
				continue
			}

			// Fast-path: command finished synchronously within the budget (or
			// no registry available — pure v0.5 behavior).
			try {
				if (raceResult.kind === "error") {
					const err = raceResult.error
					cmdState.status = "failed"
					cmdState.output = `Error during execution: ${err instanceof Error ? err.message : String(err)}`
					await updateMessage()
					results.push(`--- Output for '${displayName}' ---\n${cmdState.output}`)
					anyFailed = true
					if (registry && asyncEntry) {
						registry.fail(asyncEntry.taskId, err instanceof Error ? err.message : String(err))
					}
				} else if (raceResult.userRejected) {
					config.taskState.didRejectTool = true
					cmdState.status = "failed"
					cmdState.output = "Command was rejected or interrupted during execution."
					await updateMessage()
					results.push(`--- Output for '${displayName}' ---\nCommand was rejected or interrupted during execution.`)
					anyFailed = true
					if (registry && asyncEntry) {
						registry.fail(asyncEntry.taskId, cmdState.output)
					}
				} else {
					const rawOutput =
						typeof raceResult.result === "string"
							? raceResult.result
							: Array.isArray(raceResult.result)
								? raceResult.result.map((c: any) => c.text || "").join("\n")
								: JSON.stringify(raceResult.result)

					const output = truncateHeadTail(rawOutput, MAX_COMMAND_OUTPUT_SIZE)

					cmdState.status = "completed"
					cmdState.output = output
					await updateMessage()

					results.push(`--- Output for '${displayName}' ---\n${output}`)
					anySucceeded = true
					if (registry && asyncEntry) {
						registry.complete(asyncEntry.taskId, output)
					}
				}
			} finally {
				if (updateTimer) {
					clearTimeout(updateTimer)
					updateTimer = null
				}
				// Detach AsyncToolNotifier listener — it auto-disposes on
				// terminal transition, but call dispose() defensively in case
				// the registry never fired (e.g. notifyAsyncTool init failed).
				if (asyncHandleDispose) {
					asyncHandleDispose()
				}
			}
		}

		// Update consecutive mistake count
		if (anyFailed) {
			config.taskState.consecutiveMistakeCount++
		} else if (anySucceeded) {
			config.taskState.consecutiveMistakeCount = 0
		}

		// Mark the final message as completed
		const messages = config.callbacks.getIsaacMessages()
		const index = messages.findIndex((m) => m.ts === messageTs)
		if (index !== -1) {
			await config.callbacks.updateIsaacMessage(index, {
				commandCompleted: true,
				partial: false,
			})
		}

		return formatResponse.toolResult(results.join("\n\n"))
	}

	private wrapScript(script: string, language: string): string {
		const delimiter = `EOF_DIRAC_SCRIPT_${Math.random().toString(36).substring(2, 10).toUpperCase()}`
		const normalizedLanguage = language.toLowerCase().trim()

		let interpreter = "bash"
		if (normalizedLanguage === "python" || normalizedLanguage === "python3") {
			interpreter = "python3"
		} else if (normalizedLanguage === "node" || normalizedLanguage === "javascript") {
			interpreter = "node"
		} else if (normalizedLanguage === "sh") {
			interpreter = "sh"
		} else if (normalizedLanguage === "ruby") {
			interpreter = "ruby"
		} else if (normalizedLanguage === "perl") {
			interpreter = "perl"
		} else {
			interpreter = normalizedLanguage
		}

		return `${interpreter} << '${delimiter}'\n${script}\n${delimiter}`
	}
}
