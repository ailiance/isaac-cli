import { setTimeout as setTimeoutPromise } from "node:timers/promises"
import { ApiStream } from "@core/api/transform/stream"
import { checkContextWindowExceededError } from "@core/context/context-management/context-error-handling"
import {
	getGlobalDiracRules,
	getLocalDiracRules,
	refreshDiracRulesToggles,
} from "@core/context/instructions/user-instructions/dirac-rules"
import {
	getLocalAgentsRules,
	getLocalCursorRules,
	getLocalWindsurfRules,
	refreshExternalRulesToggles,
} from "@core/context/instructions/user-instructions/external-rules"
import { formatResponse } from "@core/prompts/responses"
import type { SystemPromptContext } from "@core/prompts/system-prompt"
import { getSystemPrompt } from "@core/prompts/system-prompt"
import { getActiveMcpToolSet } from "@core/mcp/retrieval/session"
import { ensureRulesDirectoryExists, ensureTaskDirectoryExists } from "@core/storage/disk"
import { isMultiRootEnabled } from "@core/workspace/multi-root-utils"
import { HostProvider } from "@hosts/host-provider"
import { DiracError, DiracErrorType, ErrorService } from "@services/error"
import { featureFlagsService } from "@services/feature-flags"
import { findLastIndex } from "@shared/array"
import { DiracClient } from "@shared/dirac"
import { DiracApiReqInfo } from "@shared/ExtensionMessage"
import { DEFAULT_LANGUAGE_SETTINGS, getLanguageKey, LanguageDisplay } from "@shared/Languages"
import { Logger } from "@shared/services/Logger"
import { DiracAskResponse } from "@shared/WebviewMessage"
import fs from "fs/promises"
import * as path from "path"
import { getAvailableCores } from "@/utils/os"
import { detectBestShell } from "@/utils/shell-detection"
import { RuleContextBuilder } from "../context/instructions/user-instructions/RuleContextBuilder"
import { getOrDiscoverSkills } from "../context/instructions/user-instructions/skills"
import type { TaskState } from "./TaskState"
import type { ApiRequestHandlerContext } from "./types/api-request-handler"
import { updateApiReqMsg } from "./utils"

/**
 * ApiRequestHandler encapsulates the API request logic extracted from Task.
 *
 * Sprint 2 PR4 — step 4A: attemptApiRequest extracted from Task.
 * PR6 — narrowed from Task to ApiRequestHandlerContext interface.
 */
export class ApiRequestHandler {
	private readonly taskState: TaskState

	constructor(private readonly ctx: ApiRequestHandlerContext) {
		this.taskState = ctx.taskState
	}

