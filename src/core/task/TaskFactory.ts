/**
 * TaskFactory — construction helpers for Task service dependencies.
 *
 * Extracted from the Task constructor (Sprint 1 PR2) to keep the
 * constructor focused on field assignment only.
 *
 * Two exported functions:
 *   - buildTaskServices: Phase B — checkpoint, API handler, command executor
 *   - buildTaskManagers: Phase C — all internal manager objects
 */

import type { ApiHandler } from "@core/api"
import { buildApiHandler } from "@core/api"
import type { Controller } from "@core/controller"
import { IsaacIgnoreController } from "@core/ignore/IsaacIgnoreController"
import { CommandPermissionController } from "@core/permissions"
import type { StateManager } from "@core/storage/StateManager"
import { isMultiRootEnabled } from "@core/workspace/multi-root-utils"
import type { WorkspaceRootManager } from "@core/workspace/WorkspaceRootManager"
import { HostProvider } from "@hosts/host-provider"
import { buildCheckpointManager, shouldUseMultiRoot } from "@integrations/checkpoints/factory"
import type { ICheckpointManager } from "@integrations/checkpoints/types"
import type { DiffViewProvider } from "@integrations/editor/DiffViewProvider"
import { CommandExecutor, type CommandExecutorCallbacks, type FullCommandExecutorConfig } from "@integrations/terminal"
import type { ITerminalManager } from "@integrations/terminal/types"
import type { BrowserSession } from "@services/browser/BrowserSession"
import type { UrlContentFetcher } from "@services/browser/UrlContentFetcher"
import { resolveEnvironment } from "@services/environment"
import { telemetryService } from "@services/telemetry"
import type { ApiConfiguration } from "@shared/api"
import { findLastIndex } from "@shared/array"
import type { IsaacApiReqInfo, IsaacAsk, IsaacSay, MultiCommandState } from "@shared/ExtensionMessage"
import type { HistoryItem } from "@shared/HistoryItem"
import { getExtensionSourceDir } from "@shared/isaac/constants"
import type { IsaacContent, IsaacTextContentBlock } from "@shared/messages/content"
import { ShowMessageType } from "@shared/proto/index.host"
import { Logger } from "@shared/services/Logger"
import type { IsaacAskResponse } from "@shared/WebviewMessage"
import { ApiConversationManager } from "./ApiConversationManager"
import { ContextLoader } from "./ContextLoader"
import { EnvironmentManager } from "./EnvironmentManager"
import { HookManager } from "./HookManager"
import { LifecycleManager } from "./LifecycleManager"
import type { MessageStateHandler } from "./message-state"
import { ResponseProcessor } from "./ResponseProcessor"
import type { StreamResponseHandler } from "./StreamResponseHandler"
import { TaskMessenger } from "./TaskMessenger"
import type { TaskState } from "./TaskState"
import { ToolExecutor } from "./ToolExecutor"
import { extractProviderDomainFromUrl } from "./utils"

// ---------------------------------------------------------------------------
// Phase B: service construction
// ---------------------------------------------------------------------------

export interface TaskServiceInputs {
	// identifiers
	taskId: string
	ulid: string
	// state
	taskState: TaskState
	messageStateHandler: MessageStateHandler
	// infra services (built before Phase B)
	terminalManager: ITerminalManager
	terminalExecutionMode: "vscodeTerminal" | "backgroundExec"
	diffViewProvider: DiffViewProvider
	fileContextTracker: import("@core/context/context-tracking/FileContextTracker").FileContextTracker
	browserSession: BrowserSession
	urlContentFetcher: UrlContentFetcher
	// config & storage
	stateManager: StateManager
	workspaceManager?: WorkspaceRootManager
	cwd: string
	historyItem?: HistoryItem
	// callbacks
	cancelTask: () => Promise<void>
	postStateToWebview: () => Promise<void>
	updateTaskHistory: (historyItem: HistoryItem) => Promise<HistoryItem[]>
	controller: Controller
	// say/ask binds from the Task instance
	say: (type: IsaacSay, text?: string, images?: string[], files?: string[], partial?: boolean) => Promise<number | undefined>
	ask: (
		type: IsaacAsk,
		text?: string,
		partial?: boolean,
		multiCommandState?: MultiCommandState,
	) => Promise<{
		response: IsaacAskResponse
		text?: string
		images?: string[]
		files?: string[]
		askTs?: number
		userEdits?: Record<string, string>
	}>
}

