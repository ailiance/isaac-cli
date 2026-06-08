import { Anthropic } from "@anthropic-ai/sdk"
import { AssistantMessageContent } from "@core/assistant-message"
import { IsaacAskResponse } from "@shared/WebviewMessage"
import { SkillMetadata } from "@/shared/skills"
import { PendingToolRegistry } from "./PendingToolRegistry"
import type { HookExecution } from "./types/HookExecution"

export class TaskState {
	// Sprint 2 — registry of asynchronously executing tool invocations.
	// One per Task instance; consumed by GetToolResultToolHandler and
	// cancelled on task abort to avoid orphan background work.
	pendingTools: PendingToolRegistry = new PendingToolRegistry()

	// Task-level timing
	taskStartTimeMs = Date.now()
	taskFirstTokenTimeMs?: number

	// Streaming flags
	isStreaming = false
	isWaitingForFirstChunk = false
	didCompleteReadingStream = false

	// Content processing
	currentStreamingContentIndex = 0
	assistantMessageContent: AssistantMessageContent[] = []
	useNativeToolCalls = false
	userMessageContent: (Anthropic.TextBlockParam | Anthropic.ImageBlockParam | Anthropic.ToolResultBlockParam)[] = []
	userMessageContentReady = false
	// Map of tool names to their tool_use_id for creating proper ToolResultBlockParam
	toolUseIdMap: Map<string, string> = new Map()

	// Presentation locks
	presentAssistantMessageLocked = false
	presentAssistantMessageHasPendingUpdates = false

	// Ask/Response handling
	askResponse?: IsaacAskResponse
	askResponseUserEdits?: Record<string, string>
	askResponseText?: string
	askResponseImages?: string[]
	askResponseFiles?: string[]
	lastMessageTs?: number

	// Plan mode specific state
	isAwaitingPlanResponse = false
	didRespondToPlanAskBySwitchingMode = false
	didSwitchToActMode = false

	// Set by the /restore slash command; consumed by the agent loop at turn-end
	// to re-enter the restored session (safe point — past loadContext).
	pendingRestoreTaskId?: string

	// Context and history
	conversationHistoryDeletedRange?: [number, number]

	// Tool execution flags
	didRejectTool = false
	didAlreadyUseTool = false
	didEditFile = false

	// Error tracking
	consecutiveMistakeCount = 0
	doubleCheckCompletionPending = false
	didAutomaticallyRetryFailedApiRequest = false
	checkpointManagerErrorMessage?: string

	// Retry tracking for auto-retry feature
	autoRetryAttempts = 0

	// Task Initialization
	isInitialized = false

	// Task Abort / Cancellation
	abort = false
	didFinishAbortingStream = false
	abandoned = false

	// Hook execution tracking for cancellation
	activeHookExecution?: HookExecution

	// Auto-context summarization
	currentlySummarizing = false
	totalToolCallCount = 0

	lastAutoCompactTriggerIndex?: number
	taskLockAcquired = false
	initialCheckpointCommitPromise?: Promise<string | undefined>
	availableSkills: SkillMetadata[] = []
	discoveredSkillsCache?: SkillMetadata[]
}
