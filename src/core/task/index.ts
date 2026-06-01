import { ApiHandler, ApiProviderInfo } from "@core/api"
import { ContextManager } from "@core/context/context-management/ContextManager"

import { EnvironmentContextTracker } from "@core/context/context-tracking/EnvironmentContextTracker"
import { FileContextTracker } from "@core/context/context-tracking/FileContextTracker"
import { ModelContextTracker } from "@core/context/context-tracking/ModelContextTracker"

import { DiracIgnoreController } from "@core/ignore/DiracIgnoreController"
import { initializeMcpForTask } from "@core/mcp/bootstrap"
import { mcpClientManager } from "@core/mcp/McpClientManager"
import { getActiveMcpToolSet } from "@core/mcp/retrieval/session"
import { CommandPermissionController } from "@core/permissions"
import { getSavedApiConversationHistory } from "@core/storage/disk"
import { WorkspaceRootManager } from "@core/workspace/WorkspaceRootManager"
import { HostProvider } from "@hosts/host-provider"
import { ICheckpointManager } from "@integrations/checkpoints/types"
import { DiffViewProvider } from "@integrations/editor/DiffViewProvider"
import { FileEditProvider } from "@integrations/editor/FileEditProvider"
import { type CommandExecutionOptions, CommandExecutor, StandaloneTerminalManager } from "@integrations/terminal"
import { ITerminalManager } from "@integrations/terminal/types"
import { BrowserSession } from "@services/browser/BrowserSession"
import { UrlContentFetcher } from "@services/browser/UrlContentFetcher"
import { DiracAsk, DiracSay, MultiCommandState } from "@shared/ExtensionMessage"
import { HistoryItem } from "@shared/HistoryItem"
import { DiracContent, DiracToolResponseContent } from "@shared/messages/content"
import { Logger } from "@shared/services/Logger"
import { DiracDefaultTool } from "@shared/tools"
import { DiracAskResponse } from "@shared/WebviewMessage"
import { AnchorStateManager } from "@utils/AnchorStateManager"
import { isParallelToolCallingEnabled } from "@utils/model-utils"
import Mutex from "p-mutex"
import { ulid } from "ulid"
import { SkillMetadata } from "@/shared/skills"
import { Controller } from "../controller"
import { StateManager } from "../storage/StateManager"
import { AgentLoopRunner } from "./AgentLoopRunner"
import { ApiConversationManager } from "./ApiConversationManager"
import { ApiRequestHandler } from "./ApiRequestHandler"
import { ContextLoader } from "./ContextLoader"
import { EnvironmentManager } from "./EnvironmentManager"
import { HookManager } from "./HookManager"
import { LifecycleManager } from "./LifecycleManager"
import { MessageStateHandler } from "./message-state"
import { ResponseProcessor } from "./ResponseProcessor"
import { StreamResponseHandler } from "./StreamResponseHandler"
import type { TaskDependencies } from "./TaskDependencies"
import { buildTaskManagers, buildTaskServices } from "./TaskFactory"
import { TaskMessenger } from "./TaskMessenger"
import { TaskState } from "./TaskState"
import { ToolExecutor } from "./ToolExecutor"
import type { AgentLoopRunnerContext } from "./types/agent-loop-runner"
import type { ApiRequestHandlerContext } from "./types/api-request-handler"

export type ToolResponse = DiracToolResponseContent

type TaskParams = {
	controller: Controller
	updateTaskHistory: (historyItem: HistoryItem) => Promise<HistoryItem[]>
	postStateToWebview: () => Promise<void>
	reinitExistingTaskFromId: (taskId: string) => Promise<void>
	cancelTask: () => Promise<void>
	shellIntegrationTimeout: number
	terminalReuseEnabled: boolean
	terminalOutputLineLimit: number
	defaultTerminalProfile: string
	vscodeTerminalExecutionMode: "vscodeTerminal" | "backgroundExec"
	cwd: string
	stateManager: StateManager
	workspaceManager?: WorkspaceRootManager
	task?: string
	images?: string[]
	files?: string[]
	historyItem?: HistoryItem
	taskId: string
	taskLockAcquired: boolean
}