export interface TaskServices {
	checkpointManager: ICheckpointManager | undefined
	api: ApiHandler
	commandExecutor: CommandExecutor
}

/**
 * Builds checkpoint manager, API handler, and command executor.
 * Extracted from Task constructor Phase B (Sprint 1 PR2).
 *
 * Side-effect: may mutate `inputs.taskState.checkpointManagerErrorMessage`.
 */
export function buildTaskServices(inputs: TaskServiceInputs): TaskServices {
	const {
		taskId,
		ulid,
		taskState,
		messageStateHandler,
		terminalManager,
		terminalExecutionMode,
		diffViewProvider,
		fileContextTracker,
		browserSession,
		stateManager,
		workspaceManager,
		cwd,
		historyItem,
		cancelTask,
		postStateToWebview,
		updateTaskHistory,
		controller,
		say,
		ask,
	} = inputs

	// --- checkpoint manager ---
	const isMultiRootWorkspace = workspaceManager && workspaceManager.getRoots().length > 1
	const checkpointsEnabled = stateManager.getGlobalSettingsKey("enableCheckpointsSetting")

	if (isMultiRootWorkspace && checkpointsEnabled) {
		taskState.checkpointManagerErrorMessage = "Checkpoints are not currently supported in multi-root workspaces."
	}

	let checkpointManager: ICheckpointManager | undefined
	if (!isMultiRootWorkspace) {
		try {
			checkpointManager = buildCheckpointManager({
				taskId,
				messageStateHandler,
				fileContextTracker,
				diffViewProvider,
				taskState,
				workspaceManager,
				updateTaskHistory,
				say,
				cancelTask,
				postStateToWebview,
				initialConversationHistoryDeletedRange: taskState.conversationHistoryDeletedRange,
				initialCheckpointManagerErrorMessage: taskState.checkpointManagerErrorMessage,
				stateManager,
			})

			if (
				shouldUseMultiRoot({
					workspaceManager,
					enableCheckpoints: stateManager.getGlobalSettingsKey("enableCheckpointsSetting"),
					stateManager,
				})
			) {
				checkpointManager.initialize?.().catch((error: Error) => {
					Logger.error("Failed to initialize multi-root checkpoint manager:", error)
					taskState.checkpointManagerErrorMessage = error?.message || String(error)
				})
			}
		} catch (error) {
			Logger.error("Failed to initialize checkpoint manager:", error)
			if (stateManager.getGlobalSettingsKey("enableCheckpointsSetting")) {
				const errorMessage = error instanceof Error ? error.message : "Unknown error"
				HostProvider.window.showMessage({
					type: ShowMessageType.ERROR,
					message: `Failed to initialize checkpoint manager: ${errorMessage}`,
				})
			}
		}
	}

	// --- API handler ---
	const apiConfiguration = stateManager.getApiConfiguration()
	const effectiveApiConfiguration: ApiConfiguration = {
		...apiConfiguration,
		ulid,
		onRetryAttempt: async (attempt: number, maxRetries: number, delay: number, error: any) => {
			const isaacMessages = messageStateHandler.getIsaacMessages()
			const lastApiReqStartedIndex = findLastIndex(isaacMessages, (m) => m.say === "api_req_started")
			if (lastApiReqStartedIndex !== -1) {
				try {
					const currentApiReqInfo: IsaacApiReqInfo = JSON.parse(isaacMessages[lastApiReqStartedIndex].text || "{}")
					currentApiReqInfo.retryStatus = {
						attempt,
						maxAttempts: maxRetries,
						delaySec: Math.round(delay / 1000),
						errorSnippet: error?.message ? `${String(error.message).substring(0, 50)}...` : undefined,
					}
					delete currentApiReqInfo.cancelReason
					delete currentApiReqInfo.streamingFailedMessage
					await messageStateHandler.updateIsaacMessage(lastApiReqStartedIndex, {
						partial: true,
						text: JSON.stringify(currentApiReqInfo),
					})
					await postStateToWebview().catch((e) => Logger.error("Error posting state to webview in onRetryAttempt:", e))
				} catch (e) {
					Logger.error(`[Task ${taskId}] Error updating api_req_started with retryStatus:`, e)
				}
			}
		},
	}

	const mode = stateManager.getGlobalSettingsKey("mode")
	const currentProvider = mode === "plan" ? apiConfiguration.planModeApiProvider : apiConfiguration.actModeApiProvider
	const api = buildApiHandler(effectiveApiConfiguration, mode)

	// Set ulid on browserSession for telemetry tracking
	browserSession.setUlid(ulid)

	// Telemetry
	let openAiCompatibleDomain: string | undefined
	if (currentProvider === "openai" && apiConfiguration.openAiBaseUrl) {
		openAiCompatibleDomain = extractProviderDomainFromUrl(apiConfiguration.openAiBaseUrl)
	}
	if (historyItem) {
		telemetryService.captureTaskRestarted(ulid, currentProvider, openAiCompatibleDomain)
	} else {
		telemetryService.captureTaskCreated(ulid, currentProvider, openAiCompatibleDomain)
	}

	// --- command executor ---
	const commandExecutorConfig: FullCommandExecutorConfig = {
		cwd,
		terminalExecutionMode,
		terminalManager,
		taskId,
		ulid,
	}

	const commandExecutorCallbacks: CommandExecutorCallbacks = {
		say: say as CommandExecutorCallbacks["say"],
		ask: async (type: string, text?: string, partial?: boolean) => {
			const result = await ask(type as IsaacAsk, text, partial)
			return {
				response: result.response,
				text: result.text,
				images: result.images,
				files: result.files,
				askTs: result.askTs,
			}
		},
		updateBackgroundCommandState: (isRunning: boolean) => controller.updateBackgroundCommandState(isRunning, taskId),
		updateIsaacMessage: async (index: number, updates: { commandCompleted?: boolean; text?: string }) => {
			await messageStateHandler.updateIsaacMessage(index, updates)
			await postStateToWebview()
		},
		getIsaacMessages: () => messageStateHandler.getIsaacMessages() as Array<{ ask?: string; say?: string }>,
		addToUserMessageContent: (content: { type: string; text: string }) => {
			taskState.userMessageContent.push({ type: "text", text: content.text } as IsaacTextContentBlock)
		},
		getEnvironmentVariables: (cwd: string) => HostProvider.get().getEnvironmentVariables(cwd),
	}

	const commandExecutor = new CommandExecutor(commandExecutorConfig, commandExecutorCallbacks)

	return { checkpointManager, api, commandExecutor }
}

