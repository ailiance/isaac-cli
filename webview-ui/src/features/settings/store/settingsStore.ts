import { DEFAULT_AUTO_APPROVAL_SETTINGS } from "@shared/AutoApprovalSettings"
import { liteLlmModelInfoSaneDefaults, openRouterDefaultModelId, openRouterDefaultModelInfo } from "@shared/api"
import { DEFAULT_BROWSER_SETTINGS } from "@shared/BrowserSettings"
import { Environment } from "@shared/config-types"
import type { ExtensionState, IsaacMessage } from "@shared/ExtensionMessage"
import { DEFAULT_PLATFORM } from "@shared/ExtensionMessage"
import { EmptyRequest } from "@shared/proto/isaac/common"
import { fromProtobufModels } from "@shared/proto-conversions/models/typeConversion"
import { SkillMetadata } from "@shared/skills"
import { create } from "zustand"
import { ModelsServiceClient } from "@/shared/api/grpc-client"

interface SettingsState {
	version: string
	apiConfiguration: any
	navigateToAccount: () => void
	setShowWelcome: (show: boolean) => void
	availableTerminalProfiles: any[]
	isaacModels: any
	refreshIsaacModels: () => void
	openRouterModels: any
	refreshOpenRouterModels: () => void
	refreshBasetenModels: () => void
	refreshGroqModels: () => void
	refreshHuggingFaceModels: () => void
	refreshRequestyModels: () => void
	vercelAiGatewayModels: any
	refreshVercelAiGatewayModels: () => void
	liteLlmModels: any
	refreshLiteLlmModels: () => void
	basetenModels: any
	groqModels: any
	huggingFaceModels: any
	requestyModels: any
	githubCopilotModels: any
	githubCopilotIsAuthenticated: boolean
	githubCopilotEmail?: string
	openAiCodexIsAuthenticated: boolean
	openAiCodexEmail?: string
	autoApprovalSettings: ExtensionState["autoApprovalSettings"]
	browserSettings: ExtensionState["browserSettings"]
	preferredLanguage: string
	mode: string
	platform: string
	environment: Environment
	telemetrySetting: string
	distinctId: string
	planActSeparateModelsSetting: boolean
	enableCheckpointsSetting: boolean
	shellIntegrationTimeout: number
	terminalReuseEnabled: boolean
	vscodeTerminalExecutionMode: string
	terminalOutputLineLimit: number
	maxConsecutiveMistakes: number
	defaultTerminalProfile: string
	isNewUser: boolean
	welcomeViewCompleted: boolean
	strictPlanModeEnabled: boolean
	yoloModeToggled: boolean
	autoApproveAllToggled: boolean
	customPrompt?: string
	useAutoCondense: boolean
	subagentsEnabled: boolean
	isaacWebToolsEnabled: { user: boolean; featureFlag: boolean }
	worktreesEnabled: { user: boolean; featureFlag: boolean }
	favoritedModelIds: string[]
	lastDismissedInfoBannerVersion: number
	lastDismissedModelBannerVersion: number
	optOutOfRemoteConfig: boolean
	remoteConfigSettings: Record<string, any>
	backgroundCommandRunning: boolean
	backgroundCommandTaskId?: string
	lastDismissedCliBannerVersion: number
	backgroundEditEnabled: boolean
	doubleCheckCompletionEnabled: boolean

	// Toggles
	globalIsaacRulesToggles: Record<string, boolean>
	localIsaacRulesToggles: Record<string, boolean>
	localCursorRulesToggles: Record<string, boolean>
	localWindsurfRulesToggles: Record<string, boolean>
	localAgentsRulesToggles: Record<string, boolean>
	localWorkflowToggles: Record<string, boolean>
	globalWorkflowToggles: Record<string, boolean>
	availableSkills: SkillMetadata[]
	globalSkillsToggles: Record<string, boolean>
	localSkillsToggles: Record<string, boolean>
	remoteRulesToggles: Record<string, boolean>
	remoteWorkflowToggles: Record<string, boolean>

	// Workspace
	workspaceRoots: any[]
	primaryRootIndex: number
	isMultiRootWorkspace: boolean
	multiRootSetting: { user: boolean; featureFlag: boolean }
	hooksEnabled: boolean
	triggerNativeToolCall: boolean
	enableParallelToolCalling: boolean
	writePromptMetadataEnabled: boolean
	writePromptMetadataDirectory?: string

	// Chat & History (Moved from other stores)
	isaacMessages: IsaacMessage[]
	taskHistory: any[]
	currentTaskItem?: any
	checkpointManagerErrorMessage?: string
	expandTaskHeader: boolean
	totalTasksSize: number
	dismissedBanners: any[]
	banners: any[]
	welcomeBanners: any[]

	// Navigation Actions
	navigateToSettings: (section?: string) => void
	navigateToSettingsModelPicker: (options: { targetSection?: string }) => void
	navigateToHistory: () => void
	navigateToChat: () => void
	navigateToWorktrees: () => void
	onRelinquishControl: (callback: () => void) => () => void