export class Task {
	// Core task variables
	readonly taskId: string
	readonly ulid: string
	private taskIsFavorited?: boolean
	public cwd: string
	private taskInitializationStartTime: number

	taskState: TaskState

	// ONE mutex for ALL state modifications to prevent race conditions
	private stateMutex = new Mutex()

	/**
	 * Execute function with exclusive lock on all task state
	 * Use this for ANY state modification to prevent races
	 */
	private async withStateLock<T>(fn: () => T | Promise<T>): Promise<T> {
		return await this.stateMutex.withLock(fn)
	}

	public async setActiveHookExecution(hookExecution: NonNullable<typeof this.taskState.activeHookExecution>): Promise<void> {
		return this.hookManager.setActiveHookExecution(hookExecution)
	}

	public async clearActiveHookExecution(): Promise<void> {
		return this.hookManager.clearActiveHookExecution()
	}

	public async getActiveHookExecution(): Promise<typeof this.taskState.activeHookExecution> {
		return this.hookManager.getActiveHookExecution()
	}

	// Core dependencies
	controller: Controller

	// Service handlers
	api: ApiHandler
	terminalManager: ITerminalManager
	private urlContentFetcher: UrlContentFetcher
	browserSession: BrowserSession
	contextManager: ContextManager
	diffViewProvider: DiffViewProvider
	public checkpointManager?: ICheckpointManager
	diracIgnoreController: DiracIgnoreController
	private commandPermissionController: CommandPermissionController
	toolExecutor: ToolExecutor
	/**
	 * Whether the task is using native tool calls.
	 * This is used to determine how we would format response.
	 * Example: We don't add noToolsUsed response when native tool call is used
	 * because of the expected format from the tool calls is different.
	 */

	streamHandler: StreamResponseHandler

	terminalExecutionMode: "vscodeTerminal" | "backgroundExec"

	// Metadata tracking
	private fileContextTracker: FileContextTracker
	modelContextTracker: ModelContextTracker
	private environmentContextTracker: EnvironmentContextTracker
	private environmentManager: EnvironmentManager
	private contextLoader: ContextLoader
	private taskMessenger: TaskMessenger
	private hookManager: HookManager
	private lifecycleManager: LifecycleManager
	private apiConversationManager: ApiConversationManager
	private responseProcessor: ResponseProcessor

	// Callbacks
	private updateTaskHistory: (historyItem: HistoryItem) => Promise<HistoryItem[]>
	postStateToWebview: () => Promise<void>
	reinitExistingTaskFromId: (taskId: string) => Promise<void>
	private cancelTask: () => Promise<void>

	// Cache service
	stateManager: StateManager

	// Message and conversation state
	messageStateHandler: MessageStateHandler

	// Workspace manager
	workspaceManager?: WorkspaceRootManager

	// Command executor for running shell commands (extracted from executeCommandTool)
	private commandExecutor!: CommandExecutor

	// Task Locking (Sqlite)
	private taskLockAcquired: boolean

	/**
	 * Aggregated view of all service dependencies.
	 * Mirrors the individual fields above; populated at the end of the constructor
	 * once every service is fully initialised.
	 * Preparatory for Sprint 1 PR2 (TaskFactory).
	 */
	private deps!: TaskDependencies

	/** Sprint 2 PR3: drives the outer ReAct loop (extracted from initiateTaskLoop). */
	private agentLoopRunner!: AgentLoopRunner

	/** Sprint 2 PR4: handles attemptApiRequest (extracted from Task). */
	private apiRequestHandler!: ApiRequestHandler

