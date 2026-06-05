import { IsaacContent } from "@shared/messages/content"
import { SkillMetadata } from "@shared/skills"
import { ApiHandler, ApiProviderInfo } from "../../../core/api"
import { DiffViewProvider } from "../../../integrations/editor/DiffViewProvider"
import { ContextManager } from "../../context/context-management/ContextManager"
import { StateManager } from "../../storage/StateManager"
import { MessageStateHandler } from "../message-state"
import { StreamResponseHandler } from "../StreamResponseHandler"
import { TaskMessenger } from "../TaskMessenger"
import { TaskState } from "../TaskState"
import { ToolExecutor } from "../ToolExecutor"
import { HookExecution } from "./HookExecution"

export interface ApiConversationManagerDependencies {
	taskState: TaskState
	messageStateHandler: MessageStateHandler
	api: ApiHandler
	contextManager: ContextManager
	stateManager: StateManager
	taskId: string
	ulid: string
	cwd: string
	say: TaskMessenger["say"]
	ask: TaskMessenger["ask"]
	postStateToWebview: () => Promise<void>
	diffViewProvider: DiffViewProvider
	toolExecutor: ToolExecutor
	streamHandler: StreamResponseHandler
	withStateLock: <T>(fn: () => T | Promise<T>) => Promise<T>
	loadContext: (
		userContent: IsaacContent[],
		includeFileDetails?: boolean,
		useCompactPrompt?: boolean
	) => Promise<[IsaacContent[], string, boolean, SkillMetadata[], boolean, string?]>
	getCurrentProviderInfo: () => ApiProviderInfo
	getEnvironmentDetails: (includeFileDetails?: boolean) => Promise<string>
	writePromptMetadataArtifacts: (params: {
		systemPrompt: string
		providerInfo: ApiProviderInfo
		tools?: any[]
		fullHistory?: any[]
		deletedRange?: [number, number]
	}) => Promise<void>
	handleHookCancellation: (hookName: string, wasCancelled: boolean) => Promise<void>
	cancelTask: () => Promise<void>
	setActiveHookExecution: (hookExecution: HookExecution | undefined) => Promise<void>
	clearActiveHookExecution: () => Promise<void>
	taskInitializationStartTime: number
}
