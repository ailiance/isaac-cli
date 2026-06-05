import { setTimeout as setTimeoutPromise } from "node:timers/promises"
import { parseAssistantMessageV2, ToolUse } from "@core/assistant-message"
import { sendPartialMessageEvent } from "@core/controller/ui/subscribeToPartialMessage"
import { telemetryService } from "@services/telemetry"
import { convertIsaacMessageToProto } from "@shared/proto-conversions/dirac-message"
import { Session } from "@shared/services/Session"
import { IsaacDefaultTool, READ_ONLY_TOOLS, toolUseNames } from "@shared/tools"
import { IsaacAskResponse } from "@shared/WebviewMessage"
import cloneDeep from "clone-deep"
import {
	canonicaliseToolName,
	hasHallucinatedToolXml,
	parseHallucinatedToolXml,
} from "@/utils/parse-hallucinated-tool-xml"
import { ResponseProcessorDependencies } from "./types/response-processor"

// Build the canonical tool-name set once at module load. ResponseProcessor
// is instantiated per-task; the set is constant for the process lifetime.
const KNOWN_TOOL_NAMES: ReadonlySet<string> = new Set(toolUseNames as readonly string[])

export class ResponseProcessor {
	constructor(private dependencies: ResponseProcessorDependencies) {}

	public async processAssistantResponse(params: {
		assistantMessage: string
		assistantTextOnly: string
		assistantTextSignature?: string
		assistantMessageId: string
		providerId: string
		modelId: string
		mode: string
		taskMetrics: {
			inputTokens: number
			outputTokens: number
			cacheWriteTokens: number
			cacheReadTokens: number
			totalCost?: number
		}
		modelInfo: any
		toolUseHandler: any
	}): Promise<boolean> {
		const { reasonsHandler } = this.dependencies.streamHandler.getHandlers()
		const assistantContent = this.dependencies.streamHandler.getOrderedBlocks()
		const assistantHasContent =

			assistantContent.length > 0 || params.assistantMessage.length > 0 || this.dependencies.taskState.useNativeToolCalls

		if (assistantHasContent) {
			telemetryService.captureConversationTurnEvent(
				this.dependencies.ulid,
				params.providerId,
				params.modelId,
				"assistant",
				params.mode as any,
				params.taskMetrics,
				this.dependencies.taskState.useNativeToolCalls,
			)

			const requestId = this.dependencies.streamHandler.requestId

			if (assistantContent.length > 0) {
				await this.dependencies.messageStateHandler.addToApiConversationHistory({
					role: "assistant",
					content: assistantContent,
					modelInfo: params.modelInfo,
					id: requestId,
					metrics: {
						tokens: {
							prompt: params.taskMetrics.inputTokens,
							completion: params.taskMetrics.outputTokens,
							cached: (params.taskMetrics.cacheWriteTokens ?? 0) + (params.taskMetrics.cacheReadTokens ?? 0),
						},
						cost: params.taskMetrics.totalCost,
					},
					ts: Date.now(),
				})
			}
		}

		this.dependencies.taskState.didCompleteReadingStream = true

		const partialToolBlocks = params.toolUseHandler
			.getPartialToolUsesAsContent()
			?.map((block: any) => ({ ...block, partial: false }))
		await this.processNativeToolCalls(params.assistantTextOnly, partialToolBlocks, true)

		await this.presentAssistantMessage()

		return assistantHasContent
	}