	constructor(params: TaskParams) {
		const {
			controller,
			updateTaskHistory,
			postStateToWebview,
			reinitExistingTaskFromId,
			cancelTask,
			shellIntegrationTimeout,
			terminalReuseEnabled,
			terminalOutputLineLimit,
			defaultTerminalProfile,
			vscodeTerminalExecutionMode,
			cwd,
			stateManager,
			workspaceManager,
			task,
			images,
			files,
			historyItem,
			taskId,
			taskLockAcquired,
		} = params

		this.taskInitializationStartTime = performance.now()
		this.taskState = new TaskState()
		if (stateManager.getGlobalSettingsKey("mode") === "act") {
			this.taskState.didSwitchToActMode = true
		}
		this.controller = controller
		this.updateTaskHistory = updateTaskHistory
		this.postStateToWebview = postStateToWebview
		this.reinitExistingTaskFromId = reinitExistingTaskFromId
		this.cancelTask = cancelTask
		this.diracIgnoreController = new DiracIgnoreController(cwd)
		this.diracIgnoreController.yoloMode = !!stateManager.getGlobalSettingsKey("yoloModeToggled")

		this.commandPermissionController = new CommandPermissionController()
		this.taskLockAcquired = taskLockAcquired
		// Determine terminal execution mode and create appropriate terminal manager
		this.terminalExecutionMode = vscodeTerminalExecutionMode || "vscodeTerminal"

		// When backgroundExec mode is selected, use StandaloneTerminalManager for hidden execution
		// Otherwise, use the HostProvider's terminal manager (VSCode terminal in VSCode, standalone in CLI)
		if (this.terminalExecutionMode === "backgroundExec") {
			// Import StandaloneTerminalManager for background execution
			this.terminalManager = new StandaloneTerminalManager()
			Logger.info(`[Task ${taskId}] Using StandaloneTerminalManager for backgroundExec mode`)
		} else {
			// Use the host-provided terminal manager (VSCode terminal in VSCode environment)
			this.terminalManager = HostProvider.get().createTerminalManager()
			Logger.info(`[Task ${taskId}] Using HostProvider terminal manager for vscodeTerminal mode`)
		}
		this.terminalManager.setShellIntegrationTimeout(shellIntegrationTimeout)
		this.terminalManager.setTerminalReuseEnabled(terminalReuseEnabled ?? true)
		this.terminalManager.setTerminalOutputLineLimit(terminalOutputLineLimit)
		this.terminalManager.setDefaultTerminalProfile(defaultTerminalProfile)

		this.urlContentFetcher = new UrlContentFetcher()
		this.browserSession = new BrowserSession(stateManager)
		this.contextManager = new ContextManager()
		this.streamHandler = new StreamResponseHandler()
		this.cwd = cwd
		this.stateManager = stateManager
		this.workspaceManager = workspaceManager

		// Prefer the host's DiffViewProvider if available, as it handles both background
		// and interactive edits. Fall back to FileEditProvider for headless environments.
		const hostDiffViewProvider = HostProvider.get().createDiffViewProvider()
		this.diffViewProvider = hostDiffViewProvider || new FileEditProvider()

		this.taskId = taskId
		AnchorStateManager.reset(this.taskId)

		// Initialize taskId first
		if (historyItem) {
			this.ulid = historyItem.ulid ?? ulid()
			this.taskIsFavorited = historyItem.isFavorited
			this.taskState.conversationHistoryDeletedRange = historyItem.conversationHistoryDeletedRange
			if (historyItem.checkpointManagerErrorMessage) {
				this.taskState.checkpointManagerErrorMessage = historyItem.checkpointManagerErrorMessage
			}
		} else if (task || images || files) {
			this.ulid = ulid()
		} else {
			throw new Error("Either historyItem or task/images must be provided")
		}

		this.messageStateHandler = new MessageStateHandler({
			taskId: this.taskId,
			ulid: this.ulid,
			taskState: this.taskState,
			taskIsFavorited: this.taskIsFavorited,
			updateTaskHistory: this.updateTaskHistory,
			workspaceRootPath: this.workspaceManager?.getPrimaryRoot()?.path,
		})

		// Initialize context trackers
		this.fileContextTracker = new FileContextTracker(controller, this.taskId)
		this.modelContextTracker = new ModelContextTracker(this.taskId)
		this.environmentContextTracker = new EnvironmentContextTracker(this.taskId)

		// Phase B: build checkpoint manager, API handler, and command executor.
		// Note: buildTaskServices may mutate this.taskState.checkpointManagerErrorMessage.
		const services = buildTaskServices({
			taskId: this.taskId,
			ulid: this.ulid,
			taskState: this.taskState,
			messageStateHandler: this.messageStateHandler,
			terminalManager: this.terminalManager,
			terminalExecutionMode: this.terminalExecutionMode,
			diffViewProvider: this.diffViewProvider,
			fileContextTracker: this.fileContextTracker,
			browserSession: this.browserSession,
			urlContentFetcher: this.urlContentFetcher,
			stateManager: this.stateManager,
			workspaceManager: this.workspaceManager,
			cwd: this.cwd,
			historyItem,
			cancelTask: this.cancelTask,
			postStateToWebview: this.postStateToWebview,
			updateTaskHistory: this.updateTaskHistory,
			controller: this.controller,
			say: this.say.bind(this),
			ask: this.ask.bind(this),
		})
		this.checkpointManager = services.checkpointManager
		this.api = services.api
		this.commandExecutor = services.commandExecutor

		// Phase C: wire all internal managers.
		// Note: say/ask binds must point to the live Task instance.
		const managers = buildTaskManagers({
			taskId: this.taskId,
			ulid: this.ulid,
			taskState: this.taskState,
			messageStateHandler: this.messageStateHandler,
			api: this.api,
			terminalManager: this.terminalManager,
			terminalExecutionMode: this.terminalExecutionMode,
			urlContentFetcher: this.urlContentFetcher,
			browserSession: this.browserSession,
			diffViewProvider: this.diffViewProvider,
			fileContextTracker: this.fileContextTracker,
			diracIgnoreController: this.diracIgnoreController,
			commandPermissionController: this.commandPermissionController,
			contextManager: this.contextManager,
			streamHandler: this.streamHandler,
			stateManager: this.stateManager,
			workspaceManager: this.workspaceManager,
			cwd: this.cwd,
			checkpointManager: this.checkpointManager,
			commandExecutor: this.commandExecutor,
			controller: this.controller,
			cancelTask: this.cancelTask,
			postStateToWebview: this.postStateToWebview,
			say: this.say.bind(this),
			ask: this.ask.bind(this),
			saveCheckpointCallback: this.saveCheckpointCallback.bind(this),
			sayAndCreateMissingParamError: this.sayAndCreateMissingParamError.bind(this),
			removeLastPartialMessageIfExistsWithType: this.removeLastPartialMessageIfExistsWithType.bind(this),
			executeCommandTool: this.executeCommandTool.bind(this),
			cancelBackgroundCommand: this.cancelBackgroundCommand.bind(this),
			switchToActModeCallback: this.switchToActModeCallback.bind(this),
			setActiveHookExecution: this.setActiveHookExecution.bind(this),
			clearActiveHookExecution: this.clearActiveHookExecution.bind(this),
			getActiveHookExecution: this.getActiveHookExecution.bind(this),
			runUserPromptSubmitHook: this.runUserPromptSubmitHook.bind(this),
			initiateTaskLoop: this.initiateTaskLoop.bind(this),
			getCurrentProviderInfo: this.getCurrentProviderInfo.bind(this),
			getEnvironmentDetails: this.getEnvironmentDetails.bind(this),
			getApiRequestIdSafe: this.getApiRequestIdSafe.bind(this),
			writePromptMetadataArtifacts: this.writePromptMetadataArtifacts.bind(this),
			loadContext: this.loadContext.bind(this),
			taskInitializationStartTime: this.taskInitializationStartTime,
			withStateLock: this.withStateLock.bind(this),
			recordEnvironment: () => this.environmentContextTracker.recordEnvironment(),
		})
		this.toolExecutor = managers.toolExecutor
		this.environmentManager = managers.environmentManager
		this.contextLoader = managers.contextLoader
		this.taskMessenger = managers.taskMessenger
		this.hookManager = managers.hookManager
		this.lifecycleManager = managers.lifecycleManager
		this.apiConversationManager = managers.apiConversationManager
		this.responseProcessor = managers.responseProcessor

		// Populate the TaskDependencies value object after all fields are initialised.
		// Individual fields (this.controller, this.api, …) are kept untouched so that
		// existing call sites within the class do not need to change.
		this.deps = {
			controller: this.controller,
			api: this.api,
			terminalManager: this.terminalManager,
			browserSession: this.browserSession,
			diffViewProvider: this.diffViewProvider,
			checkpointManager: this.checkpointManager,
			urlContentFetcher: this.urlContentFetcher,
			diracIgnoreController: this.diracIgnoreController,
			commandPermissionController: this.commandPermissionController,
			stateManager: this.stateManager,
			commandExecutor: this.commandExecutor,
			postStateToWebview: this.postStateToWebview,
			reinitExistingTaskFromId: this.reinitExistingTaskFromId,
			cancelTask: this.cancelTask,
		}

		// PR6: narrow context — ApiRequestHandler
		const apiRequestHandlerCtx: ApiRequestHandlerContext = {
			taskId: this.taskId,
			taskState: this.taskState,
			api: this.api,
			contextManager: this.contextManager,
			diracIgnoreController: this.diracIgnoreController,
			stateManager: this.stateManager,
			messageStateHandler: this.messageStateHandler,
			workspaceManager: this.workspaceManager,
			controller: this.controller,
			cwd: this.cwd,
			terminalExecutionMode: this.terminalExecutionMode,
			say: this.say.bind(this),
			ask: this.ask.bind(this),
			postStateToWebview: this.postStateToWebview,
			handleContextWindowExceededError: () => this.apiConversationManager.handleContextWindowExceededError(),
			getCurrentProviderInfo: this.getCurrentProviderInfo.bind(this),
			isParallelToolCallingEnabled: this.isParallelToolCallingEnabled.bind(this),
		}
		this.apiRequestHandler = new ApiRequestHandler(apiRequestHandlerCtx)

		// PR6: narrow context — AgentLoopRunner (must come after apiRequestHandler)
		const agentLoopRunnerCtx: AgentLoopRunnerContext = {
			taskId: this.taskId,
			ulid: this.ulid,
			taskState: this.taskState,
			say: this.say.bind(this),
			ask: this.ask.bind(this),
			api: this.api,
			streamHandler: this.streamHandler,
			diffViewProvider: this.diffViewProvider,
			checkpointManager: this.checkpointManager,
			toolExecutor: this.toolExecutor,
			messageStateHandler: this.messageStateHandler,
			modelContextTracker: this.modelContextTracker,
			stateManager: this.stateManager,
			controller: this.controller,
			postStateToWebview: this.postStateToWebview,
			reinitExistingTaskFromId: this.reinitExistingTaskFromId,
			abortTask: this.abortTask.bind(this),
			getCurrentProviderInfo: this.getCurrentProviderInfo.bind(this),
			attemptApiRequest: (idx, compact) => this.apiRequestHandler.attempt(idx, compact),
			processNativeToolCalls: (text, blocks, complete) =>
				this.responseProcessor.processNativeToolCalls(text, blocks, complete),
			presentAssistantMessage: () => this.responseProcessor.presentAssistantMessage(),
			processAssistantResponse: (params) => this.responseProcessor.processAssistantResponse(params),
			handleEmptyAssistantResponse: (params) => this.responseProcessor.handleEmptyAssistantResponse(params),
			initializeCheckpoints: (isFirst) => this.lifecycleManager.initializeCheckpoints(isFirst),
			determineContextCompaction: (idx) => this.apiConversationManager.determineContextCompaction(idx),
			prepareApiRequest: (params) => this.apiConversationManager.prepareApiRequest(params),
		}
		this.agentLoopRunner = new AgentLoopRunner(agentLoopRunnerCtx)
	}

