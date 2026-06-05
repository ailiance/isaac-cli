import { ApiFormat } from "./proto/isaac/models"
import type { ApiHandlerSettings } from "./storage/state-keys"

/**
 * Strips the OpenRouter preset suffix from a model ID.
 * Example: "anthropic/claude-3.5-sonnet@preset/my-preset" -> "anthropic/claude-3.5-sonnet"
 * Example: "@preset/my-preset" -> ""
 */
export function stripOpenRouterPreset(modelId: string): string {
	const index = modelId.indexOf("@preset/")
	if (index !== -1) {
		return modelId.substring(0, index)
	}
	return modelId
}

export type ApiProvider = "openrouter" | "openai" | "lmstudio" | "vscode-lm" | "isaac" | "litellm"

export const ALL_PROVIDERS: ApiProvider[] = ["openrouter", "openai", "lmstudio", "vscode-lm", "isaac", "litellm"]

export const DEFAULT_API_PROVIDER = "openai" as ApiProvider

export interface ApiHandlerOptions extends Partial<ApiHandlerSettings> {
	ulid?: string // Used to identify the task in API requests
	geminiSearchEnabled?: boolean

	onRetryAttempt?: (attempt: number, maxRetries: number, delay: number, error: any) => void // Callback function
}

export type ApiConfiguration = ApiHandlerOptions

// Models

interface PriceTier {
	tokenLimit: number // Upper limit (inclusive) of *input* tokens for this price. Use Infinity for the highest tier.
	price: number // Price per million tokens for this tier.
}

export interface ModelInfo {
	name?: string
	maxTokens?: number
	contextWindow?: number
	supportsImages?: boolean
	supportsPromptCache: boolean // this value is hardcoded for now
	supportsReasoning?: boolean // Whether the model supports reasoning/thinking mode
	supportsAdaptiveThinking?: boolean // Whether the model supports adaptive thinking mode (Anthropic)
	inputPrice?: number // Keep for non-tiered input models
	outputPrice?: number // Keep for non-tiered output models
	thinkingConfig?: {
		maxBudget?: number // Max allowed thinking budget tokens
		outputPrice?: number // Output price per million tokens when budget > 0
		outputPriceTiers?: PriceTier[] // Optional: Tiered output price when budget > 0
		geminiThinkingLevel?: "low" | "high" // Optional: preset thinking level
		supportsThinkingLevel?: boolean // Whether the model supports thinking level (low/high)
	}
	supportsGlobalEndpoint?: boolean // Whether the model supports a global endpoint with Vertex AI
	cacheWritesPrice?: number
	cacheReadsPrice?: number
	description?: string
	tiers?: {
		contextWindow: number
		inputPrice?: number
		outputPrice?: number
		cacheWritesPrice?: number
		cacheReadsPrice?: number
	}[]
	temperature?: number
	supportsTools?: boolean

	supportsStrictTools?: boolean

	apiFormat?: ApiFormat // The API format used by this model
}

export interface OpenAiCompatibleModelInfo extends ModelInfo {
	temperature?: number
	isR1FormatRequired?: boolean
	systemRole?: "developer" | "system"
	supportsReasoningEffort?: boolean
	supportsStreaming?: boolean
}

export interface OcaModelInfo extends OpenAiCompatibleModelInfo {
	modelName: string
	surveyId?: string
	banner?: string
	surveyContent?: string
	supportsReasoning?: boolean
	reasoningEffortOptions: string[]
}

export const CLAUDE_SONNET_1M_SUFFIX = ":1m"
export const CLAUDE_SONNET_1M_TIERS = [
	{
		contextWindow: 200000,
		inputPrice: 3.0,
		outputPrice: 15,
		cacheWritesPrice: 3.75,
		cacheReadsPrice: 0.3,
	},
	{
		contextWindow: Number.MAX_SAFE_INTEGER, // storing infinity in vs storage is not possible, it converts to 'null', which causes crash in webview ModelInfoView
		inputPrice: 6,
		outputPrice: 22.5,
		cacheWritesPrice: 7.5,
		cacheReadsPrice: 0.6,
	},
]
export const CLAUDE_OPUS_1M_TIERS = [
	{
		contextWindow: 200000,
		inputPrice: 5.0,
		outputPrice: 25,
		cacheWritesPrice: 6.25,
		cacheReadsPrice: 0.5,
	},
	{
		contextWindow: Number.MAX_SAFE_INTEGER,
		inputPrice: 10,
		outputPrice: 37.5,
		cacheWritesPrice: 12.5,
		cacheReadsPrice: 1.0,
	},
]

export const GPT_5_5_TIERS = [
	{
		contextWindow: 272_000,
		inputPrice: 5.0,
		outputPrice: 30.0,
		cacheReadsPrice: 0.5,
	},
	{
		contextWindow: Number.MAX_SAFE_INTEGER,
		inputPrice: 10.0,
		outputPrice: 45.0,
		cacheReadsPrice: 1.0,
	},
]