	/**
	 * Attempt an API request, handling errors and retries.
	 *
	 * Extracted from Task.attemptApiRequest — public API of Task is preserved
	 * via the thin wrapper that delegates here.
	 */
	async *attempt(previousApiReqIndex: number, shouldCompact?: boolean): ApiStream {
		const providerInfo = this.ctx.getCurrentProviderInfo()
		const host = await HostProvider.env.getHostVersion({})
		const ide = host?.platform || "Unknown"
		const isCliEnvironment = host.diracType === DiracClient.Cli
		const browserSettings = this.ctx.stateManager.getGlobalSettingsKey("browserSettings")
		const disableBrowserTool = browserSettings.disableToolUse ?? false
		// dirac browser tool uses image recognition for navigation (requires model image support).
		const modelSupportsBrowserUse = providerInfo.model.info.supportsImages ?? false

		const supportsBrowserUse = modelSupportsBrowserUse && !disableBrowserTool // only enable browser use if the model supports it and the user hasn't disabled it
		const preferredLanguageRaw = this.ctx.stateManager.getGlobalSettingsKey("preferredLanguage")
		const preferredLanguage = getLanguageKey(preferredLanguageRaw as LanguageDisplay)
		const preferredLanguageInstructions =
			preferredLanguage && preferredLanguage !== DEFAULT_LANGUAGE_SETTINGS
				? `# Preferred Language\n\nSpeak in ${preferredLanguage}.`
				: ""

		const { globalToggles, localToggles } = await refreshDiracRulesToggles(this.ctx.controller, this.ctx.cwd)
		const { windsurfLocalToggles, cursorLocalToggles, agentsLocalToggles } = await refreshExternalRulesToggles(
			this.ctx.controller,
			this.ctx.cwd,
		)

		const evaluationContext = await RuleContextBuilder.buildEvaluationContext({
			cwd: this.ctx.cwd,
			messageStateHandler: this.ctx.messageStateHandler,
			workspaceManager: this.ctx.workspaceManager,
		})

		const globalDiracRulesFilePath = await ensureRulesDirectoryExists()
		const globalRules = await getGlobalDiracRules(globalDiracRulesFilePath, globalToggles, { evaluationContext })
		const globalDiracRulesFileInstructions = globalRules.instructions

		const localRules = await getLocalDiracRules(this.ctx.cwd, localToggles, { evaluationContext })
		const localDiracRulesFileInstructions = localRules.instructions
		const [localCursorRulesFileInstructions, localCursorRulesDirInstructions] = await getLocalCursorRules(
			this.ctx.cwd,
			cursorLocalToggles,
		)
		const localWindsurfRulesFileInstructions = await getLocalWindsurfRules(this.ctx.cwd, windsurfLocalToggles)

		const localAgentsRulesFileInstructions = await getLocalAgentsRules(this.ctx.cwd, agentsLocalToggles)
		this.ctx.diracIgnoreController.yoloMode = !!this.ctx.stateManager.getGlobalSettingsKey("yoloModeToggled")

		const isYolo = !!this.ctx.stateManager.getGlobalSettingsKey("yoloModeToggled")
		const diracIgnoreContent = this.ctx.diracIgnoreController.diracIgnoreContent
		let diracIgnoreInstructions: string | undefined
		if (diracIgnoreContent && !isYolo) {
			diracIgnoreInstructions = formatResponse.diracIgnoreInstructions(diracIgnoreContent)
		}

		// Prepare multi-root workspace information if enabled
		let workspaceRoots: Array<{ path: string; name: string; vcs?: string }> | undefined
		const multiRootEnabled = isMultiRootEnabled(this.ctx.stateManager)
		if (multiRootEnabled && this.ctx.workspaceManager) {
			workspaceRoots = this.ctx.workspaceManager.getRoots().map((root) => ({
				path: root.path,
				name: root.name || path.basename(root.path), // Fallback to basename if name is undefined
				vcs: root.vcs as string | undefined, // Cast VcsType to string
			}))
		}

		// Discover and filter available skills
		const resolvedSkills = await getOrDiscoverSkills(this.ctx.cwd, this.taskState)

		// Filter skills by toggle state (enabled by default)
		const globalSkillsToggles = this.ctx.stateManager.getGlobalSettingsKey("globalSkillsToggles") ?? {}
		const localSkillsToggles = this.ctx.stateManager.getWorkspaceStateKey("localSkillsToggles") ?? {}
		const availableSkills = resolvedSkills.filter((skill) => {
			const toggles = skill.source === "global" ? globalSkillsToggles : localSkillsToggles
			// If toggle exists, use it; otherwise default to enabled (true)
			return toggles[skill.path] !== false
		})

		this.taskState.availableSkills = availableSkills

		// Snapshot editor tabs so prompt tools can decide whether to include
		// filetype-specific instructions (e.g. notebooks) without adding bespoke flags.
		const openTabPaths = (await HostProvider.window.getOpenTabs({})).paths || []
		const visibleTabPaths = (await HostProvider.window.getVisibleTabs({})).paths || []
		const cap = 50
		const editorTabs = {
			open: openTabPaths.slice(0, cap),
			visible: visibleTabPaths.slice(0, cap),
		}

		const shellInfo = detectBestShell()

		// Extract the user's first prompt text for the current task so the
		// memory auto-injector (loadRelevantMemories) can rank stored
		// memories by relevance. Only meaningful at turn-1 (single user
		// message in history); on subsequent turns the prompt is the same
		// task intent so re-using the first message remains a reasonable
		// proxy for relevance. Best-effort: failures fall back to undefined
		// and memories sort by date.
		let firstUserPromptText: string | undefined
		try {
			const history = this.ctx.messageStateHandler.getApiConversationHistory()
			const firstUser = history.find((m) => m.role === "user")
			if (firstUser) {
				const c: any = firstUser.content
				if (typeof c === "string") {
					firstUserPromptText = c
				} else if (Array.isArray(c)) {
					const parts: string[] = []
					for (const block of c) {
						if (block && typeof block === "object" && (block as any).type === "text") {
							const t = (block as any).text
							if (typeof t === "string") parts.push(t)
						}
					}
					if (parts.length > 0) firstUserPromptText = parts.join(" ")
				}
			}
		} catch {
			// best-effort; leave undefined
		}

		const promptContext: SystemPromptContext = {
			cwd: this.ctx.cwd,
			ide,
			providerInfo,
			editorTabs,
			supportsBrowserUse,
			skills: availableSkills,
			globalDiracRulesFileInstructions,
			localDiracRulesFileInstructions,
			localCursorRulesFileInstructions,
			localCursorRulesDirInstructions,
			localWindsurfRulesFileInstructions,
			localAgentsRulesFileInstructions,
			diracIgnoreInstructions,
			preferredLanguageInstructions,
			browserSettings: this.ctx.stateManager.getGlobalSettingsKey("browserSettings"),
			yoloModeToggled: this.ctx.stateManager.getGlobalSettingsKey("yoloModeToggled"),
			subagentsEnabled: this.ctx.stateManager.getGlobalSettingsKey("subagentsEnabled"),
			diracWebToolsEnabled:
				this.ctx.stateManager.getGlobalSettingsKey("diracWebToolsEnabled") && featureFlagsService.getWebtoolsEnabled(),
			isMultiRootEnabled: multiRootEnabled,
			workspaceRoots,
			isSubagentRun: false,
			isCliEnvironment,
			enableParallelToolCalling: this.ctx.isParallelToolCallingEnabled(),
			terminalExecutionMode: this.ctx.terminalExecutionMode,
			activeShellType: shellInfo.type,
			activeShellPath: shellInfo.path,
			activeShellIsPosix: shellInfo.isPosix,
			availableCores: getAvailableCores(),
			shouldCompact,
			userPromptText: firstUserPromptText,
			activeMcpTools: getActiveMcpToolSet()?.snapshot(),
		}

		// Notify user if any conditional rules were applied for this request
		const activatedConditionalRules = [...globalRules.activatedConditionalRules, ...localRules.activatedConditionalRules]
		if (activatedConditionalRules.length > 0) {
			await this.ctx.say("conditional_rules_applied", JSON.stringify({ rules: activatedConditionalRules }))
		}

		const { systemPrompt, tools } = await getSystemPrompt(promptContext)
		this.taskState.useNativeToolCalls = !!tools?.length

		const contextManagementMetadata = await this.ctx.contextManager.getNewContextMessagesAndMetadata(
			this.ctx.messageStateHandler.getApiConversationHistory(),
			this.ctx.messageStateHandler.getDiracMessages(),
			this.ctx.api,
			this.taskState.conversationHistoryDeletedRange,
			previousApiReqIndex,
			await ensureTaskDirectoryExists(this.ctx.taskId),
			this.ctx.stateManager.getGlobalSettingsKey("useAutoCondense"),
		)

		await this.writePromptMetadataArtifacts({
			systemPrompt,
			providerInfo,
			tools,
			fullHistory: this.ctx.messageStateHandler.getApiConversationHistory(),
			deletedRange: this.taskState.conversationHistoryDeletedRange,
		})

		if (contextManagementMetadata.updatedConversationHistoryDeletedRange) {
			this.taskState.conversationHistoryDeletedRange = contextManagementMetadata.conversationHistoryDeletedRange
			await this.ctx.messageStateHandler.saveDiracMessagesAndUpdateHistory()
			// saves task history item which we use to keep track of conversation history deleted range
		}

		// If we're not using auto-condense, we should explicitly notify the model that history was truncated
		const useAutoCondense = this.ctx.stateManager.getGlobalSettingsKey("useAutoCondense")
		if (!useAutoCondense) {
			const lastMessage =
				contextManagementMetadata.truncatedConversationHistory[
					contextManagementMetadata.truncatedConversationHistory.length - 1
				]
			if (lastMessage && lastMessage.role === "user") {
				const notice = formatResponse.contextTruncationNotice()
				if (typeof lastMessage.content === "string") {
					lastMessage.content += `

${notice}`
				} else if (Array.isArray(lastMessage.content)) {
					lastMessage.content.push({
						type: "text",
						text: notice,
					})
				}
			}
		}

		// Response API requires native tool calls to be enabled
		const stream = this.ctx.api.createMessage(
			systemPrompt,
			contextManagementMetadata.truncatedConversationHistory as any,
			tools,
		)

		const iterator = stream[Symbol.asyncIterator]()

		try {
			// awaiting first chunk to see if it will throw an error
			this.taskState.isWaitingForFirstChunk = true
			const firstChunk = await iterator.next()
			yield firstChunk.value
			this.taskState.isWaitingForFirstChunk = false
		} catch (error) {
			const isContextWindowExceededError = checkContextWindowExceededError(error)
			const { model, providerId } = this.ctx.getCurrentProviderInfo()
			const diracError = ErrorService.get().toDiracError(error, model.id, providerId)

			// Capture provider failure telemetry using diracError
			ErrorService.get().logMessage(diracError.message)

			if (isContextWindowExceededError && !this.taskState.didAutomaticallyRetryFailedApiRequest) {
				await this.ctx.handleContextWindowExceededError()
			} else {
				// request failed after retrying automatically once, ask user if they want to retry again
				// note that this api_req_failed ask is unique in that we only present this option if the api hasn't streamed any content yet (ie it fails on the first chunk due), as it would allow them to hit a retry button. However if the api failed mid-stream, it could be in any arbitrary state where some tools may have executed, so that error is handled differently and requires cancelling the task entirely.

				if (isContextWindowExceededError) {
					const truncatedConversationHistory = this.ctx.contextManager.getTruncatedMessages(
						this.ctx.messageStateHandler.getApiConversationHistory(),
						this.taskState.conversationHistoryDeletedRange,
					)

					// If the conversation has more than 3 messages, we can truncate again. If not, then the conversation is bricked.
					// ToDo: Allow the user to change their input if this is the case.
					if (truncatedConversationHistory.length > 3) {
						diracError.message = "Context window exceeded. Click retry to truncate the conversation and try again."
						this.taskState.didAutomaticallyRetryFailedApiRequest = false
					}
				}

				const streamingFailedMessage = diracError.serialize()

				// Update the 'api_req_started' message to reflect final failure before asking user to manually retry
				const lastApiReqStartedIndex = findLastIndex(
					this.ctx.messageStateHandler.getDiracMessages(),
					(m) => m.say === "api_req_started",
				)
				if (lastApiReqStartedIndex !== -1) {
					const diracMessages = this.ctx.messageStateHandler.getDiracMessages()
					const currentApiReqInfo: DiracApiReqInfo = JSON.parse(diracMessages[lastApiReqStartedIndex].text || "{}")
					delete currentApiReqInfo.retryStatus

					await this.ctx.messageStateHandler.updateDiracMessage(lastApiReqStartedIndex, {
						text: JSON.stringify({
							...currentApiReqInfo, // Spread the modified info (with retryStatus removed)
							// cancelReason: "retries_exhausted", // Indicate that automatic retries failed
							streamingFailedMessage,
						} satisfies DiracApiReqInfo),
					})
					// this.ctx.ask will trigger postStateToWebview, so this change should be picked up.
				}

				const isAuthError = diracError.isErrorType(DiracErrorType.Auth)

				// Check if this is a Dirac provider insufficient credits error - don't auto-retry these
				const isDiracProviderInsufficientCredits = (() => {
					if (providerId !== "dirac") {
						return false
					}
					try {
						const parsedError = DiracError.transform(error, model.id, providerId)
						return parsedError.isErrorType(DiracErrorType.Balance)
					} catch {
						return false
					}
				})()

				// ailiance-agent fork: skip auto-retry for permanent 4xx client
				// errors. These cannot be fixed by retrying the same request
				// (e.g. a 400 "model does not support tools" from Ollama, a 404
				// "model not found", a 422 unprocessable). Retrying burns 3×
				// tokens + ~14 s of exponential backoff for a guaranteed
				// failure. The agent loop catches the error and surfaces it to
				// the user with the recommended override (use a different
				// --model, or disable tools).
				const isPermanentClientError = (() => {
					const status = error?.status
					if (typeof status !== "number") return false
					// 408 (timeout) and 429 (rate limit) are transient — they
					// are NOT in this list and stay retryable via the existing
					// path.
					return status === 400 || status === 404 || status === 422 || status === 501
				})()

				let response: DiracAskResponse
				// Skip auto-retry for: insufficient credits, auth errors, or
				// permanent client errors.
				if (
					!isDiracProviderInsufficientCredits &&
					!isAuthError &&
					!isPermanentClientError &&
					this.taskState.autoRetryAttempts < 3
				) {
					// Auto-retry enabled with max 3 attempts: automatically approve the retry
					this.taskState.autoRetryAttempts++

					// Calculate delay: 2s, 4s, 8s
					const delay = 2000 * 2 ** (this.taskState.autoRetryAttempts - 1)

					await updateApiReqMsg({
						partial: true,
						messageStateHandler: this.ctx.messageStateHandler,
						lastApiReqIndex: lastApiReqStartedIndex,
						inputTokens: 0,
						reasoningTokens: 0,
						outputTokens: 0,
						cacheWriteTokens: 0,
						cacheReadTokens: 0,
						totalCost: undefined,
						api: this.ctx.api,
						cancelReason: "streaming_failed",
						streamingFailedMessage,
					})
					await this.ctx.messageStateHandler.saveDiracMessagesAndUpdateHistory()
					await this.ctx.postStateToWebview()

					response = "yesButtonClicked"
					await this.ctx.say(
						"error_retry",
						JSON.stringify({
							attempt: this.taskState.autoRetryAttempts,
							maxAttempts: 3,
							delaySeconds: delay / 1000,
							errorMessage: streamingFailedMessage,
						}),
					)

					// Clear streamingFailedMessage now that error_retry contains it
					// This prevents showing the error in both ErrorRow and error_retry
					const autoRetryApiReqIndex = findLastIndex(
						this.ctx.messageStateHandler.getDiracMessages(),
						(m) => m.say === "api_req_started",
					)
					if (autoRetryApiReqIndex !== -1) {
						const diracMessages = this.ctx.messageStateHandler.getDiracMessages()
						const currentApiReqInfo: DiracApiReqInfo = JSON.parse(diracMessages[autoRetryApiReqIndex].text || "{}")
						delete currentApiReqInfo.streamingFailedMessage
						await this.ctx.messageStateHandler.updateDiracMessage(autoRetryApiReqIndex, {
							text: JSON.stringify(currentApiReqInfo),
						})
					}

					await setTimeoutPromise(delay)
				} else {
					// Show error_retry with failed flag to indicate all retries exhausted (but not for insufficient credits)
					if (!isDiracProviderInsufficientCredits && !isAuthError) {
						// For permanent client errors, mark attempt=1 to signal
						// "fail-fast, no retries attempted" so the UI does not
						// claim 3 retries were tried.
						const finalAttempt = isPermanentClientError
							? this.taskState.autoRetryAttempts + 1
							: 3
						await this.ctx.say(
							"error_retry",
							JSON.stringify({
								attempt: finalAttempt,
								maxAttempts: 3,
								delaySeconds: 0,
								failed: true, // Special flag to indicate retries exhausted
								errorMessage: streamingFailedMessage,
								permanent: isPermanentClientError || undefined,
							}),
						)
					}
					const askResult = await this.ctx.ask("api_req_failed", streamingFailedMessage)
					response = askResult.response
					if (response === "yesButtonClicked") {
						this.taskState.autoRetryAttempts = 0
					}
				}

				if (response !== "yesButtonClicked") {
					// this will never happen since if noButtonClicked, we will clear current task, aborting this instance
					throw new Error("API request failed")
				}

				// Clear streamingFailedMessage when user manually retries
				const manualRetryApiReqIndex = findLastIndex(
					this.ctx.messageStateHandler.getDiracMessages(),
					(m) => m.say === "api_req_started",
				)
				if (manualRetryApiReqIndex !== -1) {
					const diracMessages = this.ctx.messageStateHandler.getDiracMessages()
					const currentApiReqInfo: DiracApiReqInfo = JSON.parse(diracMessages[manualRetryApiReqIndex].text || "{}")
					delete currentApiReqInfo.streamingFailedMessage
					await this.ctx.messageStateHandler.updateDiracMessage(manualRetryApiReqIndex, {
						text: JSON.stringify(currentApiReqInfo),
					})
				}

				await this.ctx.say("api_req_retried")

				// Reset the automatic retry flag so the request can proceed
				this.taskState.didAutomaticallyRetryFailedApiRequest = false
			}
			// delegate generator output from the recursive call
			yield* this.attempt(previousApiReqIndex, shouldCompact)
			return
		}

		// no error, so we can continue to yield all remaining chunks
		// (needs to be placed outside of try/catch since it we want caller to handle errors not with api_req_failed as that is reserved for first chunk failures only)
		// this delegates to another generator or iterable object. In this case, it's saying "yield all remaining values from this iterator". This effectively passes along all subsequent chunks from the original stream.
		yield* iterator
	}

