import { HookInput, HookOutput } from "../../../shared/proto/isaac/hooks"
import { exec, HookName, HookRunner } from "../hook-types"

/**
 * Combines multiple hook runners and executes them in parallel.
 *
 * Used in multi-root workspaces where both global hooks (from ~/Documents/Isaac/Hooks/)
 * and workspace-specific hooks (from each workspace's .isaacrules/hooks/) exist for the
 * same hook type.
 *
 * Behavior:
 * - Executes all hooks concurrently using Promise.all
 * - If ANY hook returns cancel: true, the merged result will have cancel: true
 * - Concatenates all contextModification strings with double newlines
 * - Concatenates all errorMessage strings with single newlines
 *
 * This means if ANY hook requests cancellation, the task will be cancelled.
 * All hooks' context contributions are merged into the conversation.
 *
 * @template Name The type of hook this runner represents
 */
export class CombinedHookRunner<Name extends HookName> extends HookRunner<Name> {
	constructor(
		hookName: Name,
		private readonly runners: readonly HookRunner<Name>[],
	) {
		super(hookName)
	}

	override async [exec](input: HookInput): Promise<HookOutput> {
		// Run all hooks in parallel
		const results = await Promise.all(this.runners.map((runner) => runner[exec](input)))

		// Merge results:
		// - If any hook requests cancellation, set cancel to true
		// - Combine context contributions from all hooks
		// - Collect any error messages

		const cancel = results.some((result) => result.cancel === true)
		const contextModification = results
			.map((result) => result.contextModification?.trim())
			.filter((mod) => mod)
			.join("\n\n")
		const errorMessage = results
			.map((result) => result.errorMessage?.trim())
			.filter((msg) => msg)
			.join("\n")

		return HookOutput.create({
			cancel,
			contextModification,
			errorMessage,
		})
	}
}
