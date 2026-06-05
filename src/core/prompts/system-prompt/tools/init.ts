import { getExposedUnits } from "@core/task/tools/units"
import { IsaacDefaultTool } from "@/shared/tools"
import { IsaacToolSet } from "../registry/IsaacToolSet"
import type { IsaacToolSpec } from "../spec"
import { subagent } from "./subagent"

/**
 * Registers all tools with the IsaacToolSet provider.
 *
 * Lot E cutover: the spec list is driven from the migrated tool *units*
 * (`getExposedUnits()`), removing the previously-duplicated manual import list.
 *
 * Two registrations are NOT unit-driven and are reproduced exactly as before:
 *
 *  - `subagent` (use_subagents) has no unit (dynamic per-subagent tool names),
 *    so its spec is registered here directly. Its position in the registration
 *    order is load-bearing: tools are emitted to the LLM in first-insertion
 *    order, so `subagent` is registered immediately after `search_files` to keep
 *    the native-tools snapshots byte-identical.
 *  - `generate_explanation` has a unit but is intentionally not exposed
 *    (`SPEC_SUPPRESSED_UNIT_IDS`), reproducing the historical commented-out entry.
 */
export function registerIsaacToolSets(): void {
	for (const unit of getExposedUnits()) {
		IsaacToolSet.register(unit.spec as IsaacToolSpec)

		// Preserve historical registration order: `subagent` sat between
		// `search_files` and `use_skill` in the legacy manual list.
		if (unit.id === IsaacDefaultTool.SEARCH) {
			IsaacToolSet.register(subagent)
		}
	}
}
