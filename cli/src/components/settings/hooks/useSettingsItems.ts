import { useMemo } from "react"
import { getProviderLabel } from "../../../utils/providers"
import { supportsReasoningEffortForModel } from "@/utils/model-utils"
import { getModelList, CUSTOM_MODEL_ID } from "../../ModelPicker"
import { usesOpenRouterModels } from "../../../utils/openrouter-models"
import { version as CLI_VERSION } from "../../../../package.json"
import { FEATURE_SETTINGS, type FeatureKey } from "../constants"
import type { ListItem, SettingsTab } from "../types"
import type { AutoApprovalSettings } from "@shared/AutoApprovalSettings"
import type { TelemetrySetting } from "@shared/TelemetrySetting"
import type { OpenaiReasoningEffort } from "@shared/storage/types"

interface UseSettingsItemsProps {
	currentTab: SettingsTab
	provider: string
	actModelId: string
	planModelId: string
	separateModels: boolean
	actThinkingEnabled: boolean
	planThinkingEnabled: boolean
	actReasoningEffort: OpenaiReasoningEffort
	planReasoningEffort: OpenaiReasoningEffort
	autoApproveSettings: AutoApprovalSettings
	features: Record<FeatureKey, boolean>
	preferredLanguage: string
	telemetry: TelemetrySetting
	openAiHeaders: Record<string, string>
	openAiCodexIsAuthenticated: boolean
	openAiCodexEmail?: string
	githubIsAuthenticated: boolean
	githubEmail?: string
	openRouterModels?: string[]
}