// ---------------------------------------------------------------------------
// Phase C: manager wiring
// ---------------------------------------------------------------------------

export interface TaskManagerInputs {
	// identifiers
	taskId: string
	ulid: string
	// state
	taskState: TaskState
	messageStateHandler: MessageStateHandler
	// services (output of buildTaskServices + Phase A)
	api: ApiHandler
	terminalManager: ITerminalManager
	terminalExecutionMode: "vscodeTerminal" | "backgroundExec"
	urlContentFetcher: UrlContentFetcher
	browserSession: BrowserSession
	diffViewProvider: DiffViewProvider
	fileContextTracker: import("@core/context/context-tracking/FileContextTracker").FileContextTracker
	isaacIgnoreController: IsaacIgnoreController
	commandPermissionController: CommandPermissionController
	contextManager: import("@core/context/context-management/ContextManager").ContextManager
	streamHandler: StreamResponseHandler
	stateManager: StateManager
	workspaceManager?: WorkspaceRootManager
	cwd: string
	checkpointManager?: ICheckpointManager
	commandExecutor: CommandExecutor
	controller: Controller
	// callbacks
	cancelTask: () => Promise<void>
	postStateToWebview: () => Promise<void>
	// Task instance binds
	say: (type: IsaacSay, text?: string, images?: string[], files?: string[], partial?: boolean) => Promise<number | undefined>
	ask: (
		type: IsaacAsk,
		text?: string,
		partial?: boolean,
		multiCommandState?: MultiCommandState,
	) => Promise<{
		response: IsaacAskResponse
		text?: string
		images?: string[]
		files?: string[]
		askTs?: number
		userEdits?: Record<string, string>
	}>
	saveCheckpointCallback: () => Promise<void>
	sayAndCreateMissingParamError: (
		toolName: import("@shared/tools").IsaacDefaultTool,
		paramName: string,
		relPath?: string,
	) => Promise<string>
	removeLastPartialMessageIfExistsWithType: (
		type: "ask" | "say",
		askOrSay: import("@shared/ExtensionMessage").IsaacAsk | IsaacSay,
		onlyPartial?: boolean,
	) => Promise<void>
	executeCommandTool: (...args: any[]) => Promise<any>
	cancelBackgroundCommand: () => Promise<boolean>
	switchToActModeCallback: () => Promise<boolean>
	setActiveHookExecution: (hookExecution: NonNullable<TaskState["activeHookExecution"]>) => Promise<void>
	clearActiveHookExecution: () => Promise<void>
	getActiveHookExecution: () => Promise<TaskState["activeHookExecution"]>
	runUserPromptSubmitHook: (
		userContent: IsaacContent[],
		context: "initial_task" | "resume" | "feedback",
	) => Promise<{ cancel?: boolean; wasCancelled?: boolean; contextModification?: string; errorMessage?: string }>
	initiateTaskLoop: (userContent: IsaacContent[]) => Promise<void>
	getCurrentProviderInfo: () => ReturnType<import("./index").Task["getCurrentProviderInfo"]>
	getEnvironmentDetails: (includeFileDetails?: boolean) => Promise<string>
	getApiRequestIdSafe: () => string | undefined
	writePromptMetadataArtifacts: (...args: any[]) => Promise<void>
	loadContext: (...args: any[]) => Promise<any>
	taskInitializationStartTime: number
	withStateLock: <T>(fn: () => T | Promise<T>) => Promise<T>
	recordEnvironment: () => Promise<void>
}

