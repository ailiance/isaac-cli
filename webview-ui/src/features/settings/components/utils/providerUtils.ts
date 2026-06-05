import {
    ApiConfiguration,
    ApiProvider,
    liteLlmModelInfoSaneDefaults,
    ModelInfo,
    openAiModelInfoSaneDefaults,
    openRouterDefaultModelId,
    openRouterDefaultModelInfo,
} from "@shared/api";
import { Mode } from "@shared/ExtensionMessage";
import * as reasoningSupport from "@shared/utils/reasoning-support";

export function supportsReasoningEffortForModelId(modelId?: string, modelInfo?: ModelInfo): boolean {
	if ((modelInfo as any)?.supportsReasoningEffort) {
		return true
	}
	return reasoningSupport.supportsReasoningEffortForModel(modelId)
}

/**
 * Returns the static model list for a provider.
 * For providers with dynamic models (openrouter, dirac, etc.), returns undefined.
 * Some providers depend on configuration (qwen, zai) for region-specific models.
 */
export function getModelsForProvider(
	apiProvider: ApiProvider | undefined,
	openRouterModels: Record<string, ModelInfo>,
	diracModels: Record<string, ModelInfo> | null,
	_vercelAiGatewayModels: Record<string, ModelInfo>,
	liteLlmModels: Record<string, ModelInfo>,
	_requestyModels: Record<string, ModelInfo>,
	_groqModels: Record<string, ModelInfo>,
	_basetenModels: Record<string, ModelInfo>,
	_huggingFaceModels: Record<string, ModelInfo>,
	_aihubmixModels: Record<string, ModelInfo>,
	_githubCopilotModels: Record<string, ModelInfo> | undefined,
): Record<string, ModelInfo> {
	switch (apiProvider) {
		case "openrouter":
			return openRouterModels
		case "dirac":
			return diracModels || {}
		case "litellm":
			return liteLlmModels
		default:
			return {}
	}
}

/**
 * Interface for normalized API configuration
 */
export interface NormalizedApiConfig {
	selectedProvider: ApiProvider
	selectedModelId: string
	selectedModelInfo: ModelInfo
}

/**
 * Normalizes API configuration to ensure consistent values
 */
