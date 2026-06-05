import { HookInput, HookOutput } from "../../../shared/proto/isaac/hooks"
import { exec, HookName, HookRunner } from "../hook-types"

/**
 * NoOpRunner is a null-object pattern implementation used when no hook scripts are found.
 *
 * Instead of returning null or requiring null checks everywhere, we return a NoOpRunner
 * that always succeeds immediately without any side effects. This simplifies the calling
 * code and ensures hooks are always optional/gracefully degraded.
 *
 * @template Name The type of hook this runner represents
 */
export class NoOpRunner<Name extends HookName> extends HookRunner<Name> {
	/**
	 * Executes a no-op hook that always succeeds.
	 * @param _ Hook input (ignored)
	 * @returns A successful hook output (no cancellation)
	 */
	override async [exec](_: HookInput): Promise<HookOutput> {
		// HookOutput is a protobuf-generated type with non-optional fields.
		// Protobuf defaults: cancel=false, contextModification="", errorMessage=""
		return HookOutput.create({ cancel: false })
	}
}