	public async handleEmptyAssistantResponse(params: {
		modelInfo: any
		taskMetrics: {
			inputTokens: number
			outputTokens: number
			cacheWriteTokens: number
			cacheReadTokens: number
			totalCost?: number
		}
		providerId: string
		model: any
	}): Promise<boolean> {
		const reqId = this.dependencies.getApiRequestIdSafe()

		telemetryService.captureProviderApiError({
			ulid: this.dependencies.ulid,
			model: params.model.id,
			provider: params.providerId,
			errorMessage: "empty_assistant_message",
			requestId: reqId,
			isNativeToolCall: this.dependencies.taskState.useNativeToolCalls,
		})

		const baseErrorMessage =
			"Invalid API Response: The provider returned an empty or unparsable response. This is a provider-side issue where the model failed to generate valid output or returned tool calls that Isaac cannot process. Retrying the request may help resolve this issue."
		const errorText = reqId ? `${baseErrorMessage} (Request ID: ${reqId})` : baseErrorMessage

		await this.dependencies.say("error", errorText)
		await this.dependencies.messageStateHandler.addToApiConversationHistory({
			role: "assistant",
			content: [
				{
					type: "text",
					text: "Failure: I did not provide a response.",
				},
			],
			modelInfo: params.modelInfo,
			id: this.dependencies.streamHandler.requestId,
			metrics: {
				tokens: {
					prompt: params.taskMetrics.inputTokens,
					completion: params.taskMetrics.outputTokens,
					cached: (params.taskMetrics.cacheWriteTokens ?? 0) + (params.taskMetrics.cacheReadTokens ?? 0),
				},
				cost: params.taskMetrics.totalCost,
			},
			ts: Date.now(),
		})

		let response: IsaacAskResponse
		const noResponseErrorMessage = "No assistant message was received. Would you like to retry the request?"

		if (this.dependencies.taskState.autoRetryAttempts < 3) {
			this.dependencies.taskState.autoRetryAttempts++
			const delay = 2000 * 2 ** (this.dependencies.taskState.autoRetryAttempts - 1)
			response = "yesButtonClicked"
			await this.dependencies.say(
				"error_retry",
				JSON.stringify({
					attempt: this.dependencies.taskState.autoRetryAttempts,
					maxAttempts: 3,
					delaySeconds: delay / 1000,
					errorMessage: noResponseErrorMessage,
				}),
			)
			await setTimeoutPromise(delay)
		} else {
			await this.dependencies.say(
				"error_retry",
				JSON.stringify({
					attempt: 3,
					maxAttempts: 3,
					delaySeconds: 0,
					failed: true,
					errorMessage: noResponseErrorMessage,
				}),
			)
			const askResult = await this.dependencies.ask("api_req_failed", noResponseErrorMessage)
			response = askResult.response
			if (response === "yesButtonClicked") {
				this.dependencies.taskState.autoRetryAttempts = 0
			}
		}

		if (response === "yesButtonClicked") {
			return false
		}

		return true
	}