export function normalizeApiConfiguration(
	apiConfiguration: ApiConfiguration | undefined,
	currentMode: Mode,
): NormalizedApiConfig {
	const provider =
		(currentMode === "plan" ? apiConfiguration?.planModeApiProvider : apiConfiguration?.actModeApiProvider) || "openai"

	const modelId = currentMode === "plan" ? apiConfiguration?.planModeApiModelId : apiConfiguration?.actModeApiModelId

	const _getProviderData = (models: Record<string, ModelInfo>, defaultId: string) => {
		let selectedModelId: string
		let selectedModelInfo: ModelInfo
		if (modelId && modelId in models) {
			selectedModelId = modelId
			selectedModelInfo = models[modelId]
		} else {
			selectedModelId = defaultId
			selectedModelInfo = models[defaultId]
		}
		return {
			selectedProvider: provider,
			selectedModelId,
			selectedModelInfo,
		}
	}

	switch (provider) {
		case "openrouter":
			const openRouterModelId =
				currentMode === "plan" ? apiConfiguration?.planModeOpenRouterModelId : apiConfiguration?.actModeOpenRouterModelId
			const openRouterModelInfo =
				currentMode === "plan"
					? apiConfiguration?.planModeOpenRouterModelInfo
					: apiConfiguration?.actModeOpenRouterModelInfo
			return {
				selectedProvider: provider,
				selectedModelId: openRouterModelId || openRouterDefaultModelId,
				selectedModelInfo: openRouterModelInfo || openRouterDefaultModelInfo,
			}
		case "dirac":
			const fallbackOpenRouterModelId =
				currentMode === "plan" ? apiConfiguration?.planModeOpenRouterModelId : apiConfiguration?.actModeOpenRouterModelId
			const fallbackOpenRouterModelInfo =
				currentMode === "plan"
					? apiConfiguration?.planModeOpenRouterModelInfo
					: apiConfiguration?.actModeOpenRouterModelInfo
			const diracModelId =
				(currentMode === "plan" ? apiConfiguration?.planModeDiracModelId : apiConfiguration?.actModeDiracModelId) ||
				fallbackOpenRouterModelId ||
				openRouterDefaultModelId
			const diracModelInfo =
				(currentMode === "plan" ? apiConfiguration?.planModeDiracModelInfo : apiConfiguration?.actModeDiracModelInfo) ||
				fallbackOpenRouterModelInfo ||
				openRouterDefaultModelInfo
			return {
				selectedProvider: provider,
				selectedModelId: diracModelId,
				selectedModelInfo: diracModelInfo,
			}
		case "openai":
			const openAiModelId =
				currentMode === "plan" ? apiConfiguration?.planModeOpenAiModelId : apiConfiguration?.actModeOpenAiModelId
			const openAiModelInfo =
				currentMode === "plan" ? apiConfiguration?.planModeOpenAiModelInfo : apiConfiguration?.actModeOpenAiModelInfo
			return {
				selectedProvider: provider,
				selectedModelId: openAiModelId || "",
				selectedModelInfo: openAiModelInfo || openAiModelInfoSaneDefaults,
			}
		case "lmstudio":
			const lmStudioModelId =
				currentMode === "plan" ? apiConfiguration?.planModeLmStudioModelId : apiConfiguration?.actModeLmStudioModelId
			return {
				selectedProvider: provider,
				selectedModelId: lmStudioModelId || "",
				selectedModelInfo: {
					...openAiModelInfoSaneDefaults,
					contextWindow: Number(apiConfiguration?.lmStudioMaxTokens ?? 32768),
				},
			}
		case "vscode-lm":
			const vsCodeLmModelSelector =
				currentMode === "plan"
					? apiConfiguration?.planModeVsCodeLmModelSelector
					: apiConfiguration?.actModeVsCodeLmModelSelector
			return {
				selectedProvider: provider,
				selectedModelId: vsCodeLmModelSelector ? `${vsCodeLmModelSelector.vendor}/${vsCodeLmModelSelector.family}` : "",
				selectedModelInfo: {
					...openAiModelInfoSaneDefaults,
					supportsImages: false, // VSCode LM API currently doesn't support images
				},
			}
		case "litellm": {
			const liteLlmModelId =
				currentMode === "plan" ? apiConfiguration?.planModeLiteLlmModelId : apiConfiguration?.actModeLiteLlmModelId
			const liteLlmModelInfo =
				currentMode === "plan" ? apiConfiguration?.planModeLiteLlmModelInfo : apiConfiguration?.actModeLiteLlmModelInfo
			return {
				selectedProvider: provider,
				selectedModelId: liteLlmModelId || "",
				selectedModelInfo: liteLlmModelInfo || liteLlmModelInfoSaneDefaults,
			}
		}
		default:
			return {
				selectedProvider: provider,
				selectedModelId: modelId || openRouterDefaultModelId,
				selectedModelInfo: openRouterDefaultModelInfo,
			}
	}
}

/**
 * Gets mode-specific field values from API configuration
 * @param apiConfiguration The API configuration object
 * @param mode The current mode ("plan" or "act")
 * @returns Object containing mode-specific field values for clean destructuring
 */