	// Actions
	setSettings: (settings: Partial<SettingsState>) => void
	setIsaacMessages: (messages: IsaacMessage[]) => void
	updatePartialMessage: (message: IsaacMessage) => void
	setTaskHistory: (history: any[]) => void
	setExpandTaskHeader: (expand: boolean) => void
	setTotalTasksSize: (size: number) => void
	setGlobalIsaacRulesToggles: (toggles: Record<string, boolean>) => void
	setLocalIsaacRulesToggles: (toggles: Record<string, boolean>) => void
	setLocalCursorRulesToggles: (toggles: Record<string, boolean>) => void
	setLocalWindsurfRulesToggles: (toggles: Record<string, boolean>) => void
	setLocalAgentsRulesToggles: (toggles: Record<string, boolean>) => void
	setLocalWorkflowToggles: (toggles: Record<string, boolean>) => void
	setGlobalWorkflowToggles: (toggles: Record<string, boolean>) => void
	setGlobalSkillsToggles: (toggles: Record<string, boolean>) => void
	setLocalSkillsToggles: (toggles: Record<string, boolean>) => void
	setRemoteRulesToggles: (toggles: Record<string, boolean>) => void
	setRemoteWorkflowToggles: (toggles: Record<string, boolean>) => void
	setGroqModels: (models: any) => void
	setHuggingFaceModels: (models: any) => void
	setRequestyModels: (models: any) => void
}

