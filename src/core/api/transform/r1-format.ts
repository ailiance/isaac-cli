import { Anthropic } from "@anthropic-ai/sdk"
import OpenAI from "openai"
import { IsaacAssistantThinkingBlock, IsaacStorageMessage } from "@/shared/messages/content"

/**
 * DeepSeek Reasoner message format with reasoning_content support.
 */
export type DeepSeekReasonerMessage =
	| OpenAI.Chat.ChatCompletionSystemMessageParam
	| OpenAI.Chat.ChatCompletionUserMessageParam
	| (OpenAI.Chat.ChatCompletionAssistantMessageParam & { reasoning_content?: string })
	| OpenAI.Chat.ChatCompletionToolMessageParam
	| OpenAI.Chat.ChatCompletionFunctionMessageParam

export function addReasoningContent(
	openAiMessages: OpenAI.Chat.ChatCompletionMessageParam[],
	originalMessages: IsaacStorageMessage[],
	options?: { onlyIfToolCall?: boolean },
): DeepSeekReasonerMessage[] {

	// Extract thinking content from original messages, keyed by assistant index
	const thinkingByIndex = new Map<number, { thinking: string; hasToolCall: boolean }>()
	let assistantIdx = 0
	for (const msg of originalMessages) {
		if (msg.role === "assistant") {
			let thinking = ""
			let hasToolCall = false
			if (Array.isArray(msg.content)) {
				thinking = msg.content
					.filter((p): p is IsaacAssistantThinkingBlock => p.type === "thinking")
					.map((p) => p.thinking)
					.join("\n")
				hasToolCall = msg.content.some((p) => p.type === "tool_use")
			}
			// Always record an entry for every assistant message to ensure we can add reasoning_content field
			thinkingByIndex.set(assistantIdx, { thinking, hasToolCall })
			assistantIdx++
		}
	}

	// Add reasoning_content to assistant messages
	let aiIdx = 0
	return openAiMessages.map((msg): DeepSeekReasonerMessage => {
		if (msg.role === "assistant") {
			const data = thinkingByIndex.get(aiIdx++)
			if (data) {
				const shouldInclude = options?.onlyIfToolCall ? data.hasToolCall : true
				if (shouldInclude) {
					return { ...msg, reasoning_content: data.thinking } as DeepSeekReasonerMessage
				}
			}
			// If we are in R1 format, we should always include reasoning_content even if empty
			return { ...msg, reasoning_content: "" } as DeepSeekReasonerMessage
		}
		return msg as DeepSeekReasonerMessage
	})
}



export function convertToR1Format(
	messages: Anthropic.Messages.MessageParam[],
	supportsImages: boolean = false,
): DeepSeekReasonerMessage[] {
	return messages.reduce<DeepSeekReasonerMessage[]>((merged, message) => {
		const lastMessage = merged[merged.length - 1]
		let messageContent: string | (OpenAI.Chat.ChatCompletionContentPartText | OpenAI.Chat.ChatCompletionContentPartImage)[] =
			""
		let hasImages = false
		let thinking = ""

		if (Array.isArray(message.content)) {
			const textParts: string[] = []
			const imageParts: OpenAI.Chat.ChatCompletionContentPartImage[] = []

			message.content.forEach((part) => {
				if (part.type === "text") {
					textParts.push(part.text || "")
				}
				if (part.type === "image") {
					if (supportsImages) {
						hasImages = true
						imageParts.push({
							type: "image_url",
							image_url: {
								url:
									part.source.type === "base64"
										? `data:${part.source.media_type};base64,${part.source.data}`
										: (part.source as any).url,
							},
						})
					} else {
						textParts.push("[Image]")
					}
				}
				if ((part as any).type === "thinking") {
					thinking += (thinking ? "\n" : "") + ((part as any).thinking || "")
				}
			})

			if (hasImages) {
				const parts: (OpenAI.Chat.ChatCompletionContentPartText | OpenAI.Chat.ChatCompletionContentPartImage)[] = []
				if (textParts.length > 0) {
					parts.push({ type: "text", text: textParts.join("\n") })
				}
				parts.push(...imageParts)
				messageContent = parts
			} else {
				messageContent = textParts.join("\n")
			}
		} else {
			messageContent = message.content
		}

		// If the last message has the same role, merge the content
		if (lastMessage?.role === message.role) {
			if (typeof lastMessage.content === "string" && typeof messageContent === "string") {
				lastMessage.content += `\n${messageContent}`
			} else {
				const lastContent = Array.isArray(lastMessage.content)
					? lastMessage.content
					: [{ type: "text" as const, text: lastMessage.content || "" }]

				const newContent = Array.isArray(messageContent)
					? messageContent
					: [{ type: "text" as const, text: messageContent }]

				if (message.role === "assistant") {
					const mergedContent = [
						...lastContent,
						...newContent,
					] as OpenAI.Chat.ChatCompletionAssistantMessageParam["content"]
					lastMessage.content = mergedContent
					// Merge thinking content for assistant messages
					if (thinking) {
						const currentReasoning = (lastMessage as any).reasoning_content || ""
						;(lastMessage as any).reasoning_content = currentReasoning + (currentReasoning ? "\n" : "") + thinking
					}
				} else {
					const mergedContent = [...lastContent, ...newContent] as OpenAI.Chat.ChatCompletionUserMessageParam["content"]
					lastMessage.content = mergedContent
				}
			}
		} else {
			// Adds new message with the correct type based on role
			if (message.role === "assistant") {
				const newMessage: DeepSeekReasonerMessage = {
					role: "assistant",
					content: messageContent as OpenAI.Chat.ChatCompletionAssistantMessageParam["content"],
					reasoning_content: thinking || "",
				}
				merged.push(newMessage)
			} else {
				const newMessage: OpenAI.Chat.ChatCompletionUserMessageParam = {
					role: "user",
					content: messageContent as OpenAI.Chat.ChatCompletionUserMessageParam["content"],
				}
				merged.push(newMessage as any)
			}
		}
		return merged
	}, [])
}
