import { setTimeout as setTimeoutPromise } from "node:timers/promises"
import { sendPartialMessageEvent } from "@core/controller/ui/subscribeToPartialMessage"
import { formatResponse } from "@core/prompts/responses"
import { processFilesIntoText } from "@integrations/misc/extract-text"
import { showSystemNotification } from "@integrations/notifications"
import { ErrorService } from "@services/error"
import { telemetryService } from "@services/telemetry"
import { findLastIndex } from "@shared/array"
import { DiracApiReqCancelReason } from "@shared/ExtensionMessage"
import { DiracContent, DiracUserContent } from "@shared/messages/content"
import { DiracMessageModelInfo } from "@shared/messages/metrics"
import { convertDiracMessageToProto } from "@shared/proto-conversions/dirac-message"
import { Logger } from "@shared/services/Logger"
import { Session } from "@shared/services/Session"
import { isLocalModel } from "@utils/model-utils"
import pWaitFor from "p-wait-for"
import { StreamChunkCoordinator } from "./StreamChunkCoordinator"
import { TaskState } from "./TaskState"
import type { AgentLoopRunnerContext } from "./types/agent-loop-runner"
import { updateApiReqMsg } from "./utils"

/**
 * AgentLoopRunner encapsulates the ReAct agent loop extracted from Task.
 *
 * Sprint 2 PR3 — step 3A: initiateLoop extracted from Task.initiateTaskLoop.
 * Sprint 2 PR3 — step 3B: makeRequest extracted from Task.recursivelyMakeDiracRequests.
 * PR6 — narrowed from Task to AgentLoopRunnerContext interface.
 */
export class AgentLoopRunner {
	private readonly taskState: TaskState

	constructor(private readonly ctx: AgentLoopRunnerContext) {
		this.taskState = ctx.taskState
	}

	/**
	 * Drive the outer while-loop that calls makeRequest
	 * until the task completes or is aborted.
	 */
	async initiateLoop(userContent: DiracContent[]): Promise<void> {
		let nextUserContent = userContent
		let includeFileDetails = true
		while (!this.taskState.abort) {
			const didEndLoop = await this.makeRequest(nextUserContent, includeFileDetails)
			includeFileDetails = false
			if (didEndLoop) {
				break
			}
			nextUserContent = [
				{
					type: "text",
					text: formatResponse.noToolsUsed(this.taskState.useNativeToolCalls),
				},
			]
			this.taskState.consecutiveMistakeCount++
		}
	}

