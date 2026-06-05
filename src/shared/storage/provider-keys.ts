// Map providers to their specific model ID keys

import { Secrets, SettingsKey } from "@shared/storage/state-keys"
import { ApiProvider, liteLlmDefaultModelId, openRouterDefaultModelId } from "../api"

const ProviderKeyMap: Partial<Record<ApiProvider, string>> = {
	openrouter: "OpenRouterModelId",
	dirac: "DiracModelId",
	openai: "OpenAiModelId",
	lmstudio: "LmStudioModelId",
	litellm: "LiteLlmModelId",
} as const

export const ProviderToBaseUrlKeyMap: Partial<Record<ApiProvider, SettingsKey>> = {
	openai: "openAiBaseUrl",
	litellm: "liteLlmBaseUrl",
	lmstudio: "lmStudioBaseUrl",
} as const

export const ProviderToApiKeyMap: Partial<Record<ApiProvider, keyof Secrets | (keyof Secrets)[]>> = {
	dirac: ["diracApiKey"],
	openrouter: "openRouterApiKey",
	openai: ["openAiApiKey", "openAiCompatibleCustomApiKey"],
	litellm: "liteLlmApiKey",
} as const

const ProviderDefaultModelMap: Partial<Record<ApiProvider, string>> = {
	openrouter: openRouterDefaultModelId,
	dirac: openRouterDefaultModelId,
	openai: openRouterDefaultModelId,
	lmstudio: "",
	litellm: liteLlmDefaultModelId,
} as const

/**
 * Get the provider-specific model ID key for a given provider and mode.
 * Different providers store their model IDs in different state keys.
 */
export function getProviderModelIdKey(provider: ApiProvider, mode: "act" | "plan"): SettingsKey {
	const keySuffix = ProviderKeyMap[provider]
	if (keySuffix) {
		// E.g. actModeOpenAiModelId, planModeOpenAiModelId, etc.
		return `${mode}Mode${keySuffix}` as SettingsKey
	}

	// For providers without a specific key (anthropic, gemini, bedrock, etc.),
	// they use the generic actModeApiModelId/planModeApiModelId
	return `${mode}ModeApiModelId`
}

export function getProviderDefaultModelId(provider: ApiProvider): string | null {
	return ProviderDefaultModelMap[provider] || ""
}