export const GPT_5_4_TIERS = [
	{
		contextWindow: 272_000,
		inputPrice: 2.5,
		outputPrice: 15.0,
		cacheReadsPrice: 0.25,
	},
	{
		contextWindow: Number.MAX_SAFE_INTEGER,
		inputPrice: 5.0,
		outputPrice: 22.5,
		cacheReadsPrice: 0.5,
	},
]

export const GPT_5_4_PRO_TIERS = [
	{
		contextWindow: 272_000,
		inputPrice: 30.0,
		outputPrice: 180.0,
	},
	{
		contextWindow: Number.MAX_SAFE_INTEGER,
		inputPrice: 60.0,
		outputPrice: 270.0,
	},
]

export const ANTHROPIC_MIN_THINKING_BUDGET = 1_024
export const ANTHROPIC_MAX_THINKING_BUDGET = 6_000

/**
 * Helper to determine if an Anthropic model supports adaptive thinking.
 * Default opt-in pattern: If it's a known "old" model (<= 4.5), use enabled.
 * Otherwise (>= 4.6 or unknown future model), use adaptive.
 */
export function isAnthropicAdaptiveThinkingSupported(modelId: string, info?: ModelInfo): boolean {
	if (info?.supportsAdaptiveThinking !== undefined) {
		return info.supportsAdaptiveThinking
	}

	const id = modelId.toLowerCase()
	// Check if it's an Anthropic model
	const isAnthropic = id.startsWith("claude-") || id.includes("anthropic.claude-") || id.startsWith("anthropic/")

	if (!isAnthropic) {
		return false
	}

	// Default opt-in pattern:
	// If it's a known "old" model (<= 4.5), use enabled.
	// Otherwise (>= 4.6 or unknown future model), use adaptive.

	const versionMatch = id.match(/claude-(\d+)[.-](\d+)/)
	if (versionMatch) {
		const major = Number.parseInt(versionMatch[1])
		const minor = Number.parseInt(versionMatch[2])
		if (major < 4 || (major === 4 && minor <= 5)) {
			return false // Old model
		}
	}

	// Also check for specific old models that might not match the regex perfectly
	if (id.includes("claude-3")) {
		return false
	}

	return true // Default to adaptive for everything else
}

// OpenRouter
// https://openrouter.ai/models?order=newest&supported_parameters=tools
export const openRouterDefaultModelId = "anthropic/claude-sonnet-4.5" // will always exist in openRouterModels
export const openRouterClaudeSonnet41mModelId = `anthropic/claude-sonnet-4${CLAUDE_SONNET_1M_SUFFIX}`
export const openRouterClaudeSonnet451mModelId = `anthropic/claude-sonnet-4.5${CLAUDE_SONNET_1M_SUFFIX}`
export const openRouterClaudeSonnet461mModelId = `anthropic/claude-sonnet-4.6${CLAUDE_SONNET_1M_SUFFIX}`
export const openRouterClaudeOpus461mModelId = `anthropic/claude-opus-4.6${CLAUDE_SONNET_1M_SUFFIX}`
export const openRouterDefaultModelInfo: ModelInfo = {
	maxTokens: 64_000,
	contextWindow: 200_000,
	supportsImages: true,
	supportsPromptCache: true,
	inputPrice: 3.0,
	outputPrice: 15.0,
	cacheWritesPrice: 3.75,
	cacheReadsPrice: 0.3,
	description:
		"Claude Sonnet 4.5 delivers superior intelligence across coding, agentic search, and AI agent capabilities. It's a powerful choice for agentic coding, and can complete tasks across the entire software development lifecycle, from initial planning to bug fixes, maintenance to large refactors. It offers strong performance in both planning and solving for complex coding tasks, making it an ideal choice to power end-to-end software development processes.\n\nRead more in the [blog post here](https://www.anthropic.com/claude/sonnet)",
}