	async getEnvironmentDetails(includeFileDetails = false): Promise<string> {
		return this.environmentManager.getEnvironmentDetails(includeFileDetails)
	}

	async loadContext(
		userContent: DiracContent[],
		includeFileDetails = false,
		useCompactPrompt = false,
	): Promise<[DiracContent[], string, boolean, SkillMetadata[], boolean, string?]> {
		return this.contextLoader.loadContext(userContent, includeFileDetails, useCompactPrompt)
	}

	// Communicate with webview

	async ask(type: DiracAsk, text?: string, partial?: boolean, multiCommandState?: MultiCommandState) {
		return this.taskMessenger.ask(type, text, partial, multiCommandState)
	}

	async handleWebviewAskResponse(
		askResponse: DiracAskResponse,
		text?: string,
		images?: string[],
		files?: string[],
		userEdits?: Record<string, string>,
	) {
		return this.taskMessenger.handleWebviewAskResponse(askResponse, text, images, files, userEdits)
	}

	async say(
		type: DiracSay,
		text?: string,
		images?: string[],
		files?: string[],
		partial?: boolean,
	): Promise<number | undefined> {
		return this.taskMessenger.say(type, text, images, files, partial)
	}

	async sayAndCreateMissingParamError(toolName: DiracDefaultTool, paramName: string, relPath?: string) {
		return this.taskMessenger.sayAndCreateMissingParamError(toolName, paramName, relPath)
	}

