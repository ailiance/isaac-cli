import { ApiConfiguration, ModelInfo, openRouterDefaultModelId } from "@shared/api"
import { Mode } from "@shared/ExtensionMessage"
import { getModeSpecificFields } from "@/features/settings/components/utils/providerUtils"

export function validateApiConfiguration(currentMode: Mode, apiConfiguration?: ApiConfiguration): string | undefined {
	if (apiConfiguration) {
		const { apiProvider, openAiModelId, lmStudioModelId, vsCodeLmModelSelector } = getModeSpecificFields(
			apiConfiguration,
			currentMode,
		)

		switch (apiProvider) {
			case "openrouter":
				if (!apiConfiguration.openRouterApiKey) {
					return "You must provide a valid API key or choose a different provider."
				}
				break
			case "dirac":
				break
			case "openai":
				if (
					!apiConfiguration.openAiBaseUrl ||
					!apiConfiguration.openAiApiKey /* && !apiConfiguration.azureIdentity */ ||
					!openAiModelId
				) {
					return "You must provide a valid base URL, API key, and model ID."
				}
				break
			case "lmstudio":
				if (!lmStudioModelId) {
					return "You must provide a valid model ID."
				}
				break
			case "vscode-lm":
				if (!vsCodeLmModelSelector) {
					return "You must provide a valid model selector."
				}
				break
		}
	}
	return undefined
}

export function validateModelId(
	currentMode: Mode,
	apiConfiguration?: ApiConfiguration,
	openRouterModels?: Record<string, ModelInfo>,
	diracModels?: Record<string, ModelInfo>,
): string | undefined {
	if (apiConfiguration) {
		const { apiProvider, openRouterModelId, diracModelId } = getModeSpecificFields(apiConfiguration, currentMode)
		switch (apiProvider) {
			case "openrouter":
				const modelId = openRouterModelId || openRouterDefaultModelId // in case the user hasn't changed the model id, it will be undefined by default
				if (!modelId) {
					return "You must provide a model ID."
				}
				if (openRouterModels && !Object.keys(openRouterModels).includes(modelId)) {
					// even if the model list endpoint failed, extensionstatecontext will always have the default model info
					return "The model ID you provided is not available. Please choose a different model."
				}
				break
			case "dirac":
				const diracResolvedModelId = diracModelId || openRouterDefaultModelId
				if (!diracResolvedModelId) {
					return "You must provide a model ID."
				}
				if (diracModels && !Object.keys(diracModels).includes(diracResolvedModelId)) {
					return "The model ID you provided is not available. Please choose a different model."
				}
				break
		}
	}
	return undefined
}