export function getModeSpecificFields(apiConfiguration: ApiConfiguration | undefined, mode: Mode) {
	const apiProvider = mode === "plan" ? apiConfiguration?.planModeApiProvider : apiConfiguration?.actModeApiProvider

	return {
		apiProvider,
		apiModelId: mode === "plan" ? apiConfiguration?.planModeApiModelId : apiConfiguration?.actModeApiModelId,
		thinkingBudgetTokens:
			mode === "plan" ? apiConfiguration?.planModeThinkingBudgetTokens : apiConfiguration?.actModeThinkingBudgetTokens,
		reasoningEffort: mode === "plan" ? apiConfiguration?.planModeReasoningEffort : apiConfiguration?.actModeReasoningEffort,
		vsCodeLmModelSelector:
			mode === "plan"
				? apiConfiguration?.planModeVsCodeLmModelSelector
				: apiConfiguration?.actModeVsCodeLmModelSelector,
		awsBedrockCustomSelected:
			mode === "plan"
				? apiConfiguration?.planModeAwsBedrockCustomSelected
				: apiConfiguration?.actModeAwsBedrockCustomSelected,
		awsBedrockCustomModelBaseId:
			mode === "plan"
				? apiConfiguration?.planModeAwsBedrockCustomModelBaseId
				: apiConfiguration?.actModeAwsBedrockCustomModelBaseId,
		openRouterModelId:
			mode === "plan" ? apiConfiguration?.planModeOpenRouterModelId : apiConfiguration?.actModeOpenRouterModelId,
		openRouterModelInfo:
			mode === "plan" ? apiConfiguration?.planModeOpenRouterModelInfo : apiConfiguration?.actModeOpenRouterModelInfo,
		diracModelId: mode === "plan" ? apiConfiguration?.planModeDiracModelId : apiConfiguration?.actModeDiracModelId,
		diracModelInfo: mode === "plan" ? apiConfiguration?.planModeDiracModelInfo : apiConfiguration?.actModeDiracModelInfo,
		openAiModelId: mode === "plan" ? apiConfiguration?.planModeOpenAiModelId : apiConfiguration?.actModeOpenAiModelId,
		openAiModelInfo: mode === "plan" ? apiConfiguration?.planModeOpenAiModelInfo : apiConfiguration?.actModeOpenAiModelInfo,
		lmStudioModelId: mode === "plan" ? apiConfiguration?.planModeLmStudioModelId : apiConfiguration?.actModeLmStudioModelId,
		liteLlmModelId: mode === "plan" ? apiConfiguration?.planModeLiteLlmModelId : apiConfiguration?.actModeLiteLlmModelId,
		liteLlmModelInfo:
			mode === "plan" ? apiConfiguration?.planModeLiteLlmModelInfo : apiConfiguration?.actModeLiteLlmModelInfo,
		requestyModelId: mode === "plan" ? apiConfiguration?.planModeRequestyModelId : apiConfiguration?.actModeRequestyModelId,
		requestyModelInfo:
			mode === "plan" ? apiConfiguration?.planModeRequestyModelInfo : apiConfiguration?.actModeRequestyModelInfo,
		togetherModelId: mode === "plan" ? apiConfiguration?.planModeTogetherModelId : apiConfiguration?.actModeTogetherModelId,
		fireworksModelId:
			mode === "plan" ? apiConfiguration?.planModeFireworksModelId : apiConfiguration?.actModeFireworksModelId,
		groqModelId: mode === "plan" ? apiConfiguration?.planModeGroqModelId : apiConfiguration?.actModeGroqModelId,
		groqModelInfo: mode === "plan" ? apiConfiguration?.planModeGroqModelInfo : apiConfiguration?.actModeGroqModelInfo,
		basetenModelId: mode === "plan" ? apiConfiguration?.planModeBasetenModelId : apiConfiguration?.actModeBasetenModelId,
		basetenModelInfo: mode === "plan" ? apiConfiguration?.planModeBasetenModelInfo : apiConfiguration?.actModeBasetenModelInfo,
		huggingFaceModelId:
			mode === "plan" ? apiConfiguration?.planModeHuggingFaceModelId : apiConfiguration?.actModeHuggingFaceModelId,
		huggingFaceModelInfo:
			mode === "plan" ? apiConfiguration?.planModeHuggingFaceModelInfo : apiConfiguration?.actModeHuggingFaceModelInfo,
		huaweiCloudMaasModelId:
			mode === "plan" ? apiConfiguration?.planModeHuaweiCloudMaasModelId : apiConfiguration?.actModeHuaweiCloudMaasModelId,
		huaweiCloudMaasModelInfo:
			mode === "plan"
				? apiConfiguration?.planModeHuaweiCloudMaasModelInfo
				: apiConfiguration?.actModeHuaweiCloudMaasModelInfo,
		aihubmixModelId: mode === "plan" ? apiConfiguration?.planModeAihubmixModelId : apiConfiguration?.actModeAihubmixModelId,
		aihubmixModelInfo:
			mode === "plan" ? apiConfiguration?.planModeAihubmixModelInfo : apiConfiguration?.actModeAihubmixModelInfo,
		githubCopilotModelId:
			mode === "plan" ? apiConfiguration?.planModeGithubCopilotModelId : apiConfiguration?.actModeGithubCopilotModelId,
		githubCopilotModelInfo:
			mode === "plan" ? apiConfiguration?.planModeGithubCopilotModelInfo : apiConfiguration?.actModeGithubCopilotModelInfo,
		nousResearchModelId:
			mode === "plan" ? apiConfiguration?.planModeNousResearchModelId : apiConfiguration?.actModeNousResearchModelId,
		vercelAiGatewayModelId:
			mode === "plan" ? apiConfiguration?.planModeVercelAiGatewayModelId : apiConfiguration?.actModeVercelAiGatewayModelId,
		vercelAiGatewayModelInfo:
			mode === "plan"
				? apiConfiguration?.planModeVercelAiGatewayModelInfo
				: apiConfiguration?.actModeVercelAiGatewayModelInfo,
	}
}

/**
 * Synchronizes mode configurations by copying the source mode's settings to both modes
 * This is used when the "Use different models for Plan and Act modes" toggle is unchecked
 */