	async removeLastPartialMessageIfExistsWithType(type: "ask" | "say", askOrSay: DiracAsk | DiracSay, onlyPartial = true) {
		return this.taskMessenger.removeLastPartialMessageIfExistsWithType(type, askOrSay, onlyPartial)
	}

	private async saveCheckpointCallback(isAttemptCompletionMessage?: boolean, completionMessageTs?: number): Promise<void> {
		return this.checkpointManager?.saveCheckpoint(isAttemptCompletionMessage, completionMessageTs) ?? Promise.resolve()
	}

	/**
	 * Check if parallel tool calling is enabled.
	 * Parallel tool calling is enabled if:
	 * 1. User has enabled it in settings, OR
	 * 2. The current model/provider supports native tool calling and handles parallel tools well
	 */
	isParallelToolCallingEnabled(): boolean {
		const enableParallelSetting = this.stateManager.getGlobalSettingsKey("enableParallelToolCalling")
		const providerInfo = this.getCurrentProviderInfo()
		return isParallelToolCallingEnabled(enableParallelSetting, providerInfo)
	}

	private async switchToActModeCallback(): Promise<boolean> {
		return await this.controller.toggleActModeForYoloMode()
	}

	private async runUserPromptSubmitHook(
		userContent: DiracContent[],
		context: "initial_task" | "resume" | "feedback",
	): Promise<{ cancel?: boolean; wasCancelled?: boolean; contextModification?: string; errorMessage?: string }> {
		return this.hookManager.runUserPromptSubmitHook(userContent, context)
	}

