import type { ApiConfiguration, ApiProvider } from "@shared/api"
import PROVIDERS from "@shared/providers/providers.json"
import type { RemoteConfigFields } from "@shared/storage/state-keys"

/**
 * Returns a list of API providers that are configured (have required credentials/settings)
 * Based on validation logic from validate.ts
 */
export function getConfiguredProviders(
	remoteConfig: Partial<RemoteConfigFields> | undefined,
	apiConfiguration: ApiConfiguration | undefined,
): ApiProvider[] {
	// if (remoteConfig?.remoteConfiguredProviders?.length) {
	// 	return remoteConfig.remoteConfiguredProviders
	// }

	const configured: ApiProvider[] = []

	if (!apiConfiguration) {
		return ["dirac"] // Isaac is always available
	}

	// Isaac - always available (uses account-based auth)
	configured.push("dirac")

	// OpenRouter - requires API key
	if (apiConfiguration.openRouterApiKey) {
		configured.push("openrouter")
	}

	// OpenAI Compatible - requires base URL and API key, OR has model configured
	if (
		(apiConfiguration.openAiBaseUrl && apiConfiguration.openAiApiKey) ||
		apiConfiguration.planModeOpenAiModelId ||
		apiConfiguration.actModeOpenAiModelId
	) {
		configured.push("openai")
	}

	// LM Studio - local provider, check base URL OR model configured
	if (apiConfiguration.lmStudioBaseUrl || apiConfiguration.planModeLmStudioModelId || apiConfiguration.actModeLmStudioModelId) {
		configured.push("lmstudio")
	}

	// LiteLLM - check base URL, API key OR model configured
	if (
		apiConfiguration.liteLlmBaseUrl ||
		apiConfiguration.liteLlmApiKey ||
		apiConfiguration.planModeLiteLlmModelId ||
		apiConfiguration.actModeLiteLlmModelId
	) {
		configured.push("litellm")
	}

	// VSCode LM - always potentially available
	configured.push("vscode-lm")

	return configured
}

/**
 * Get provider display label from provider value
 * Uses the canonical providers.json as source of truth
 */
export function getProviderLabel(provider: ApiProvider): string {
	const providerEntry = PROVIDERS.list.find((p) => p.value === provider)
	return providerEntry?.label || provider
}