	/**
	 * Execute one ReAct iteration: stream an API request, process chunks,
	 * handle tool calls, and recurse with tool results.
	 */
	async makeRequest(userContent: DiracContent[], includeFileDetails = false): Promise<boolean> {
		if (this.taskState.abort) {
			throw new Error("Task instance aborted")
		}

		const { model, providerId, customPrompt, mode } = this.ctx.getCurrentProviderInfo()
		if (providerId && model.id) {
			try {
				await this.ctx.modelContextTracker.recordModelUsage(providerId, model.id, mode)
			} catch {}
		}

		const modelInfo: DiracMessageModelInfo = {
			modelId: model.id,
			providerId: providerId,
			mode: mode,
		}

		const mistakeResult = await this.handleMistakeLimitReached(userContent)
		if (mistakeResult.didEndLoop) {
			return true
		}
		userContent = mistakeResult.userContent

		const previousApiReqIndex = findLastIndex(
			this.ctx.messageStateHandler.getDiracMessages(),
			(m) => m.say === "api_req_started",
		)
		const isFirstRequest =
			this.ctx.messageStateHandler.getDiracMessages().filter((m) => m.say === "api_req_started").length === 0
		await this.ctx.initializeCheckpoints(isFirstRequest)

		const useCompactPrompt = customPrompt === "compact" && isLocalModel(this.ctx.getCurrentProviderInfo())
		const shouldCompact = await this.ctx.determineContextCompaction(previousApiReqIndex)

		const apiRequestData = await this.ctx.prepareApiRequest({
			userContent,
			shouldCompact,
			includeFileDetails,
			useCompactPrompt,
			previousApiReqIndex,
			isFirstRequest,
			providerId,
			modelId: model.id,
			mode: modelInfo.mode,
		})
		this.taskState.didSwitchToActMode = false // Reset after use
		userContent = apiRequestData.userContent
		const lastApiReqIndex = apiRequestData.lastApiReqIndex

		if (apiRequestData.isDirectResponse && apiRequestData.directResponseText) {
			await this.ctx.say("text", apiRequestData.directResponseText)
			return true
		}

		try {
			const taskMetrics: {
				cacheWriteTokens: number
				cacheReadTokens: number
				inputTokens: number
				outputTokens: number
				totalCost: number | undefined
				reasoningTokens: number
			} = {
				cacheWriteTokens: 0,
				cacheReadTokens: 0,
				inputTokens: 0,
				outputTokens: 0,
				reasoningTokens: 0,
				totalCost: undefined,
			}
			let didFinalizeApiReqMsg = false
			let usageChunkSideEffectsQueue = Promise.resolve()

			const updateApiReqMsgFromMetrics = async (
				cancelReason?: DiracApiReqCancelReason,
				streamingFailedMessage?: string,
			) => {
				const modelInfo = this.ctx.api.getModel().info
				const contextWindow = modelInfo.contextWindow
				const totalTokens =
					taskMetrics.inputTokens +
					taskMetrics.outputTokens +
					(taskMetrics.cacheWriteTokens || 0) +
					(taskMetrics.cacheReadTokens || 0)
				const contextUsagePercentage = contextWindow ? Math.round((totalTokens / contextWindow) * 100) : undefined
				await updateApiReqMsg({
					partial: true,
					messageStateHandler: this.ctx.messageStateHandler,
					lastApiReqIndex,
					inputTokens: taskMetrics.inputTokens,
					outputTokens: taskMetrics.outputTokens,
					reasoningTokens: taskMetrics.reasoningTokens,
					cacheWriteTokens: taskMetrics.cacheWriteTokens,
					cacheReadTokens: taskMetrics.cacheReadTokens,
					api: this.ctx.api,
					totalCost: taskMetrics.totalCost,
					cancelReason,
					streamingFailedMessage,
					contextWindow,
					contextUsagePercentage,
				})
			}

			const queueUsageChunkSideEffects = (
				usageInputTokens: number,
				usageOutputTokens: number,
				chunkOptions?: { cacheWriteTokens?: number; cacheReadTokens?: number; totalCost?: number; stopReason?: string },
			) => {
				usageChunkSideEffectsQueue = usageChunkSideEffectsQueue
					.then(async () => {
						if (didFinalizeApiReqMsg || this.taskState.abort) {
							return
						}

						await updateApiReqMsgFromMetrics()
						await this.ctx.postStateToWebview()
						await telemetryService.captureTokenUsage(
							this.ctx.ulid,
							usageInputTokens,
							usageOutputTokens,
							providerId,
							model.id,
							chunkOptions,
						)
					})
					.catch((error) => {
						Logger.debug(`[Task ${this.ctx.taskId}] Failed to process usage chunk side effects: ${error}`)
					})
			}

			const finalizeApiReqMsg = async (cancelReason?: DiracApiReqCancelReason, streamingFailedMessage?: string) => {
				didFinalizeApiReqMsg = true
				await usageChunkSideEffectsQueue
				await updateApiReqMsgFromMetrics(cancelReason, streamingFailedMessage)
				const lastApiReqIndex = findLastIndex(
					this.ctx.messageStateHandler.getDiracMessages(),
					(m) => m.say === "api_req_started",
				)
				if (lastApiReqIndex !== -1) {
					await this.ctx.messageStateHandler.updateDiracMessage(lastApiReqIndex, { partial: false })
				}
			}

			const abortStream = async (cancelReason: DiracApiReqCancelReason, streamingFailedMessage?: string) => {
				Session.get().finalizeRequest()

				if (this.ctx.diffViewProvider.isEditing) {
					await this.ctx.diffViewProvider.revertChanges()
				}

				const diracMessages = this.ctx.messageStateHandler.getDiracMessages()
				diracMessages.forEach((msg) => {
					if (msg.partial) {
						msg.partial = false
						Logger.log("updating partial message", msg)
					}
				})
				await finalizeApiReqMsg(cancelReason, streamingFailedMessage)
				await this.ctx.messageStateHandler.saveDiracMessagesAndUpdateHistory()

				await this.ctx.messageStateHandler.addToApiConversationHistory({
					role: "assistant",
					content: [
						{
							type: "text",
							text:
								assistantMessage +
								`\n\n[${
									cancelReason === "streaming_failed"
										? "Response interrupted by API Error"
										: "Response interrupted by user"
								}]`,
						},
					],
					modelInfo,
					metrics: {
						tokens: {
							prompt: taskMetrics.inputTokens,
							completion: taskMetrics.outputTokens,
							cached: (taskMetrics.cacheWriteTokens ?? 0) + (taskMetrics.cacheReadTokens ?? 0),
						},
						cost: taskMetrics.totalCost,
					},
					ts: Date.now(),
				})

				telemetryService.captureConversationTurnEvent(
					this.ctx.ulid,
					providerId,
					modelInfo.modelId,
					"assistant",
					modelInfo.mode,
					undefined,
					this.taskState.useNativeToolCalls,
				)

				this.taskState.didFinishAbortingStream = true
			}

			// reset streaming state
			this.taskState.currentStreamingContentIndex = 0
			this.taskState.assistantMessageContent = []
			this.taskState.didCompleteReadingStream = false
			this.taskState.userMessageContent = []
			this.taskState.userMessageContentReady = false
			this.taskState.didRejectTool = false
			this.taskState.didAlreadyUseTool = false
			this.taskState.presentAssistantMessageLocked = false
			this.taskState.presentAssistantMessageHasPendingUpdates = false
			this.taskState.didAutomaticallyRetryFailedApiRequest = false
			await this.ctx.diffViewProvider.reset()
			this.ctx.streamHandler.reset()
			this.taskState.toolUseIdMap.clear()

			const { toolUseHandler, reasonsHandler } = this.ctx.streamHandler.getHandlers()
			// ailiance-agent fork: tracing — measure latency of every API roundtrip
			const plannerStartedAt = Date.now()
			const stream = this.ctx.attemptApiRequest(previousApiReqIndex, shouldCompact)

			let assistantMessageId = ""
			let assistantMessage = ""
			let assistantTextOnly = ""
			let assistantTextSignature: string | undefined

			this.taskState.isStreaming = true
			let didReceiveUsageChunk = false
			let stopReason: string | undefined
			let didFinalizeReasoningForUi = false

			const finalizePendingReasoningMessage = async (thinking: string): Promise<boolean> => {
				const pendingReasoningIndex = findLastIndex(
					this.ctx.messageStateHandler.getDiracMessages(),
					(message) => message.type === "say" && message.say === "reasoning" && message.partial === true,
				)

				if (pendingReasoningIndex === -1) {
					return false
				}

				await this.ctx.messageStateHandler.updateDiracMessage(pendingReasoningIndex, {
					text: thinking,
					partial: false,
				})
				const completedReasoning = this.ctx.messageStateHandler.getDiracMessages()[pendingReasoningIndex]
				if (completedReasoning) {
					await sendPartialMessageEvent(convertDiracMessageToProto(completedReasoning))
					await this.ctx.postStateToWebview()
				}
				return true
			}

			Session.get().startApiCall()
			let streamCoordinator: StreamChunkCoordinator | undefined

			try {
				streamCoordinator = new StreamChunkCoordinator(stream, {
					onUsageChunk: (chunk) => {
						this.ctx.streamHandler.setRequestId(chunk.id)
						didReceiveUsageChunk = true
						taskMetrics.inputTokens += chunk.inputTokens
						taskMetrics.outputTokens += chunk.outputTokens
						taskMetrics.reasoningTokens += chunk.reasoningTokens ?? chunk.thoughtsTokenCount ?? 0
						taskMetrics.cacheWriteTokens += chunk.cacheWriteTokens ?? 0
						taskMetrics.cacheReadTokens += chunk.cacheReadTokens ?? 0
						taskMetrics.totalCost = chunk.totalCost ?? taskMetrics.totalCost
						stopReason = chunk.stopReason ?? stopReason
						queueUsageChunkSideEffects(chunk.inputTokens, chunk.outputTokens, {
							cacheWriteTokens: chunk.cacheWriteTokens,
							cacheReadTokens: chunk.cacheReadTokens,
							totalCost: chunk.totalCost,
							stopReason: chunk.stopReason,
						})
					},
				})

				let shouldInterruptStream = false

				while (true) {
					const chunk = await streamCoordinator.nextChunk()
					if (chunk) {
					}
					if (!chunk) {
						break
					}
					if (!this.taskState.taskFirstTokenTimeMs) {
						this.taskState.taskFirstTokenTimeMs = Math.max(0, Date.now() - this.taskState.taskStartTimeMs)
					}

					switch (chunk.type) {
						case "reasoning": {
							const details = chunk.details ? (Array.isArray(chunk.details) ? chunk.details : [chunk.details]) : []
							this.ctx.streamHandler.processReasoningDelta({
								id: chunk.id,
								reasoning: chunk.reasoning,
								signature: chunk.signature,
								details,
								redacted_data: chunk.redacted_data,
							})

							if (!this.taskState.abort) {
								const thinkingBlock = reasonsHandler.getCurrentReasoning()
								if (thinkingBlock?.thinking && chunk.reasoning && assistantMessage.length === 0) {
									await this.ctx.say("reasoning", thinkingBlock.thinking, undefined, undefined, true)
								}
							}
							break
						}
						case "tool_calls": {
							this.ctx.streamHandler.processToolUseDelta(
								{
									id: chunk.tool_call.function?.id,
									type: "tool_use",
									name: chunk.tool_call.function?.name,
									input: chunk.tool_call.function?.arguments,
									signature: chunk?.signature,
								},
								chunk.tool_call.call_id,
							)
							if (chunk.tool_call.function?.id && chunk.tool_call.call_id) {
								this.taskState.toolUseIdMap.set(chunk.tool_call.call_id, chunk.tool_call.function.id)
							}

							await this.ctx.processNativeToolCalls(assistantTextOnly, toolUseHandler.getPartialToolUsesAsContent())
							break
						}
						case "text": {
							const currentReasoning = reasonsHandler.getCurrentReasoning()
							if (currentReasoning?.thinking && !didFinalizeReasoningForUi) {
								const finalizedReasoning = await finalizePendingReasoningMessage(currentReasoning.thinking)
								if (finalizedReasoning) {
									didFinalizeReasoningForUi = true
								}
							}
							if (chunk.signature) {
								assistantTextSignature = chunk.signature
							}
							this.ctx.streamHandler.processTextDelta(chunk)

							if (chunk.id) {
								assistantMessageId = chunk.id
							}
							assistantMessage += chunk.text
							assistantTextOnly += chunk.text
							const prevLength = this.taskState.assistantMessageContent.length

							await this.ctx.processNativeToolCalls(assistantTextOnly, toolUseHandler.getPartialToolUsesAsContent())

							if (this.taskState.assistantMessageContent.length > prevLength) {
								this.taskState.userMessageContentReady = false
							}
							break
						}
					}

					await this.ctx
						.presentAssistantMessage()
						.catch((error) => Logger.debug(`[Task] Failed to present message: ${error}`))

					if (this.taskState.abort) {
						this.ctx.api.abort?.()
						if (!this.taskState.abandoned) {
							await abortStream("user_cancelled")
						}
						shouldInterruptStream = true
						break
					}

					if (this.taskState.didRejectTool) {
						assistantMessage += "\n\n[Response interrupted by user feedback]"
						shouldInterruptStream = true
						break
					}
				}

				if (shouldInterruptStream) {
					await streamCoordinator.stop()
				} else {
					await streamCoordinator.waitForCompletion()
				}
				await usageChunkSideEffectsQueue

				// ailiance-agent fork: tracing — record this planner roundtrip.
				try {
					this.ctx.toolExecutor.recordPlannerTurn(assistantMessage, Date.now() - plannerStartedAt)
				} catch (_err) {
					// non-fatal
				}

				if (!this.taskState.abort && !didFinalizeReasoningForUi) {
					const finalReasoning = reasonsHandler.getCurrentReasoning()
					if (finalReasoning?.thinking) {
						const finalizedPendingReasoning = await finalizePendingReasoningMessage(finalReasoning.thinking)
						if (!finalizedPendingReasoning) {
							await this.ctx.say("reasoning", finalReasoning.thinking, undefined, undefined, false)
						}
						didFinalizeReasoningForUi = true
					}
				}
			} catch (error) {
				await streamCoordinator?.stop()
				if (!this.taskState.abandoned) {
					const diracError = ErrorService.get().toDiracError(error, this.ctx.api.getModel().id)
					const errorMessage = diracError.serialize()
					// ailiance-agent fork: tracing — record the failed roundtrip
					try {
						this.ctx.toolExecutor.recordPlannerTurn(assistantMessage, Date.now() - plannerStartedAt, [errorMessage])
					} catch (_err) {
						// non-fatal
					}
					if (this.taskState.autoRetryAttempts < 3) {
						this.taskState.autoRetryAttempts++

						const delay = 2000 * 2 ** (this.taskState.autoRetryAttempts - 1)

						await this.ctx.say(
							"error_retry",
							JSON.stringify({
								attempt: this.taskState.autoRetryAttempts,
								maxAttempts: 3,
								delaySeconds: delay / 1000,
								errorMessage,
							}),
						)

						setTimeoutPromise(delay).then(async () => {
							if (this.ctx.controller.task) {
								this.ctx.controller.task.taskState.autoRetryAttempts = this.taskState.autoRetryAttempts
								await this.ctx.controller.task.handleWebviewAskResponse("yesButtonClicked", "", [])
							}
						})
					} else if (this.taskState.autoRetryAttempts >= 3) {
						await this.ctx.say(
							"error_retry",
							JSON.stringify({
								attempt: 3,
								maxAttempts: 3,
								delaySeconds: 0,
								failed: true,
								errorMessage,
							}),
						)
					}

					// ailiance-agent fork: tracing close hook
					this.ctx.abortTask("error", 1)
					await abortStream("streaming_failed", errorMessage)
					await this.ctx.reinitExistingTaskFromId(this.ctx.taskId)
				}
			} finally {
				this.taskState.isStreaming = false
				Session.get().endApiCall()
			}

			if (!didReceiveUsageChunk) {
				const apiStreamUsage = await this.ctx.api.getApiStreamUsage?.()
				if (apiStreamUsage) {
					taskMetrics.inputTokens += apiStreamUsage.inputTokens
					taskMetrics.outputTokens += apiStreamUsage.outputTokens
					taskMetrics.cacheWriteTokens += apiStreamUsage.cacheWriteTokens ?? 0
					taskMetrics.cacheReadTokens += apiStreamUsage.cacheReadTokens ?? 0
					taskMetrics.reasoningTokens +=
						(apiStreamUsage as any).reasoningTokens ?? (apiStreamUsage as any).thoughtsTokenCount ?? 0
					taskMetrics.totalCost = apiStreamUsage.totalCost ?? taskMetrics.totalCost
					queueUsageChunkSideEffects(apiStreamUsage.inputTokens, apiStreamUsage.outputTokens, {
						cacheWriteTokens: apiStreamUsage.cacheWriteTokens,
						cacheReadTokens: apiStreamUsage.cacheReadTokens,
						totalCost: apiStreamUsage.totalCost,
						stopReason: apiStreamUsage.stopReason,
					})
				}
			}

			await finalizeApiReqMsg()
			await this.ctx.messageStateHandler.saveDiracMessagesAndUpdateHistory()
			await this.ctx.postStateToWebview()

			if (this.taskState.abort) {
				throw new Error("Dirac instance aborted")
			}

			const assistantHasContent = await this.ctx.processAssistantResponse({
				assistantMessage,
				assistantTextOnly,
				assistantTextSignature,
				assistantMessageId,
				providerId,
				modelId: model.id,
				mode: modelInfo.mode,
				taskMetrics,
				modelInfo,
				toolUseHandler,
			})

			let didEndLoop = false
			if (assistantHasContent) {
				await pWaitFor(() => this.taskState.userMessageContentReady)
				await this.ctx.checkpointManager?.saveCheckpoint()

				const didToolUse = this.taskState.assistantMessageContent.some((block) => block.type === "tool_use")
				const hitTokenLimit = stopReason === "MAX_TOKENS" || stopReason === "max_tokens" || stopReason === "length"

				if (!didToolUse) {
					this.taskState.userMessageContent.push({
						type: "text",
						text: hitTokenLimit
							? "You have reached the output token limit. Please continue your response from where you left off. If you were in the middle of a tool call, start over with that tool call. If you were finished, call attempt_completion."
							: formatResponse.noToolsUsed(this.taskState.useNativeToolCalls),
					})
					// ailiance-agent fork: faster fail when the response carried
					// zero output tokens. Some MLX backends (Mistral-Medium-128B
					// observed 2026-05-12) accept a tools[] request but reply
					// with finish_reason=stop and empty content — neither a
					// tool_call nor visible text. Without this guard, the agent
					// loop burns 5 full iterations (~5 × 3 retries × 30 s)
					// before hitting maxConsecutiveMistakes. Counting empty
					// responses double moves the abort to 3 iterations, which
					// is still enough for transient flakes (e.g. one stalled
					// streaming chunk recoverable on retry) but bounds the
					// damage when the backend is structurally incompatible.
					const emptyOutput = !taskMetrics.outputTokens || taskMetrics.outputTokens === 0
					this.taskState.consecutiveMistakeCount += emptyOutput ? 2 : 1
				}

				this.taskState.autoRetryAttempts = 0
				const recDidEndLoop = await this.makeRequest(this.taskState.userMessageContent)
				didEndLoop = recDidEndLoop
			} else {
				return await this.ctx.handleEmptyAssistantResponse({
					modelInfo,
					taskMetrics,
					providerId,
					model,
				})
			}

			return didEndLoop
		} catch (error) {
			// ailiance-agent fork: do NOT swallow uncaught exceptions as
			// "task finished successfully". Previously this catch returned
			// true unconditionally, masking programming bugs, network
			// panics, JSON parse errors and silently terminating tasks
			// as if they had completed. Re-throw so initiateLoop and
			// the controller can surface the failure.
			Logger.error(`[Task ${this.ctx.taskId}] makeRequest aborted by unhandled error: ${error}`)
			throw error
		}
	}