export const useSettingsStore = create<SettingsState>((set) => ({
	autoApprovalSettings: DEFAULT_AUTO_APPROVAL_SETTINGS,
	browserSettings: DEFAULT_BROWSER_SETTINGS,
	preferredLanguage: "English",
	mode: "act",
	platform: DEFAULT_PLATFORM,
	environment: Environment.production,
	telemetrySetting: "unset",
	distinctId: "",
	planActSeparateModelsSetting: true,
	enableCheckpointsSetting: true,
	shellIntegrationTimeout: 4000,
	terminalReuseEnabled: true,
	vscodeTerminalExecutionMode: "vscodeTerminal",
	terminalOutputLineLimit: 500,
	maxConsecutiveMistakes: 3,
	defaultTerminalProfile: "default",
	isNewUser: false,
	welcomeViewCompleted: false,
	strictPlanModeEnabled: false,
	yoloModeToggled: false,
	autoApproveAllToggled: false,
	customPrompt: undefined,
	useAutoCondense: false,
	subagentsEnabled: false,
	isaacWebToolsEnabled: { user: true, featureFlag: false },
	worktreesEnabled: { user: true, featureFlag: false },
	favoritedModelIds: [],
	lastDismissedInfoBannerVersion: 0,
	lastDismissedModelBannerVersion: 0,
	optOutOfRemoteConfig: false,
	remoteConfigSettings: {},
	backgroundCommandRunning: false,
	backgroundCommandTaskId: undefined,
	lastDismissedCliBannerVersion: 0,
	backgroundEditEnabled: false,
	doubleCheckCompletionEnabled: false,

	globalIsaacRulesToggles: {},
	localIsaacRulesToggles: {},
	localCursorRulesToggles: {},
	localWindsurfRulesToggles: {},
	localAgentsRulesToggles: {},
	localWorkflowToggles: {},
	globalWorkflowToggles: {},
	availableSkills: [],
	globalSkillsToggles: {},
	localSkillsToggles: {},
	assertion: {},
	remoteRulesToggles: {},
	remoteWorkflowToggles: {},

	workspaceRoots: [],
	primaryRootIndex: 0,
	isMultiRootWorkspace: false,
	multiRootSetting: { user: false, featureFlag: false },
	hooksEnabled: false,
	enableParallelToolCalling: false,
	writePromptMetadataEnabled: false,
	writePromptMetadataDirectory: undefined,

	version: "0.0.0",
	apiConfiguration: {},
	navigateToAccount: () => {},
	setShowWelcome: () => {},
	availableTerminalProfiles: [],
	isaacModels: {},
	refreshIsaacModels: async () => {
		try {
			const response = await ModelsServiceClient.refreshIsaacModelsRpc(EmptyRequest.create())
			set({
				isaacModels: {
					[openRouterDefaultModelId]: openRouterDefaultModelInfo,
					...fromProtobufModels(response.models),
				},
			})
		} catch (error) {
			console.error("Failed to refresh Isaac models:", error)
		}
	},
	openRouterModels: {
		[openRouterDefaultModelId]: openRouterDefaultModelInfo,
	},
	refreshOpenRouterModels: async () => {
		try {
			const response = await ModelsServiceClient.refreshOpenRouterModelsRpc(EmptyRequest.create())
			set({
				openRouterModels: {
					[openRouterDefaultModelId]: openRouterDefaultModelInfo,
					...fromProtobufModels(response.models),
				},
			})
		} catch (error) {
			console.error("Failed to refresh OpenRouter models:", error)
		}
	},
	like: {},
	vercelAiGatewayModels: {},
	refreshVercelAiGatewayModels: async () => {
		try {
			const response = await ModelsServiceClient.refreshVercelAiGatewayModelsRpc(EmptyRequest.create())
			set({
				vercelAiGatewayModels: {
					[openRouterDefaultModelId]: openRouterDefaultModelInfo,
					...fromProtobufModels(response.models),
				},
			})
		} catch (error) {
			console.error("Failed to refresh Vercel AI Gateway models:", error)
		}
	},
	prototype: {},
	liteLlmModels: {},
	refreshLiteLlmModels: async () => {
		try {
			const response = await ModelsServiceClient.refreshLiteLlmModelsRpc(EmptyRequest.create())
			set({
				liteLlmModels: {
					"": liteLlmModelInfoSaneDefaults,
					...fromProtobufModels(response.models),
				},
			})
		} catch (error) {
			console.error("Failed to refresh LiteLLM models:", error)
		}
	},
	basetenModels: {},
	groqModels: {},
	huggingFaceModels: {},
	requestyModels: {},
	githubCopilotModels: {},
	githubCopilotIsAuthenticated: false,
	githubCopilotEmail: undefined,
	openAiCodexIsAuthenticated: false,
	openAiCodexEmail: undefined,

	triggerNativeToolCall: false,
	isaacMessages: [],
	taskHistory: [],
	currentTaskItem: undefined,
	checkpointManagerErrorMessage: undefined,
	expandTaskHeader: false,
	totalTasksSize: 0,
	dismissedBanners: [],
	banners: [],
	welcomeBanners: [],
	navigateToSettings: () => {},
	navigateToSettingsModelPicker: () => {},
	navigateToHistory: () => {},
	navigateToChat: () => {},
	navigateToWorktrees: () => {},
	onRelinquishControl: () => () => {},
	setIsaacMessages: (messages) => set({ isaacMessages: messages }),
	updatePartialMessage: (message) =>
		set((state) => {
			const lastIndex = state.isaacMessages.findLastIndex((msg) => msg.ts === message.ts)
			if (lastIndex !== -1) {
				const newMessages = [...state.isaacMessages]
				newMessages[lastIndex] = message
				return { isaacMessages: newMessages }
			}
			return state
		}),
	setTaskHistory: (history) => set({ taskHistory: history }),
	setExpandTaskHeader: (expand) => set({ expandTaskHeader: expand }),
	setTotalTasksSize: (size) => set({ totalTasksSize: size }),
	setGlobalIsaacRulesToggles: (toggles) => set({ globalIsaacRulesToggles: toggles }),
	setLocalIsaacRulesToggles: (toggles) => set({ localIsaacRulesToggles: toggles }),
	setLocalCursorRulesToggles: (toggles) => set({ localCursorRulesToggles: toggles }),
	setLocalWindsurfRulesToggles: (toggles) => set({ localWindsurfRulesToggles: toggles }),
	setLocalAgentsRulesToggles: (toggles) => set({ localAgentsRulesToggles: toggles }),
	setLocalWorkflowToggles: (toggles) => set({ localWorkflowToggles: toggles }),
	setGlobalWorkflowToggles: (toggles) => set({ globalWorkflowToggles: toggles }),
	setGlobalSkillsToggles: (toggles) => set({ globalSkillsToggles: toggles }),
	setLocalSkillsToggles: (toggles) => set({ localSkillsToggles: toggles }),
	setRemoteRulesToggles: (toggles) => set({ remoteRulesToggles: toggles }),
	setRemoteWorkflowToggles: (toggles) => set({ remoteWorkflowToggles: toggles }),
	setGroqModels: (models) => set({ groqModels: models }),
	setHuggingFaceModels: (models) => set({ huggingFaceModels: models }),
	setRequestyModels: (models) => set({ requestyModels: models }),
	refreshBasetenModels: async () => {
		try {
			const response = await ModelsServiceClient.refreshBasetenModelsRpc(EmptyRequest.create())
			set({
				basetenModels: fromProtobufModels(response.models),
			})
		} catch (error) {
			console.error("Failed to refresh Baseten models:", error)
		}
	},
	refreshGroqModels: async () => {
		try {
			const response = await ModelsServiceClient.refreshGroqModelsRpc(EmptyRequest.create())
			set({
				groqModels: fromProtobufModels(response.models),
			})
		} catch (error) {
			console.error("Failed to refresh Groq models:", error)
		}
	},
	refreshHuggingFaceModels: async () => {
		try {
			const response = await ModelsServiceClient.refreshHuggingFaceModels(EmptyRequest.create())
			set({ huggingFaceModels: fromProtobufModels(response.models) })
		} catch (error) {
			console.error("Failed to refresh HuggingFace models:", error)
		}
	},
	refreshRequestyModels: async () => {
		try {
			const response = await ModelsServiceClient.refreshRequestyModels(EmptyRequest.create())
			set({
				requestyModels: fromProtobufModels(response.models),
			})
		} catch (error) {
			console.error("Failed to refresh Requesty models:", error)
		}
	},
	setSettings: (settings) =>
		set((state) => {
			return { ...state, ...settings }
		}),
}))
