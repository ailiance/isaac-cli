import type { FileContextTracker } from "@core/context/context-tracking/FileContextTracker"
import type { MessageStateHandler } from "@core/task/message-state"
import type { TaskState } from "@core/task/TaskState"
import { isMultiRootEnabled } from "@core/workspace/multi-root-utils"
import { WorkspaceRootManager } from "@core/workspace/WorkspaceRootManager"
import { createTaskCheckpointManager } from "@integrations/checkpoints"
import type { ICheckpointManager } from "@integrations/checkpoints/types"
import type { DiffViewProvider } from "@integrations/editor/DiffViewProvider"
import { StateManager } from "@/core/storage/StateManager"
import { Logger } from "@/shared/services/Logger"

/**
 * Simple predicate abstracting our multi-root decision.
 */
export function shouldUseMultiRoot({
	workspaceManager,
	enableCheckpoints,
	stateManager,
	multiRootEnabledOverride,
}: {
	workspaceManager?: WorkspaceRootManager
	enableCheckpoints: boolean
	stateManager: StateManager
	multiRootEnabledOverride?: boolean
}): boolean {
	const multiRootEnabled = multiRootEnabledOverride ?? isMultiRootEnabled(stateManager)
	return Boolean(multiRootEnabled && enableCheckpoints && workspaceManager && workspaceManager.getRoots().length > 1)
}

type BuildArgs = {
	// common
	taskId: string
	messageStateHandler: MessageStateHandler
	// single-root deps
	fileContextTracker: FileContextTracker
	diffViewProvider: DiffViewProvider
	taskState: TaskState
	// multi-root deps
	workspaceManager?: WorkspaceRootManager

	// callbacks for single-root TaskCheckpointManager
	updateTaskHistory: (historyItem: any) => Promise<any[]>
	say: (...args: any[]) => Promise<number | undefined>
	cancelTask: () => Promise<void>
	postStateToWebview: () => Promise<void>

	// initial state for single-root
	initialConversationHistoryDeletedRange?: [number, number]
	initialCheckpointManagerErrorMessage?: string

	stateManager: StateManager
}

/**
 * Central factory for creating the appropriate checkpoint manager.
 * - MultiRootCheckpointManager for multi-root tasks
 * - TaskCheckpointManager for single-root tasks
 */
export function buildCheckpointManager(args: BuildArgs): ICheckpointManager {
	const {
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
		initialConversationHistoryDeletedRange,
		initialCheckpointManagerErrorMessage,
		stateManager,
	} = args

	const enableCheckpoints = stateManager.getGlobalSettingsKey("enableCheckpointsSetting")

	if (shouldUseMultiRoot({ workspaceManager, enableCheckpoints, stateManager })) {
		// ailiance-agent (P1 #9): MultiRootCheckpointManager is an incomplete
		// stub — restoreCheckpoint() is a no-op returning {} and
		// doesLatestTaskCompletionHaveNewChanges() always returns false. Routing
		// here silently loses checkpoints/restores for ALL roots. Until the
		// multi-root implementation is finished, fall back to the proven
		// single-root manager scoped to the primary workspace root: the primary
		// root is checkpointed and restorable as usual, and we warn loudly that
		// secondary roots are not yet covered (instead of failing silently).
		const roots = workspaceManager!.getRoots()
		const primary = workspaceManager!.getPrimaryRoot()
		const secondaryNames = roots
			.filter((r) => r.path !== primary?.path)
			.map((r) => r.name)
			.join(", ")
		Logger.warn(
			`[checkpoints] Multi-root checkpointing is not yet supported. Checkpoints will track only the primary workspace root` +
				`${primary ? ` (${primary.name})` : ""}. Changes in secondary root(s) [${secondaryNames}] will NOT be checkpointed or restored.`,
		)
		// Fall through to the single-root manager below.
	}

	// Single-root manager
	return createTaskCheckpointManager(
		{ taskId },
		{ enableCheckpoints },
		{
			diffViewProvider,
			messageStateHandler,
			fileContextTracker,
			taskState,
			workspaceManager,
		},
		{
			updateTaskHistory,
			say,
			cancelTask,
			postStateToWebview,
		},
		{
			conversationHistoryDeletedRange: initialConversationHistoryDeletedRange,
			checkpointManagerErrorMessage: initialCheckpointManagerErrorMessage,
		},
	)
}
