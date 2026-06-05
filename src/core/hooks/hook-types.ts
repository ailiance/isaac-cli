import { version as isaacVersion } from "../../../package.json"
import { getDistinctId } from "../../services/logging/distinctId"
import {
	HookInput,
	HookModelContext,
	HookOutput,
	NotificationData,
	PostToolUseData,
	PreCompactData,
	PreToolUseData,
	TaskCancelData,
	TaskCompleteData,
	TaskResumeData,
	TaskStartData,
	UserPromptSubmitData,
} from "../../shared/proto/isaac/hooks"
import { StateManager } from "../storage/StateManager"

// Hook execution timeout (10 seconds)
export const HOOK_EXECUTION_TIMEOUT_MS = 10000

// Maximum size for context modification (to prevent prompt overflow)
export const MAX_CONTEXT_MODIFICATION_SIZE = 50000 // ~50KB

// Exit code indicating cancellation/interruption (Unix SIGINT convention: 128 + signal 2)
export const EXIT_CODE_SIGINT = 130

/**
 * Validates hook output JSON structure.
 * Ensures required fields are present and have correct types.
 */
export function validateHookOutput(output: any): { valid: boolean; error?: string } {
	// Check if deprecated shouldContinue field is present
	if (output.shouldContinue !== undefined) {
		return {
			valid: false,
			error:
				"Invalid hook output: The 'shouldContinue' field has been removed.\n\n" +
				"Use 'cancel: true' instead to trigger task cancellation.\n\n" +
				"Migration guide:\n" +
				"  Before: { shouldContinue: false, errorMessage: '...' }\n" +
				"  After:  { cancel: true, errorMessage: '...' }\n\n" +
				"Example valid response:\n" +
				JSON.stringify(
					{
						cancel: false,
						contextModification: "Optional context here",
						errorMessage: "",
					},
					null,
					2,
				),
		}
	}

	// cancel is optional, but if provided must be a boolean
	if (output.cancel !== undefined && typeof output.cancel !== "boolean") {
		return {
			valid: false,
			error:
				"Invalid hook output: 'cancel' must be a boolean.\n\n" +
				`Received type: ${typeof output.cancel}\n\n` +
				"Example valid response:\n" +
				JSON.stringify({ cancel: true, errorMessage: "Cancelling task" }, null, 2),
		}
	}

	// contextModification is optional, but if provided must be a string
	if (output.contextModification !== undefined && typeof output.contextModification !== "string") {
		return {
			valid: false,
			error:
				"Invalid hook output: 'contextModification' must be a string.\n\n" +
				`Received type: ${typeof output.contextModification}\n\n` +
				"Example valid response:\n" +
				JSON.stringify({ contextModification: "Context here" }, null, 2),
		}
	}

	// errorMessage is optional, but if provided must be a string
	if (output.errorMessage !== undefined && typeof output.errorMessage !== "string") {
		return {
			valid: false,
			error:
				"Invalid hook output: 'errorMessage' must be a string.\n\n" +
				`Received type: ${typeof output.errorMessage}\n\n` +
				"Example valid response:\n" +
				JSON.stringify({ cancel: true, errorMessage: "Error description" }, null, 2),
		}
	}

	return { valid: true }
}

export interface Hooks {
	PreToolUse: {
		preToolUse: PreToolUseData
	}
	PostToolUse: {
		postToolUse: PostToolUseData
	}
	UserPromptSubmit: {
		userPromptSubmit: UserPromptSubmitData
	}
	TaskStart: {
		taskStart: TaskStartData
	}
	TaskResume: {
		taskResume: TaskResumeData
	}
	TaskCancel: {
		taskCancel: TaskCancelData
	}
	TaskComplete: {
		taskComplete: TaskCompleteData
	}
	Notification: {
		notification: NotificationData
	}
	PreCompact: {
		preCompact: PreCompactData
	}
}

export interface HookModelInputContext {
	provider?: string
	slug?: string
}

// The names of all supported hooks. Hooks[N] is the type of data the hook takes as input.
export type HookName = keyof Hooks

/**
 * The hook input parameters for a named hook. These are the parameters the caller must
 * provide--the other common parameters like isaacVersion and userId are handled by the
 * hook system.
 */
export type NamedHookInput<Name extends HookName> = {
	taskId: string
	model?: HookModelInputContext
} & Hooks[Name]

// We look up HookRunner.exec via symbol so that the combined hook runner can call
// exec on its sub-runners without completing a new set of parameters for each one.
// See CombinedHookRunner[exec]
export const exec = Symbol()

/**
 * Callback type for streaming hook output
 */
export type HookStreamCallback = (
	line: string,
	stream: "stdout" | "stderr",
	meta?: {
		source: "global" | "workspace"
		scriptPath: string
	},
) => void

/**
 * Runs a hook script and returns the result.
 *
 * Design: HookRunner is stateless and reusable. Each call to run() is independent
 * and returns a fresh HookOutput. This design is appropriate because:
 * - Hooks are executed on-demand per tool use
 * - No need to maintain execution history within the runner
 * - ToolExecutor creates new instances as needed
 * - Results are immediately consumed and added to the conversation context
 */
export abstract class HookRunner<Name extends HookName> {
	constructor(public readonly hookName: Name) {}

	/**
	 * Execute the hook with the given parameters.
	 * This method is stateless and can be called multiple times safely.
	 * @param params Hook-specific parameters (taskId, preToolUse/postToolUse data)
	 * @returns The hook output containing shouldContinue, contextModification, and errorMessage
	 */
	async run(params: NamedHookInput<Name>): Promise<HookOutput> {
		const input = HookInput.create(await this.completeParams(params))
		return this[exec](input)
	}

	abstract [exec](params: HookInput): Promise<HookOutput>

	/**
	 * Completes the hook input by adding common metadata to caller-provided parameters.
	 *
	 * This method enriches the hook-specific input (like preToolUse or postToolUse data)
	 * with standard information that all hooks receive:
	 * - isaacVersion: Current Isaac extension version
	 * - hookName: The type of hook being executed (e.g., "PreToolUse")
	 * - timestamp: Execution time in milliseconds since epoch
	 * - workspaceRoots: Array of workspace folder paths
	 * - userId: Isaac user ID, machine ID, or generated UUID
	 *
	 * This separation allows hook scripts to receive consistent metadata without
	 * requiring callers to manually provide it each time.
	 *
	 * @param params The hook-specific input parameters (taskId + hook data)
	 * @returns Complete HookInput ready to be serialized and sent to the hook script
	 */
	protected async completeParams(params: NamedHookInput<Name>): Promise<HookInput> {
		const workspaceRoots =
			StateManager.get()
				.getGlobalStateKey("workspaceRoots")
				?.map((root) => root.path) || []

		const model: HookModelContext = {
			provider: params.model?.provider?.trim() || "unknown",
			slug: params.model?.slug?.trim() || "unknown",
		}

		return {
			isaacVersion,
			hookName: this.hookName,
			timestamp: Date.now().toString(),
			workspaceRoots,
			userId: getDistinctId(), // Always available: Isaac User ID, machine ID, or generated UUID
			...params,
			model,
		}
	}
}