export interface TaskManagers {
	toolExecutor: ToolExecutor
	environmentManager: EnvironmentManager
	contextLoader: ContextLoader
	taskMessenger: TaskMessenger
	hookManager: HookManager
	lifecycleManager: LifecycleManager
	apiConversationManager: ApiConversationManager
	responseProcessor: ResponseProcessor
}

/**
 * Wires all internal Task managers together.
 * Extracted from Task constructor Phase C (Sprint 1 PR2).
 *
 * The `say`, `ask`, and other callback binds must point to the live
 * Task instance — pass them explicitly to avoid circular references.
 */
export function buildTaskManagers(inputs: TaskManagerInputs): TaskManagers {
	const {
		taskId,
		ulid,
		taskState,
		messageStateHandler,
		api,
		terminalManager,
		terminalExecutionMode,
		urlContentFetcher,
		browserSession,
		diffViewProvider,
		fileContextTracker,
		isaacIgnoreController,
		commandPermissionController,
		contextManager,
		streamHandler,
		stateManager,
		workspaceManager,
		cwd,
		checkpointManager,
		commandExecutor,
		controller,
		cancelTask,
		postStateToWebview,
		say,
		ask,
		saveCheckpointCallback,
		sayAndCreateMissingParamError,
		removeLastPartialMessageIfExistsWithType,
		executeCommandTool,
		cancelBackgroundCommand,
		switchToActModeCallback,
		setActiveHookExecution,
		clearActiveHookExecution,
		getActiveHookExecution,
		runUserPromptSubmitHook,
		initiateTaskLoop,
		getCurrentProviderInfo,
		getEnvironmentDetails,
		getApiRequestIdSafe,
		writePromptMetadataArtifacts,
		loadContext,
		taskInitializationStartTime,
		withStateLock,
		recordEnvironment,
	} = inputs

	// Resolve the execution environment for tool I/O. execute_command routes
	// through environment.runCommand, which delegates to the same
	// executeCommandTool callback used everywhere else (identical behavior).
	const environment = resolveEnvironment({ cwd, commandRunner: executeCommandTool })

	const toolExecutor = new ToolExecutor(
		taskState,
		messageStateHandler,
		api,
		urlContentFetcher,
		browserSession,
		diffViewProvider,
		fileContextTracker,
		isaacIgnoreController,
		commandPermissionController,
		contextManager,
		stateManager,
		cwd,
		taskId,
		ulid,
		terminalExecutionMode,
		workspaceManager,
		isMultiRootEnabled(stateManager),
		say,
		ask,
		saveCheckpointCallback,
		sayAndCreateMissingParamError,
		removeLastPartialMessageIfExistsWithType,
		executeCommandTool,
		cancelBackgroundCommand,
		() => checkpointManager?.doesLatestTaskCompletionHaveNewChanges() ?? Promise.resolve(false),
		switchToActModeCallback,
		cancelTask,
		postStateToWebview,
		setActiveHookExecution,
		clearActiveHookExecution,
		getActiveHookExecution,
		runUserPromptSubmitHook,
		environment,
	)

	const environmentManager = new EnvironmentManager({
		cwd,
		terminalManager,
		taskState,
		fileContextTracker,
		api,
		messageStateHandler,
		stateManager,
		workspaceManager,
	})

	const contextLoader = new ContextLoader({
		ulid,
		stateManager,
		controller,
		cwd,
		urlContentFetcher,
		fileContextTracker,
		workspaceManager,
		isaacIgnoreController,
		taskState,
		getCurrentProviderInfo,
		extensionPath: HostProvider.get().extensionFsPath,
		sourceDir: getExtensionSourceDir(),
		getEnvironmentDetails,
		commandPermissionController,
	})

	const taskMessenger = new TaskMessenger({
		taskState,
		messageStateHandler,
		postStateToWebview,
		stateManager,
		taskId,
		api,
		getCurrentProviderInfo,
	})

	const hookManager = new HookManager({
		taskState,
		messageStateHandler,
		stateManager,
		api,
		taskId,
		ulid,
		say,
		postStateToWebview,
		cancelTask,
		withStateLock,
		shouldRunBackgroundCheck: () => commandExecutor.hasActiveBackgroundCommand(),
	})

	const lifecycleManager = new LifecycleManager({
		taskState,
		messageStateHandler,
		stateManager,
		api,
		taskId,
		ulid,
		say,
		ask,
		postStateToWebview,
		cancelTask,
		checkpointManager,
		isaacIgnoreController,
		terminalManager,
		urlContentFetcher,
		browserSession,
		diffViewProvider,
		fileContextTracker,
		contextManager,
		commandExecutor,
		cwd,
		hookManager,
		initiateTaskLoop,
		recordEnvironment,
		commandPermissionController,
	})

	const apiConversationManager = new ApiConversationManager({
		taskState,
		messageStateHandler,
		api,
		contextManager,
		stateManager,
		taskId,
		ulid,
		cwd,
		say,
		ask,
		postStateToWebview,
		diffViewProvider,
		toolExecutor,
		streamHandler,
		withStateLock,
		loadContext,
		getCurrentProviderInfo,
		getEnvironmentDetails,
		writePromptMetadataArtifacts,
		handleHookCancellation: hookManager.handleHookCancellation.bind(hookManager),
		setActiveHookExecution: hookManager.setActiveHookExecution.bind(hookManager),
		clearActiveHookExecution: hookManager.clearActiveHookExecution.bind(hookManager),
		taskInitializationStartTime,
		cancelTask,
	})

	const responseProcessor = new ResponseProcessor({
		taskState,
		messageStateHandler,
		api,
		stateManager,
		taskId,
		ulid,
		say,
		ask,
		postStateToWebview,
		diffViewProvider,
		streamHandler,
		withStateLock,
		getCurrentProviderInfo,
		getApiRequestIdSafe,
		toolExecutor,
	})

	return {
		toolExecutor,
		environmentManager,
		contextLoader,
		taskMessenger,
		hookManager,
		lifecycleManager,
		apiConversationManager,
		responseProcessor,
	}
}