	public async presentAssistantMessage() {
		if (this.dependencies.taskState.abort) {
			throw new Error("Isaac instance aborted")
		}

		if (this.dependencies.taskState.presentAssistantMessageLocked) {
			this.dependencies.taskState.presentAssistantMessageHasPendingUpdates = true
			return
		}

		this.dependencies.taskState.presentAssistantMessageLocked = true
		this.dependencies.taskState.presentAssistantMessageHasPendingUpdates = false

		let block: any
		try {
			if (
				this.dependencies.taskState.currentStreamingContentIndex >=
				this.dependencies.taskState.assistantMessageContent.length
			) {
				if (this.dependencies.taskState.didCompleteReadingStream) {
					this.dependencies.taskState.userMessageContentReady = true
				}
				return
			}

			block = cloneDeep(
				this.dependencies.taskState.assistantMessageContent[this.dependencies.taskState.currentStreamingContentIndex],
			)
			switch (block.type) {
				case "text": {
					if (this.dependencies.taskState.didRejectTool) {
						break
					}
					let content = block.content
					if (content) {
						content = content.replace(/<function_calls>\s?/g, "")
						content = content.replace(/\s?<\/function_calls>/g, "")
						// Hallucinated XML tool dispatch (v0.7).
						// Only act on complete text blocks (block.partial === false)
						// so we never dispatch on a half-streamed parameter value.
						// The parser is best-effort: when it extracts a known tool
						// (validated against IsaacDefaultTool via canonicaliseToolName),
						// we synthesize a non-native ToolUse and execute it
						// immediately. Residual prose is preserved so the user can
						// still see explanation text the model emitted alongside the
						// hallucinated call. Root-cause fix lives in the gateway
						// (FC_FORCE_ROUTE_PORT redirects tools[] to a native-FC
						// worker); this dispatch path is defense-in-depth for the
						// non-FC backends that still slip through.
						//
						// Double-dispatch guard (v0.8.1): when the stream parsed
						// at least one native tool_use block, the model has
						// already expressed its tool intent through the OpenAI
						// FC channel — dispatching the XML duplicate would run
						// the same tool twice. Skip XML extraction in that
						// case; the native path will handle the call.
						const hasNativeToolBlock =
							this.dependencies.taskState.useNativeToolCalls &&
							this.dependencies.taskState.assistantMessageContent.some(
								(b: any) => b.type === "tool_use",
							)
						if (!block.partial && !hasNativeToolBlock && hasHallucinatedToolXml(content)) {
							const parsed = parseHallucinatedToolXml(content)
							if (parsed.calls.length > 0) {
								// Replace content with residual prose so the say()
								// call below shows only the non-tool narration.
								content = parsed.residualText
								for (const call of parsed.calls) {
									const canonical = canonicaliseToolName(call.name, KNOWN_TOOL_NAMES)
									if (!canonical) {
										// Skip unknown tool name. The caller will see
										// it surface as text in residualText if the
										// model included a description outside the
										// XML block.
										continue
									}
									const synthetic: ToolUse = {
										type: "tool_use",
										name: canonical as IsaacDefaultTool,
										params: call.params,
										partial: false,
										isNativeToolCall: false,
									}
									if (this.dependencies.taskState.initialCheckpointCommitPromise) {
										if (!READ_ONLY_TOOLS.includes(synthetic.name as any)) {
											await this.dependencies.taskState.initialCheckpointCommitPromise
											this.dependencies.taskState.initialCheckpointCommitPromise = undefined
										}
									}
									await this.dependencies.toolExecutor.executeTool(synthetic)
								}
							}
						}

						const lastOpenBracketIndex = content.lastIndexOf("<")
						if (lastOpenBracketIndex !== -1) {
							const possibleTag = content.slice(lastOpenBracketIndex)
							const hasCloseBracket = possibleTag.includes(">")
							if (!hasCloseBracket) {
								let tagContent: string
								if (possibleTag.startsWith("</")) {
									tagContent = possibleTag.slice(2).trim()
								} else {
									tagContent = possibleTag.slice(1).trim()
								}
								const isLikelyTagName = /^[a-zA-Z_]+$/.test(tagContent)
								const isOpeningOrClosing = possibleTag === "<" || possibleTag === "</"
								if (isOpeningOrClosing || isLikelyTagName) {
									content = content.slice(0, lastOpenBracketIndex).trim()
								}
							}
						}
					}

					if (!block.partial) {
						const match = content?.trimEnd().match(/```[a-zA-Z0-9_-]+$/)
						if (match) {
							const matchLength = match[0].length
							content = content.trimEnd().slice(0, -matchLength)
						}
					}

					await this.dependencies.say("text", content, undefined, undefined, block.partial)
					break
				}
				case "reasoning": {
					await this.dependencies.say("reasoning", block.reasoning, undefined, undefined, block.partial)
					break
				}
				case "tool_use":
					if (this.dependencies.taskState.initialCheckpointCommitPromise) {
						if (!READ_ONLY_TOOLS.includes(block.name as any)) {
							await this.dependencies.taskState.initialCheckpointCommitPromise
							this.dependencies.taskState.initialCheckpointCommitPromise = undefined
						}
					}
					await this.dependencies.toolExecutor.executeTool(block)
					if (block.call_id) {
						Session.get().updateToolCall(block.call_id, block.name)
					}
					break
			}
		} finally {
			this.dependencies.taskState.presentAssistantMessageLocked = false
		}

		if (block && (!block.partial || this.dependencies.taskState.didRejectTool)) {
			if (
				this.dependencies.taskState.currentStreamingContentIndex ===
				this.dependencies.taskState.assistantMessageContent.length - 1
			) {
				this.dependencies.taskState.userMessageContentReady = true
			}
			this.dependencies.taskState.currentStreamingContentIndex++
			if (
				this.dependencies.taskState.currentStreamingContentIndex <
				this.dependencies.taskState.assistantMessageContent.length
			) {
				await this.presentAssistantMessage()
				return
			}
		}

		if (this.dependencies.taskState.presentAssistantMessageHasPendingUpdates) {
			await this.presentAssistantMessage()
		}
	}

	public async processNativeToolCalls(
		assistantTextOnly: string,
		toolBlocks: ToolUse[] = [],
		isStreamComplete: boolean = false,
	) {
		const prevLength = this.dependencies.taskState.assistantMessageContent.length

		const parsedBlocks = parseAssistantMessageV2(assistantTextOnly)
		if (isStreamComplete) {
			parsedBlocks.forEach((block) => {
				block.partial = false
			})
		}

		const diracMessages = this.dependencies.messageStateHandler.getIsaacMessages()
		
		// Find the last partial say message that is text or reasoning
		let lastPartialMessageIndex = -1
		for (let i = diracMessages.length - 1; i >= 0; i--) {
			const msg = diracMessages[i]
			if (msg.partial && msg.type === "say" && (msg.say === "text" || msg.say === "reasoning")) {
				lastPartialMessageIndex = i
				break
			}
		}

		if (lastPartialMessageIndex !== -1) {
			const lastMessage = diracMessages[lastPartialMessageIndex]
			const correspondingBlock = [...parsedBlocks].reverse().find((b) => b.type === lastMessage.say)
			if (correspondingBlock) {
				const content =
					correspondingBlock.type === "text"
						? correspondingBlock.content
						: correspondingBlock.type === "reasoning"
							? correspondingBlock.reasoning
							: ""
				lastMessage.text = content
				if (correspondingBlock.partial) {
					lastMessage.partial = true
				}
				await this.dependencies.messageStateHandler.saveIsaacMessagesAndUpdateHistory()
				const protoMessage = convertIsaacMessageToProto(lastMessage)
				await sendPartialMessageEvent(protoMessage)
			}
		}

		this.dependencies.taskState.assistantMessageContent = [...parsedBlocks, ...toolBlocks]

		if (toolBlocks.length > 0) {
			this.dependencies.taskState.currentStreamingContentIndex = parsedBlocks.length
			this.dependencies.taskState.userMessageContentReady = false
		} else if (this.dependencies.taskState.assistantMessageContent.length > prevLength) {
			this.dependencies.taskState.userMessageContentReady = false
		}
	}
}
