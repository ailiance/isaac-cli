import { ApiConfiguration, ModelInfo } from "@shared/api"
import { Mode } from "@shared/storage/types"
import { DiracStorageMessage } from "@/shared/messages/content"
import { Logger } from "@/shared/services/Logger"
import { DiracTool } from "@/shared/tools"
import { OpenAiHandler } from "./providers/openai"
import { resolveProvider } from "./providers/registry"
import "./providers/bootstrap" // side-effect: registers providers
import { ApiStream, ApiStreamUsageChunk } from "./transform/stream"

export type CommonApiHandlerOptions = {
	onRetryAttempt?: ApiConfiguration["onRetryAttempt"]
}
export interface ApiHandler {
	createMessage(systemPrompt: string, messages: DiracStorageMessage[], tools?: DiracTool[], useResponseApi?: boolean): ApiStream
	getModel(): ApiHandlerModel
	getApiStreamUsage?(): Promise<ApiStreamUsageChunk | undefined>
	abort?(): void
}

export interface ApiHandlerModel {
	id: string
	info: ModelInfo
}

export interface ApiProviderInfo {
	providerId: string
	model: ApiHandlerModel
	mode: Mode
	customPrompt?: string // "compact"
}

export interface SingleCompletionHandler {
	completePrompt(prompt: string): Promise<string>
}

function createHandlerForProvider(
	apiProvider: string | undefined,
	options: Omit<ApiConfiguration, "apiProvider">,
	mode: Mode,
): ApiHandler {
	// 1. Try registry first (providers registered via registerProvider())
	const entry = resolveProvider(apiProvider)
	if (entry) {
		return entry.factory(options, mode)
	}

	// 2. Fall through to default (openai). All supported providers self-register
	// via registerProvider() (see ./providers/bootstrap); an unknown apiProvider
	// is treated as a config error and routed to the openai handler.
	if (apiProvider !== "openai") {
		Logger.warn(
			`[buildApiHandler] Unknown apiProvider="${apiProvider}", ` + `falling back to openai. This is likely a config bug.`,
		)
		if (process.env.ISAAC_STRICT_PROVIDER === "1") {
			throw new Error(`Unknown apiProvider: ${apiProvider}`)
		}
	}
	const openAiEntry = resolveProvider("openai")
	if (openAiEntry) {
		return openAiEntry.factory(options, mode)
	}
	// Fallback if the openai registry somehow failed to register.
	return new OpenAiHandler({
		onRetryAttempt: options.onRetryAttempt,
		openAiApiKey: options.openAiApiKey,
		openAiBaseUrl: options.openAiBaseUrl,
		openAiModelId: mode === "plan" ? options.planModeOpenAiModelId : options.actModeOpenAiModelId,
		reasoningEffort: mode === "plan" ? options.planModeReasoningEffort : options.actModeReasoningEffort,
		useLocalRouter: options.useLocalRouter,
		localRouterWorkers: options.localRouterWorkers,
	})
}

export function buildApiHandler(configuration: ApiConfiguration, mode: Mode): ApiHandler {
	const { planModeApiProvider, actModeApiProvider, ...options } = configuration

	const apiProvider = mode === "plan" ? planModeApiProvider : actModeApiProvider

	// Validate thinking budget tokens against model's maxTokens to prevent API errors
	// wrapped in a try-catch for safety, but this should never throw
	try {
		const thinkingBudgetTokens = mode === "plan" ? options.planModeThinkingBudgetTokens : options.actModeThinkingBudgetTokens
		if (thinkingBudgetTokens && thinkingBudgetTokens > 0) {
			const handler = createHandlerForProvider(apiProvider, options, mode)

			const modelInfo = handler.getModel().info
			if (modelInfo?.maxTokens && modelInfo.maxTokens > 0 && thinkingBudgetTokens > modelInfo.maxTokens) {
				const clippedValue = modelInfo.maxTokens - 1
				if (mode === "plan") {
					options.planModeThinkingBudgetTokens = clippedValue
				} else {
					options.actModeThinkingBudgetTokens = clippedValue
				}
			} else {
				return handler // don't rebuild unless its necessary
			}
		}
	} catch (error) {
		Logger.error("buildApiHandler error:", error)
	}

	return createHandlerForProvider(apiProvider, options, mode)
}
