import { Anthropic } from "@anthropic-ai/sdk"
import { IsaacMessageMetricsInfo, IsaacMessageModelInfo } from "./metrics"

export type IsaacPromptInputContent = string

export type IsaacMessageRole = "user" | "assistant"

export interface IsaacReasoningDetailParam {
	type: "reasoning.text" | string
	text: string
	signature: string
	format: "anthropic-claude-v1" | string
	index: number
}

interface IsaacSharedMessageParam {
	// The id of the response that the block belongs to
	call_id?: string
}

export const REASONING_DETAILS_PROVIDERS = ["dirac", "openrouter"]

/**
 * An extension of Anthropic.MessageParam that includes Isaac-specific fields: reasoning_details.
 * This ensures backward compatibility where the messages were stored in Anthropic format with additional
 * fields unknown to Anthropic SDK.
 */
export interface IsaacTextContentBlock extends Anthropic.TextBlockParam, IsaacSharedMessageParam {
	// reasoning_details only exists for providers listed in REASONING_DETAILS_PROVIDERS
	reasoning_details?: IsaacReasoningDetailParam[]
	// Thought Signature associates with Gemini
	signature?: string
}

export interface IsaacImageContentBlock extends Anthropic.ImageBlockParam, IsaacSharedMessageParam {}

export interface IsaacDocumentContentBlock extends Anthropic.DocumentBlockParam, IsaacSharedMessageParam {}

export interface IsaacUserToolResultContentBlock extends Anthropic.ToolResultBlockParam, IsaacSharedMessageParam {}

/**
 * Assistant only content types
 */
export interface IsaacAssistantToolUseBlock extends Anthropic.ToolUseBlockParam, IsaacSharedMessageParam {
	// reasoning_details only exists for providers listed in REASONING_DETAILS_PROVIDERS
	reasoning_details?: unknown[] | IsaacReasoningDetailParam[]
	// Thought Signature associates with Gemini
	signature?: string
}

export interface IsaacAssistantThinkingBlock extends Anthropic.ThinkingBlock, IsaacSharedMessageParam {
	// The summary items returned by OpenAI response API
	// The reasoning details that will be moved to the text block when finalized
	summary?: unknown[] | IsaacReasoningDetailParam[]
}

export interface IsaacAssistantRedactedThinkingBlock extends Anthropic.RedactedThinkingBlockParam, IsaacSharedMessageParam {}

export type IsaacToolResponseContent = IsaacPromptInputContent | Array<IsaacTextContentBlock | IsaacImageContentBlock>

export type IsaacUserContent =
	| IsaacTextContentBlock
	| IsaacImageContentBlock
	| IsaacDocumentContentBlock
	| IsaacUserToolResultContentBlock

export type IsaacAssistantContent =
	| IsaacTextContentBlock
	| IsaacImageContentBlock
	| IsaacDocumentContentBlock
	| IsaacAssistantToolUseBlock
	| IsaacAssistantThinkingBlock
	| IsaacAssistantRedactedThinkingBlock

export type IsaacContent = IsaacUserContent | IsaacAssistantContent | Anthropic.ContentBlockParam

/**
 * An extension of Anthropic.MessageParam that includes Isaac-specific fields.
 * This ensures backward compatibility where the messages were stored in Anthropic format,
 * while allowing for additional metadata specific to Isaac to avoid unknown fields in Anthropic SDK
 * added by ignoring the type checking for those fields.
 */
export interface IsaacStorageMessage extends Anthropic.MessageParam {
	/**
	 * Response ID associated with this message
	 */
	id?: string
	role: IsaacMessageRole
	content: IsaacPromptInputContent | IsaacContent[]
	/**
	 * NOTE: model information used when generating this message.
	 * Internal use for message conversion only.
	 * MUST be removed before sending message to any LLM provider.
	 */
	modelInfo?: IsaacMessageModelInfo
	/**
	 * LLM operational and performance metrics for this message
	 * Includes token counts, costs.
	 */
	metrics?: IsaacMessageMetricsInfo
	/**
	 * Timestamp of when the message was created
	 */
	ts?: number
}

/**
 * Converts IsaacStorageMessage to Anthropic.MessageParam by removing Isaac-specific fields
 * Isaac-specific fields (like modelInfo, reasoning_details) are properly omitted.
 */
export function convertIsaacStorageToAnthropicMessage(
	diracMessage: IsaacStorageMessage,
	provider = "anthropic",
): Anthropic.MessageParam {
	const { role, content } = diracMessage

	// Handle string content - fast path
	if (typeof content === "string") {
		return { role, content }
	}

	// Removes thinking block that has no signature (invalid thinking block that's incompatible with Anthropic API)
	const filteredContent = content.filter((b) => b.type !== "thinking" || !!b.signature)

	// Handle array content - strip Isaac-specific fields for non-reasoning_details providers
	const shouldCleanContent = !REASONING_DETAILS_PROVIDERS.includes(provider)
	const cleanedContent = shouldCleanContent
		? filteredContent.map(cleanContentBlock)
		: (filteredContent as Anthropic.MessageParam["content"])

	return { role, content: cleanedContent }
}

/**
 * Clean a content block by removing Isaac-specific fields and returning only Anthropic-compatible fields
 */
export function cleanContentBlock(block: IsaacContent): Anthropic.ContentBlock {
	// Fast path: if no Isaac-specific fields exist, return as-is
	const hasIsaacFields =
		"reasoning_details" in block ||
		"call_id" in block ||
		"summary" in block ||
		(block.type !== "thinking" && "signature" in block)

	if (!hasIsaacFields) {
		return block as Anthropic.ContentBlock
	}

	// Removes Isaac-specific fields & the signature field that's added for Gemini.
	const { reasoning_details, call_id, summary, ...rest } = block as any

	// Remove signature from non-thinking blocks that were added for Gemini
	if (block.type !== "thinking" && rest.signature) {
		rest.signature = undefined
	}

	return rest satisfies Anthropic.ContentBlock
}