	public async startTask(task?: string, images?: string[], files?: string[]): Promise<void> {
		// Initialize MCP tools before starting the task so the LLM sees them
		// on its first request. Failures are swallowed — ailiance-agent must work
		// without plugins.
		await initializeMcpForTask(this.toolExecutor)
		// Adaptive MCP retrieval: seed the session active set from the first
		// user task text so the prompt-context gate can filter MCP tools down
		// to the relevant subset. Best-effort — must not block task start.
		const _mcpActiveSet = getActiveMcpToolSet()
		if (_mcpActiveSet && typeof task === "string" && task.length > 0) {
			await _mcpActiveSet.seed(task)
		}
		return this.lifecycleManager.startTask(task, images, files)
	}

	public async resumeTaskFromHistory() {
		// Mirror startTask: the resume path must (re)publish MCP tool specs +
		// a fresh session active set, otherwise getActiveMcpToolSet() returns
		// undefined (or a stale set from a prior task in a long-lived process)
		// and the prompt-context gate floods the prompt with every MCP spec
		// still registered in the process-global DiracToolSet. Re-init is cheap
		// (re-lists + re-publishes; the vector index is disk-cached).
		await initializeMcpForTask(this.toolExecutor)
		// Seed the active set from the resumed conversation's first user message
		// so retrieval filters MCP tools down to the relevant subset. Best-effort.
		const _mcpActiveSet = getActiveMcpToolSet()
		if (_mcpActiveSet) {
			const firstUserText = await this.extractFirstUserTextFromHistory()
			if (firstUserText) {
				await _mcpActiveSet.seed(firstUserText)
			}
		}
		return this.lifecycleManager.resumeTaskFromHistory()
	}