export const OPENROUTER_PROVIDER_PREFERENCES: Record<string, { order: string[]; allow_fallbacks: boolean }> = {
	// Exacto Providers
	"moonshotai/kimi-k2:exacto": {
		order: ["groq", "moonshotai"],
		allow_fallbacks: false,
	},
	"z-ai/glm-4.6:exacto": {
		order: ["z-ai", "novita"],
		allow_fallbacks: false,
	},
	"deepseek/deepseek-v3.1-terminus:exacto": {
		order: ["novita", "deepinfra"],
		allow_fallbacks: false,
	},
	"qwen/qwen3-coder:exacto": {
		order: ["baseten"],
		allow_fallbacks: false,
	},
	"openai/gpt-oss-120b:exacto": {
		order: ["groq", "novita"],
		allow_fallbacks: false,
	},

	// Normal Providers
	"moonshotai/kimi-k2": {
		order: ["groq", "fireworks", "baseten", "parasail", "novita", "deepinfra"],
		allow_fallbacks: false,
	},
	"qwen/qwen3-coder": {
		order: ["nebius", "baseten", "fireworks", "together", "deepinfra"],
		allow_fallbacks: false,
	},
	"qwen/qwen3-235b-a22b-thinking-2507": {
		order: ["nebius", "baseten", "fireworks", "together", "deepinfra"],
		allow_fallbacks: false,
	},
	"qwen/qwen3-235b-a22b-07-25": {
		order: ["nebius", "baseten", "fireworks", "together", "deepinfra"],
		allow_fallbacks: false,
	},
	"qwen/qwen3-30b-a3b-thinking-2507": {
		order: ["nebius", "baseten", "fireworks", "together", "deepinfra"],
		allow_fallbacks: false,
	},
	"qwen/qwen3-30b-a3b-instruct-2507": {
		order: ["nebius", "baseten", "fireworks", "together", "deepinfra"],
		allow_fallbacks: false,
	},
	"qwen/qwen3-30b-a3b:free": {
		order: ["nebius", "baseten", "fireworks", "together", "deepinfra"],
		allow_fallbacks: false,
	},
	"qwen/qwen3-next-80b-a3b-thinking": {
		order: ["nebius", "baseten", "fireworks", "together", "deepinfra"],
		allow_fallbacks: false,
	},
	"qwen/qwen3-next-80b-a3b-instruct": {
		order: ["nebius", "baseten", "fireworks", "together", "deepinfra"],
		allow_fallbacks: false,
	},
	"qwen/qwen3-max": {
		order: ["nebius", "baseten", "fireworks", "together", "deepinfra"],
		allow_fallbacks: false,
	},
	"deepseek/deepseek-v3.2-exp": {
		order: ["deepseek", "novita", "fireworks", "nebius"],
		allow_fallbacks: false,
	},
	"z-ai/glm-4.6": {
		order: ["z-ai", "novita", "baseten", "fireworks", "chutes"],
		allow_fallbacks: false,
	},
	"z-ai/glm-4.5v": {
		order: ["z-ai", "novita", "baseten", "fireworks", "chutes"],
		allow_fallbacks: false,
	},
	"z-ai/glm-4.5": {
		order: ["z-ai", "novita", "baseten", "fireworks", "chutes"],
		allow_fallbacks: false,
	},
	"z-ai/glm-4.5-air": {
		order: ["z-ai", "novita", "baseten", "fireworks", "chutes"],
		allow_fallbacks: false,
	},
}

export const openAiModelInfoSaneDefaults: OpenAiCompatibleModelInfo = {
	maxTokens: -1,
	contextWindow: 256_000,
	supportsImages: true,
	supportsPromptCache: false,
	supportsTools: true,
	supportsReasoning: true,
	supportsStrictTools: false,
	isR1FormatRequired: false,
	inputPrice: 0,
	outputPrice: 0,
	temperature: 0,
}

// Azure OpenAI
// https://learn.microsoft.com/en-us/azure/ai-services/openai/api-version-deprecation
// https://learn.microsoft.com/en-us/azure/ai-services/openai/reference#api-specs
export const azureOpenAiDefaultApiVersion = "2024-08-01-preview"

// LiteLLM
// https://docs.litellm.ai/docs/
export type LiteLLMModelId = string
export const liteLlmDefaultModelId = "anthropic/claude-4-6-sonnet"
export interface LiteLLMModelInfo extends ModelInfo {
	temperature?: number
}

export const liteLlmModelInfoSaneDefaults: LiteLLMModelInfo = {
	maxTokens: -1,
	contextWindow: 128_000,
	supportsImages: true,
	supportsPromptCache: true,
	inputPrice: 0,
	supportsTools: true,
	outputPrice: 0,
	cacheWritesPrice: 0,
	cacheReadsPrice: 0,
	temperature: 0,
}

/**
 * Central registry of all hardcoded model maps.
 * This is used as the single source of truth for model-to-provider mapping.
 */
export const ALL_MODEL_MAPS: [ApiProvider, Record<string, ModelInfo>][] = []

/**
 * Gets the provider for a given model ID based on hardcoded model maps.
 */
export function getProviderForModel(modelId: string): ApiProvider | undefined {
	const baseModelId = stripOpenRouterPreset(modelId)
	for (const [provider, map] of ALL_MODEL_MAPS) {
		if (baseModelId && baseModelId in map) {
			return provider as ApiProvider
		}
	}
	return undefined
}

/**
 * Gets the model info for a given model ID based on hardcoded model maps.
 */
export function getModelInfo(modelId: string): ModelInfo | undefined {
	const baseModelId = stripOpenRouterPreset(modelId)
	for (const [_, map] of ALL_MODEL_MAPS) {
		if (baseModelId && baseModelId in map) {
			return map[baseModelId]
		}
	}
	return undefined
}
