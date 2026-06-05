import { ApiStream } from "@core/api/transform/stream"
import { ToolUse } from "@core/assistant-message"
import { IsaacAsk, IsaacSay, MultiCommandState } from "@shared/ExtensionMessage"
import { IsaacMessageModelInfo } from "@shared/messages/metrics"
import { IsaacAskResponse } from "@shared/WebviewMessage"
import { ApiHandler, ApiProviderInfo } from "../../../core/api"
import { ICheckpointManager } from "../../../integrations/checkpoints/types"
import { DiffViewProvider } from "../../../integrations/editor/DiffViewProvider"
import { ModelContextTracker } from "../../context/context-tracking/ModelContextTracker"
import { Controller } from "../../controller"
import { StateManager } from "../../storage/StateManager"
import { ApiConversationManager } from "../ApiConversationManager"
import { MessageStateHandler } from "../message-state"
import { StreamResponseHandler } from "../StreamResponseHandler"
import { TaskState } from "../TaskState"
import { ToolExecutor } from "../ToolExecutor"

export interface AgentLoopRunnerContext {
	// identifiers
	taskId: string
	ulid: string
	// state
	taskState: TaskState
	// messaging
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
	// Full ApiHandler — required because updateApiReqMsg expects ApiHandler.
	// AgentLoopRunner only calls getModel, abort, and getApiStreamUsage but
	// the TS type must satisfy the ApiHandler contract used downstream.
	api: ApiHandler
	streamHandler: StreamResponseHandler
	diffViewProvider: DiffViewProvider
	checkpointManager?: ICheckpointManager
	toolExecutor: ToolExecutor
	messageStateHandler: MessageStateHandler
	modelContextTracker: ModelContextTracker
	stateManager: StateManager
	controller: Controller
	// callbacks / thin references
	postStateToWebview: () => Promise<void>
	reinitExistingTaskFromId: (taskId: string) => Promise<void>
	abortTask: (reason?: string, exitCode?: number) => Promise<void>
	getCurrentProviderInfo: () => ApiProviderInfo
	// delegated loop methods (thin wrappers on Task → their respective managers)
	attemptApiRequest: (previousApiReqIndex: number, shouldCompact?: boolean) => ApiStream
	processNativeToolCalls: (assistantTextOnly: string, toolBlocks: ToolUse[], isStreamComplete?: boolean) => Promise<void>
	presentAssistantMessage: () => Promise<void>
	processAssistantResponse: (params: {
		assistantMessage: string
		assistantTextOnly: string
		assistantTextSignature?: string
		assistantMessageId: string
		providerId: string
		modelId: string
		mode: string
		taskMetrics: {
			inputTokens: number
			outputTokens: number
			cacheWriteTokens: number
			cacheReadTokens: number
			totalCost?: number
		}
		modelInfo: IsaacMessageModelInfo
		toolUseHandler: ReturnType<StreamResponseHandler["getHandlers"]>["toolUseHandler"]
	}) => Promise<boolean>
	handleEmptyAssistantResponse: (params: {
		modelInfo: IsaacMessageModelInfo
		taskMetrics: {
			inputTokens: number
			outputTokens: number
			cacheWriteTokens: number
			cacheReadTokens: number
			totalCost?: number
		}
		providerId: string
		model: any
	}) => Promise<boolean>
	initializeCheckpoints: (isFirstRequest: boolean) => Promise<void>
	determineContextCompaction: (previousApiReqIndex: number) => Promise<boolean>
	prepareApiRequest: ApiConversationManager["prepareApiRequest"]
}