	/**
	 * Best-effort extraction of the first user message text from the saved API
	 * conversation history, used to seed the adaptive MCP retrieval active set
	 * on resume. Mirrors the extraction in ApiRequestHandler. Returns undefined
	 * if the history is unreadable or contains no user text.
	 */
	private async extractFirstUserTextFromHistory(): Promise<string | undefined> {
		try {
			const history = await getSavedApiConversationHistory(this.taskId)
			const firstUser = history.find((m) => m.role === "user")
			if (!firstUser) {
				return undefined
			}
			const content: unknown = firstUser.content
			if (typeof content === "string") {
				return content.length > 0 ? content : undefined
			}
			if (Array.isArray(content)) {
				const parts: string[] = []
				for (const block of content) {
					if (block && typeof block === "object" && (block as { type?: unknown }).type === "text") {
						const text = (block as { text?: unknown }).text
						if (typeof text === "string") {
							parts.push(text)
						}
					}
				}
				return parts.length > 0 ? parts.join(" ") : undefined
			}
			return undefined
		} catch {
			// best-effort — resume must never break on a missing/corrupt history
			return undefined
		}
	}

	private async initiateTaskLoop(userContent: DiracContent[]): Promise<void> {
		return this.agentLoopRunner.initiateLoop(userContent)
	}

	async abortTask(reason = "aborted", exitCode = 130) {
		// ailiance-agent fork: tracing close hook — finalise the JSONL trace meta
		// even when the task ends via abort/cancel/error rather than via a
		// successful attempt_completion. Run before the lifecycle abort so
		// that disposed dependencies cannot interfere; closeTrace itself is
		// idempotent and best-effort, so failures here cannot block abort.
		try {
			this.toolExecutor.closeTrace(reason, exitCode)
		} catch (_err) {
			// non-fatal — tracing must never break abort
		}
		// Sprint 2 (Lot C) — cancel any background async tools so they
		// cannot outlive the task. AbortController.abort() is propagated
		// to their underlying I/O via PendingToolEntry.abortController.
		try {
			this.taskState.pendingTools.cancelAll()
		} catch (_err) {
			// non-fatal — abort must never be blocked by registry teardown
		}
		// Disconnect MCP servers; no-op if none were connected.
		mcpClientManager.disconnectAll().catch((_err) => {
			// non-fatal — MCP cleanup must never block abort
		})
		return this.lifecycleManager.abortTask()
	}

	// Tools
	async executeCommandTool(
		command: string,
		timeoutSeconds: number | undefined,
		options?: CommandExecutionOptions,
	): Promise<[boolean, DiracToolResponseContent]> {
		return this.commandExecutor.execute(command, timeoutSeconds, options)
	}

	/**
	 * Cancel a background command that is running in the background
	 * @returns true if a command was cancelled, false if no command was running
	 */
	public async cancelBackgroundCommand(): Promise<boolean> {
		return this.commandExecutor.cancelBackgroundCommand()
	}

	getCurrentProviderInfo(): ApiProviderInfo {
		const model = this.api.getModel()
		const apiConfig = this.stateManager.getApiConfiguration()
		const mode = this.stateManager.getGlobalSettingsKey("mode")
		const providerId = (mode === "plan" ? apiConfig.planModeApiProvider : apiConfig.actModeApiProvider) as string
		const customPrompt = this.stateManager.getGlobalSettingsKey("customPrompt")
		return { model, providerId, customPrompt, mode }
	}

	async writePromptMetadataArtifacts(params: {
		systemPrompt: string
		providerInfo: ApiProviderInfo
		tools?: any[]
		fullHistory?: any[]
		deletedRange?: [number, number]
	}): Promise<void> {
		return this.apiRequestHandler.writePromptMetadataArtifacts(params)
	}

	getApiRequestIdSafe(): string | undefined {
		const apiLike = this.api as Partial<{
			getLastRequestId: () => string | undefined
			lastGenerationId?: string
		}>
		return apiLike.getLastRequestId?.() ?? apiLike.lastGenerationId
	}
}
