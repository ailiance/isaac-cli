/**
 * Value object grouping all service dependencies of {@link Task}.
 *
 * These are the ~14 "external" dependencies that Task receives or builds
 * during construction. Grouping them here is a preparatory step for
 * Sprint 1 PR2 (TaskFactory), which will use this interface as its
 * parameter shape.
 *
 * NOTE: no logic lives here — pure type definition.
 */

import type { ApiHandler } from "@core/api"
import type { Controller } from "@core/controller"
import type { IsaacIgnoreController } from "@core/ignore/IsaacIgnoreController"
import type { CommandPermissionController } from "@core/permissions"
import type { StateManager } from "@core/storage/StateManager"
import type { ICheckpointManager } from "@integrations/checkpoints/types"
import type { DiffViewProvider } from "@integrations/editor/DiffViewProvider"
import type { CommandExecutor } from "@integrations/terminal"
import type { ITerminalManager } from "@integrations/terminal/types"
import type { BrowserSession } from "@services/browser/BrowserSession"
import type { UrlContentFetcher } from "@services/browser/UrlContentFetcher"

export interface TaskDependencies {
	/** VS Code / CLI host controller that owns this task. */
	controller: Controller

	/** LLM API handler (provider-specific wrapper). */
	api: ApiHandler

	/** Terminal manager (VSCode integrated terminal or standalone). */
	terminalManager: ITerminalManager

	/** Browser session for browser-use tools. */
	browserSession: BrowserSession

	/** Editor diff view / file-edit provider. */
	diffViewProvider: DiffViewProvider

	/** Checkpoint manager (git-based snapshots); optional when checkpoints are disabled. */
	checkpointManager?: ICheckpointManager

	/** Fetches remote URL content for context injection. */
	urlContentFetcher: UrlContentFetcher

	/** Respects .diracignore rules for file access. */
	diracIgnoreController: IsaacIgnoreController

	/** Manages shell-command permission prompts. */
	commandPermissionController: CommandPermissionController

	/** Persistent settings / state store. */
	stateManager: StateManager

	/** Executes shell commands and manages background processes. */
	commandExecutor: CommandExecutor

	// ---------------------------------------------------------------------------
	// Callbacks injected from the controller
	// ---------------------------------------------------------------------------

	/** Posts the full extension state snapshot to the webview. */
	postStateToWebview: () => Promise<void>

	/** Re-opens a previous task from its stored history entry. */
	reinitExistingTaskFromId: (taskId: string) => Promise<void>

	/** Cancels the currently running task. */
	cancelTask: () => Promise<void>
}