export async function syncModeConfigurations(
	apiConfiguration: ApiConfiguration | undefined,
	sourceMode: Mode,
	handleFieldsChange: (updates: Partial<ApiConfiguration>) => Promise<void>,
): Promise<void> {
	if (!apiConfiguration) {
		return
	}

	const sourceFields = getModeSpecificFields(apiConfiguration, sourceMode)
	const { apiProvider } = sourceFields

	if (!apiProvider) {
		return
	}

	// Build the complete update object with both plan and act mode fields
	const updates: Partial<ApiConfiguration> = {
		// Always sync common fields
		planModeApiProvider: sourceFields.apiProvider,
		actModeApiProvider: sourceFields.apiProvider,
		planModeThinkingBudgetTokens: sourceFields.thinkingBudgetTokens,
		actModeThinkingBudgetTokens: sourceFields.thinkingBudgetTokens,
		planModeReasoningEffort: sourceFields.reasoningEffort,
		actModeReasoningEffort: sourceFields.reasoningEffort,
	}

	// Handle provider-specific fields
	switch (apiProvider) {
		case "openrouter":
			updates.planModeOpenRouterModelId = sourceFields.openRouterModelId
			updates.actModeOpenRouterModelId = sourceFields.openRouterModelId
			updates.planModeOpenRouterModelInfo = sourceFields.openRouterModelInfo
			updates.actModeOpenRouterModelInfo = sourceFields.openRouterModelInfo
			break

		case "dirac":
			updates.planModeDiracModelId = sourceFields.diracModelId
			updates.actModeDiracModelId = sourceFields.diracModelId
			updates.planModeDiracModelInfo = sourceFields.diracModelInfo
			updates.actModeDiracModelInfo = sourceFields.diracModelInfo
			break

		case "openai":
			updates.planModeOpenAiModelId = sourceFields.openAiModelId
			updates.actModeOpenAiModelId = sourceFields.openAiModelId
			updates.planModeOpenAiModelInfo = sourceFields.openAiModelInfo
			updates.actModeOpenAiModelInfo = sourceFields.openAiModelInfo
			break

		case "lmstudio":
			updates.planModeLmStudioModelId = sourceFields.lmStudioModelId
			updates.actModeLmStudioModelId = sourceFields.lmStudioModelId
			break

		case "vscode-lm":
			updates.planModeVsCodeLmModelSelector = sourceFields.vsCodeLmModelSelector
			updates.actModeVsCodeLmModelSelector = sourceFields.vsCodeLmModelSelector
			break

		case "litellm":
			updates.planModeLiteLlmModelId = sourceFields.liteLlmModelId
			updates.actModeLiteLlmModelId = sourceFields.liteLlmModelId
			updates.planModeLiteLlmModelInfo = sourceFields.liteLlmModelInfo
			updates.actModeLiteLlmModelInfo = sourceFields.liteLlmModelInfo
			break

		// Providers that use apiProvider + apiModelId fields (e.g. vscode-lm)
		default:
			updates.planModeApiModelId = sourceFields.apiModelId
			updates.actModeApiModelId = sourceFields.apiModelId
			break
	}

	// Make the atomic update
	await handleFieldsChange(updates)
}

export { filterOpenRouterModelIds } from "@shared/utils/model-filters"

// Helper to get provider-specific configuration info and empty state guidance
export const getProviderInfo = (
	provider: ApiProvider,
	apiConfiguration: any,
	effectiveMode: "plan" | "act",
): { modelId?: string; baseUrl?: string; helpText: string } => {
	switch (provider) {
		case "lmstudio":
			return {
				modelId:
					effectiveMode === "plan" ? apiConfiguration.planModeLmStudioModelId : apiConfiguration.actModeLmStudioModelId,
				baseUrl: apiConfiguration.lmStudioBaseUrl,
				helpText: "Start LM Studio and load a model to begin",
			}
		case "litellm":
			return {
				modelId:
					effectiveMode === "plan" ? apiConfiguration.planModeLiteLlmModelId : apiConfiguration.actModeLiteLlmModelId,
				baseUrl: apiConfiguration.liteLlmBaseUrl,
				helpText: "Add your LiteLLM proxy URL in settings",
			}
		case "openai":
			return {
				modelId:
					effectiveMode === "plan" ? apiConfiguration.planModeOpenAiModelId : apiConfiguration.actModeOpenAiModelId,
				baseUrl: apiConfiguration.openAiBaseUrl,
				helpText: "Add your OpenAI API key and endpoint",
			}
		case "vscode-lm":
			return {
				modelId: undefined,
				baseUrl: undefined,
				helpText: "Select a VS Code language model from settings",
			}
		default:
			return {
				modelId: undefined,
				baseUrl: undefined,
				helpText: "Configure this provider in model settings",
			}
	}
}
