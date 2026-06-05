/**
 * Shared utility for applying provider configuration
 * Used by both AuthView (onboarding) and SettingsPanelContent (settings)
 */

import type { ApiProvider } from "@shared/api"
import { getProviderModelIdKey, ProviderToApiKeyMap, ProviderToBaseUrlKeyMap } from "@shared/storage"
import { buildApiHandler } from "@/core/api"
import type { Controller } from "@/core/controller"
import { refreshOpenRouterModels } from "@/core/controller/models/refreshOpenRouterModels"
import { StateManager } from "@/core/storage/StateManager"
import { getDefaultModelId, getModelList } from "../components/ModelPicker"

export interface ApplyProviderConfigOptions {
	providerId: string
	apiKey?: string
	modelId?: string // Override default model
	baseUrl?: string // For OpenAI-compatible providers
	azureApiVersion?: string // For Azure OpenAI
	controller?: Controller
}

/**
 * Apply provider configuration to state and rebuild API handler if needed
 */
export async function applyProviderConfig(options: ApplyProviderConfigOptions): Promise<void> {
	const { providerId, apiKey, modelId, baseUrl, azureApiVersion, controller } = options
	const stateManager = StateManager.get()

	const config: Record<string, string> = {
		actModeApiProvider: providerId,
		planModeApiProvider: providerId,
	}

	// Add model ID (use provided, existing from state, or fall back to default)
	const actModelKey = getProviderModelIdKey(providerId as ApiProvider, "act")
	const planModelKey = getProviderModelIdKey(providerId as ApiProvider, "plan")

	const existingActModel = stateManager.getGlobalSettingsKey(actModelKey) as string
	const existingPlanModel = stateManager.getGlobalSettingsKey(planModelKey) as string

	const hasSpecificKey = actModelKey !== "actModeApiModelId"
	const validModels = getModelList(providerId)

	const isCompatible = (model: string) => {
		if (!model) return false
		if (hasSpecificKey) return true
		return validModels.includes(model)
	}

	const defaultModel = getDefaultModelId(providerId)

	const finalActModelId =
		modelId ||
		(isCompatible(existingActModel)
			? existingActModel
			: isCompatible(existingPlanModel)
				? existingPlanModel
				: defaultModel)
	const finalPlanModelId =
		modelId ||
		(isCompatible(existingPlanModel)
			? existingPlanModel
			: isCompatible(existingActModel)
				? existingActModel
				: defaultModel)

	if (finalActModelId) {
		if (actModelKey) config[actModelKey] = finalActModelId
	}
	if (finalPlanModelId) {
		if (planModelKey) config[planModelKey] = finalPlanModelId
	}

	if (finalActModelId || finalPlanModelId) {
		// Fetch model info from the provider API (not just disk cache) so headless
		// CLI auth gets correct maxTokens, thinkingConfig, etc.
		if ((providerId === "dirac" || providerId === "openrouter") && controller) {
			const openRouterModels = await refreshOpenRouterModels(controller)
			if (finalActModelId) {
				const modelInfo = openRouterModels?.[finalActModelId]
				if (modelInfo) {
					stateManager.setGlobalState("actModeOpenRouterModelInfo", modelInfo)
				}
			}
			if (finalPlanModelId) {
				const modelInfo = openRouterModels?.[finalPlanModelId]
				if (modelInfo) {
					stateManager.setGlobalState("planModeOpenRouterModelInfo", modelInfo)
				}
			}
		}
	}

	// Add API key if provided (maps to provider-specific field like anthropicApiKey, openAiApiKey, etc.)
	if (apiKey) {
		const keyField = ProviderToApiKeyMap[providerId as keyof typeof ProviderToApiKeyMap]
		if (keyField) {
			const fields = Array.isArray(keyField) ? keyField : [keyField]
			config[fields[0]] = apiKey
		}
	}

	// Add base URL if provided (for OpenAI-compatible providers)
	if (baseUrl !== undefined) {
		let normalizedBaseUrl = baseUrl.trim()
		if (normalizedBaseUrl) {
			// Normalize URL: strip trailing /chat/completions and trailing slashes
			// The OpenAI SDK appends /chat/completions automatically.
			normalizedBaseUrl = normalizedBaseUrl.replace(/\/chat\/completions\/?$/, "")
			normalizedBaseUrl = normalizedBaseUrl.replace(/\/+$/, "")
		}

		const baseUrlKey = ProviderToBaseUrlKeyMap[providerId as ApiProvider]
		if (baseUrlKey) {
			config[baseUrlKey] = normalizedBaseUrl
		} else {
			// Fallback for generic OpenAI compatible
			config.openAiBaseUrl = normalizedBaseUrl
		}
	}

	// Add Azure API version if provided
	if (azureApiVersion) {
		config.azureApiVersion = azureApiVersion
	}

	// Save via StateManager
	stateManager.setApiConfiguration(config)
	await stateManager.flushPendingState()

	// Rebuild API handler on active task if one exists
	if (controller?.task) {
		const currentMode = stateManager.getGlobalSettingsKey("mode")
		const apiConfig = stateManager.getApiConfiguration()
		controller.task.api = buildApiHandler({ ...apiConfig, ulid: controller.task.ulid }, currentMode)

	await controller?.postStateToWebview()

	}
}