	/**
	 * Write prompt metadata artifacts for debugging.
	 * Moved from Task to keep Task facade lean.
	 */
	async writePromptMetadataArtifacts(params: {
		systemPrompt: string
		providerInfo: ReturnType<ApiRequestHandlerContext["getCurrentProviderInfo"]>
		tools?: any[]
		fullHistory?: any[]
		deletedRange?: [number, number]
	}): Promise<void> {
		const enabledSetting = this.ctx.stateManager.getGlobalSettingsKey("writePromptMetadataEnabled")
		const enabledFlag = process.env.DIRAC_WRITE_PROMPT_ARTIFACTS?.toLowerCase()
		const enabled =
			enabledSetting ||
			enabledFlag === "1" ||
			enabledFlag === "true" ||
			enabledFlag === "yes" ||
			process.env.IS_DEV === "true"
		if (!enabled) {
			return
		}

		try {
			const configuredDir =
				process.env.DIRAC_PROMPT_ARTIFACT_DIR?.trim() ||
				this.ctx.stateManager.getGlobalSettingsKey("writePromptMetadataDirectory")?.trim()
			const artifactDir = configuredDir
				? path.isAbsolute(configuredDir)
					? configuredDir
					: path.resolve(this.ctx.cwd, configuredDir)
				: path.resolve(this.ctx.cwd, ".dirac-prompt-artifacts")

			await fs.mkdir(artifactDir, { recursive: true })

			const debugPath = path.join(artifactDir, `task-${this.ctx.taskId}-debug.md`)

			let markdown = `## System Prompt\n\n${params.systemPrompt}\n\n`

			if (params.tools) {
				markdown += `## Tools\n\n\`\`\`json\n${JSON.stringify(params.tools, null, 2)}\n\`\`\`\n\n`
			}

			if (params.fullHistory) {
				markdown += `## Conversation History\n\n`
				const [deletedStart, deletedEnd] = params.deletedRange || [-1, -1]

				for (let i = 0; i < params.fullHistory.length; i++) {
					const message = params.fullHistory[i]
					const isTruncated = i >= deletedStart && i <= deletedEnd

					markdown += `### [${message.role.toUpperCase()}]${isTruncated ? " [TRUNCATED]" : ""}\n`

					if (typeof message.content === "string") {
						markdown += `${message.content}\n\n`
					} else if (Array.isArray(message.content)) {
						for (const block of message.content) {
							if (block.type === "text") {
								markdown += `**Text:** ${block.call_id ? `(\`call_id: ${block.call_id}\`)` : ""}\n${block.text}\n\n`
							} else if (block.type === "thinking") {
								markdown += `**Thinking:** ${block.call_id ? `(\`call_id: ${block.call_id}\`)` : ""}\n${block.thinking}\n\n`
							} else if (block.type === "redacted_thinking") {
								markdown += `**Thinking:** [Redacted] ${block.call_id ? `(\`call_id: ${block.call_id}\`)` : ""}\n\n`
							} else if (block.type === "tool_use") {
								markdown += `**Tool Use:** \`${block.name}\` (\`id: ${block.id}\`, \`call_id: ${block.call_id}\`)\n`
								markdown += `\`\`\`json\n${JSON.stringify(block.input, null, 2)}\n\`\`\`\n\n`
							} else if (block.type === "tool_result") {
								markdown += `**Tool Result:** (\`${block.tool_use_id}\`)\n`
								if (typeof block.content === "string") {
									markdown += `${block.content}\n\n`
								} else if (Array.isArray(block.content)) {
									for (const contentBlock of block.content) {
										if (contentBlock.type === "text") {
											markdown += `${contentBlock.text}\n\n`
										} else if (contentBlock.type === "image") {
											markdown += `[Image: ${contentBlock.source?.type}]\n\n`
										}
									}
								}
							} else if (block.type === "image") {
								markdown += `[Image: ${block.source?.type}]\n\n`
							}
						}
					}
					markdown += "---\n\n"
				}
			}

			await fs.writeFile(debugPath, markdown, "utf8")
		} catch (error) {
			Logger.error("Failed to write prompt metadata artifacts:", error)
		}
	}
}