	async handleMistakeLimitReached(userContent: DiracContent[]): Promise<{ didEndLoop: boolean; userContent: DiracContent[] }> {
		if (this.taskState.consecutiveMistakeCount < this.ctx.stateManager.getGlobalSettingsKey("maxConsecutiveMistakes")) {
			return { didEndLoop: false, userContent }
		}

		// In yolo mode, don't wait for user input - fail the task
		if (this.ctx.stateManager.getGlobalSettingsKey("yoloModeToggled")) {
			const errorMessage =
				`[YOLO MODE] Task failed: Too many consecutive mistakes ` +
				`(${this.taskState.consecutiveMistakeCount}). ` +
				`The model may not be capable enough for this task. ` +
				`Consider using a more capable model.`
			await this.ctx.say("error", errorMessage)
			return { didEndLoop: true, userContent }
		}

		const autoApprovalSettings = this.ctx.stateManager.getGlobalSettingsKey("autoApprovalSettings")
		if (autoApprovalSettings.enableNotifications) {
			showSystemNotification({
				subtitle: "Error",
				message: "Dirac is having trouble. Would you like to continue the task?",
			})
		}

		const { response, text, images, files } = await this.ctx.ask(
			"mistake_limit_reached",
			`Tool use failure. Can potentially be mitigated with some user guidance (e.g. "Try breaking down the task into smaller steps").`,
		)

		if (response === "messageResponse") {
			await this.ctx.say("user_feedback", text, images, files)

			const feedbackUserContent: DiracUserContent[] = []
			feedbackUserContent.push({
				type: "text",
				text: formatResponse.tooManyMistakes(text),
			})

			if (images && images.length > 0) {
				feedbackUserContent.push(...formatResponse.imageBlocks(images))
			}

			let fileContentString = ""
			if (files && files.length > 0) {
				fileContentString = await processFilesIntoText(files)
			}

			if (fileContentString) {
				feedbackUserContent.push({
					type: "text",
					text: fileContentString,
				})
			}

			userContent = feedbackUserContent
		}

		this.taskState.consecutiveMistakeCount = 0
		this.taskState.autoRetryAttempts = 0
		return { didEndLoop: false, userContent }
	}
}