export function useSettingsItems({
	currentTab,
	provider,
	actModelId,
	planModelId,
	separateModels,
	actThinkingEnabled,
	planThinkingEnabled,
	actReasoningEffort,
	planReasoningEffort,
	autoApproveSettings,
	openRouterModels,
	features,
	preferredLanguage,
	telemetry,
	openAiHeaders,
	openAiCodexIsAuthenticated,
	openAiCodexEmail,
	githubIsAuthenticated,
	githubEmail,
}: UseSettingsItemsProps): ListItem[] {
	return useMemo(() => {
		const modelList = usesOpenRouterModels(provider) ? (openRouterModels || []) : getModelList(provider)
		const isActCustom = actModelId === CUSTOM_MODEL_ID || (actModelId && !modelList.includes(actModelId))
		const isPlanCustom = planModelId === CUSTOM_MODEL_ID || (planModelId && !modelList.includes(planModelId))
		const providerUsesReasoningEffort = provider === "openai-native" || provider === "openai-codex"
		const showActReasoningEffort = supportsReasoningEffortForModel(actModelId || "")
		const showPlanReasoningEffort = supportsReasoningEffortForModel(planModelId || "")
		const showActThinkingOption = !providerUsesReasoningEffort && !showActReasoningEffort
		const showPlanThinkingOption = !providerUsesReasoningEffort && !showPlanReasoningEffort

		switch (currentTab) {
			case "api":
				return [
					{
						key: "provider",
						label: "Provider",
						type: "editable",
						value: provider ? getProviderLabel(provider) : "not configured",
					},
					...(provider === "openai"
						? [
								{
									key: "openAiHeaders",
									label: "Custom Headers",
									type: "object" as const,
									value: openAiHeaders,
								},
						  ]
						: []),
					...(provider === "openai-codex" && openAiCodexIsAuthenticated
						? [
								{
									key: "codexEmail",
									label: "Authenticated as",
									type: "readonly" as const,
									value: openAiCodexEmail || "ChatGPT User",
								},
								{
									key: "codexSignOut",
									label: "Sign Out",
									type: "action" as const,
									value: "",
								},
						  ]
						: []),
					...(provider === "github-copilot" && githubIsAuthenticated
						? [
								{
									key: "githubEmail",
									label: "Authenticated as",
									type: "readonly" as const,
									value: githubEmail || "GitHub User",
								},
								{
									key: "githubSignOut",
									label: "Sign Out",
									type: "action" as const,
									value: "",
								},
						  ]
						: []),
					...(provider === "github-copilot" && !githubIsAuthenticated
						? [
								{
									key: "githubSignIn",
									label: "Sign In to GitHub Copilot",
									type: "action" as const,
									value: "",
								},
						  ]
						: []),
					...(separateModels
						? [
								{ key: "spacer0", label: "", type: "spacer" as const, value: "" },
								{ key: "actHeader", label: "Act Mode", type: "header" as const, value: "" },
								{
									key: "actModelId",
									label: "Model ID",
									type: "editable" as const,
									value: isActCustom ? "Custom" : (actModelId || "not set"),
								},
								...(isActCustom
									? [
											{
												key: "actCustomModelId",
												label: "Preset/Model",
												type: "editable" as const,
												value: actModelId === CUSTOM_MODEL_ID ? "" : actModelId,
											},
									  ]
									: []),
								...(showActThinkingOption
									? [
											{
												key: "actThinkingEnabled",
												label: "Enable thinking",
												type: "checkbox" as const,
												value: actThinkingEnabled,
											},
									  ]
									: []),
								...(showActReasoningEffort
									? [
											{
												key: "actReasoningEffort",
												label: "Reasoning effort",
												type: "cycle" as const,
												value: actReasoningEffort,
											},
									  ]
									: []),
								{ key: "planHeader", label: "Plan Mode", type: "header" as const, value: "" },
								{
									key: "planModelId",
									label: "Model ID",
									type: "editable" as const,
									value: isPlanCustom ? "Custom" : (planModelId || "not set"),
								},
								...(isPlanCustom
									? [
											{
												key: "planCustomModelId",
												label: "Preset/Model",
												type: "editable" as const,
												value: planModelId === CUSTOM_MODEL_ID ? "" : planModelId,
											},
									  ]
									: []),
								...(showPlanThinkingOption
									? [
											{
												key: "planThinkingEnabled",
												label: "Enable thinking",
												type: "checkbox" as const,
												value: planThinkingEnabled,
											},
									  ]
									: []),
								...(showPlanReasoningEffort
									? [
											{
												key: "planReasoningEffort",
												label: "Reasoning effort",
												type: "cycle" as const,
												value: planReasoningEffort,
											},
									  ]
									: []),
								{ key: "spacer1", label: "", type: "spacer" as const, value: "" },
						  ]
						: [
								{
									key: "actModelId",
									label: "Model ID",
									type: "editable" as const,
									value: isActCustom ? "Custom" : (actModelId || "not set"),
								},
								...(isActCustom
									? [
											{
												key: "actCustomModelId",
												label: "Preset/Model",
												type: "editable" as const,
												value: actModelId === CUSTOM_MODEL_ID ? "" : actModelId,
											},
									  ]
									: []),
								...(showActThinkingOption
									? [
											{
												key: "actThinkingEnabled",
												label: "Enable thinking",
												type: "checkbox" as const,
												value: actThinkingEnabled,
											},
									  ]
									: []),
								...(showActReasoningEffort
									? [
											{
												key: "actReasoningEffort",
												label: "Reasoning effort",
												type: "cycle" as const,
												value: actReasoningEffort,
											},
									  ]
									: []),
						  ]),
					{
						key: "separateModels",
						label: "Use separate models for Plan and Act",
						type: "checkbox",
						value: separateModels,
					},
				]

			case "auto-approve": {
				const result: ListItem[] = []
				const actions = autoApproveSettings.actions

				const addActionPair = (
					parentKey: string,
					parentLabel: string,
					parentDesc: string,
					childKey: string,
					childLabel: string,
					childDesc: string,
				) => {
					result.push({
						key: parentKey,
						label: parentLabel,
						type: "checkbox",
						value: actions[parentKey as keyof typeof actions] ?? false,
						description: parentDesc,
					})
					if (actions[parentKey as keyof typeof actions]) {
						result.push({
							key: childKey,
							label: childLabel,
							type: "checkbox",
							value: actions[childKey as keyof typeof actions] ?? false,
							description: childDesc,
							isSubItem: true,
							parentKey,
						})
					}
				}

				addActionPair(
					"readFiles",
					"Read and analyze files",
					"Read and analyze files in the working directory",
					"readFilesExternally",
					"Read all files",
					"Read files outside working directory",
				)
				addActionPair(
					"editFiles",
					"Edit and create files",
					"Edit and create files in the working directory",
					"editFilesExternally",
					"Edit all files",
					"Edit files outside working directory",
				)
				result.push({
					key: "executeCommands",
					label: "Auto-approve safe commands",
					type: "checkbox",
					value: actions.executeCommands ?? false,
					description: "Run harmless terminal commands automatically",
				})

				result.push(
					{
						key: "useBrowser",
						label: "Use the browser",
						type: "checkbox",
						value: actions.useBrowser,
						description: "Browse and interact with web pages",
					},
					{ key: "separator", label: "", type: "separator", value: false },
					{
						key: "enableNotifications",
						label: "Enable notifications",
						type: "checkbox",
						value: autoApproveSettings.enableNotifications,
						description: "System alerts when ailiance-agent needs your attention",
					},
				)
				return result
			}

			case "features":
				return Object.entries(FEATURE_SETTINGS).map(([key, config]) => ({
					key,
					label: config.label,
					type: "checkbox" as const,
					value: features[key as FeatureKey],
					description: config.description,
				}))

			case "other":
				return [
					{ key: "language", label: "Preferred language", type: "editable", value: preferredLanguage },
					{
						key: "telemetry",
						label: "Error/usage reporting",
						type: "checkbox",
						value: telemetry !== "disabled",
						description: "Help improve ailiance-agent by sending anonymous usage data",
					},
					{ key: "separator", label: "", type: "separator", value: "" },
					{ key: "version", label: "", type: "readonly", value: `ailiance-agent v${CLI_VERSION}` },
				]

			default:
				return []
		}
	}, [
		currentTab,
		provider,
		actModelId,
		planModelId,
		separateModels,
		actThinkingEnabled,
		planThinkingEnabled,
		actReasoningEffort,
		planReasoningEffort,
		autoApproveSettings,
		features,
		preferredLanguage,
		telemetry,
		openAiHeaders,
		openAiCodexIsAuthenticated,
		openAiCodexEmail,
		githubIsAuthenticated,
		githubEmail,
		openRouterModels,
	])
}
