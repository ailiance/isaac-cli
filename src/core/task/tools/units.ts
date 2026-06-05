import type { IsaacToolUnit } from "@core/prompts/system-prompt/tool-unit"
import { IsaacDefaultTool } from "@/shared/tools"
import { ask_followup_question_unit } from "./handlers/AskFollowupQuestionToolHandler"
import { attempt_completion_unit } from "./handlers/AttemptCompletionHandler"
import { browser_action_unit } from "./handlers/BrowserToolHandler"
import { diagnostics_scan_unit } from "./handlers/DiagnosticsScanToolHandler"
import { edit_file_unit } from "./handlers/EditFileToolHandler"
import { execute_command_unit } from "./handlers/ExecuteCommandToolHandler"
import { find_symbol_references_unit } from "./handlers/FindSymbolReferencesToolHandler"
import { find_tools_unit } from "./handlers/FindToolsToolHandler"
import { generate_explanation_unit } from "./handlers/GenerateExplanationToolHandler"
import { get_file_skeleton_unit } from "./handlers/GetFileSkeletonToolHandler"
import { get_function_unit } from "./handlers/GetFunctionToolHandler"
import { get_tool_result_unit } from "./handlers/GetToolResultToolHandler"
import { list_files_unit } from "./handlers/ListFilesToolHandler"
import { list_skills_unit } from "./handlers/ListSkillsToolHandler"
import { new_task_unit } from "./handlers/NewTaskHandler"
import { plan_mode_respond_unit } from "./handlers/PlanModeRespondHandler"
import { read_file_unit } from "./handlers/ReadFileToolHandler"
import { rename_symbol_unit } from "./handlers/RenameSymbolToolHandler"
import { replace_symbol_unit } from "./handlers/ReplaceSymbolToolHandler"
import { search_files_unit } from "./handlers/SearchFilesToolHandler"
import { summarize_task_unit } from "./handlers/SummarizeTaskHandler"
import { use_skill_unit } from "./handlers/UseSkillToolHandler"
import { write_to_file_unit } from "./handlers/WriteToFileToolHandler"
import type { IToolHandler } from "./ToolExecutorCoordinator"

/**
 * Lot E — single registry of migrated tool units.
 *
 * Each unit (`xxx_unit = defineTool(...)`, co-located with its handler) pairs the
 * prompt spec with the handler factory. This array is the single source the
 * registration paths read from, replacing the duplicated `toolHandlersMap` in
 * `ToolExecutorCoordinator` and the manual import list in
 * `system-prompt/tools/init.ts`.
 *
 * IMPORTANT — exact-behavior contract (do not relax without re-checking the
 * `*.native.tools.snap` snapshots and the name→handler map):
 *
 *  - `getUnits()` returns the migrated units (handler + spec co-located). 23 of
 *    the 26 tools are here. The remaining tools are intentionally NOT units and
 *    keep their legacy registration (see `ToolExecutorCoordinator`):
 *      • `use_subagents`  — dynamic per-subagent tool names, multi-registration.
 *      • `new_rule`       — SharedToolHandler aliasing the write_to_file handler.
 *      • `condense`       — slash-command only, never exposed to the LLM.
 *      • `report_bug`     — slash-command only, never exposed to the LLM.
 *
 *  - `SPEC_SUPPRESSED_UNIT_IDS` lists units whose handler IS registered but whose
 *    spec is intentionally NOT exposed to the LLM, reproducing the historical
 *    `// generate_explanation,` comment in init.ts. Exposing it would change the
 *    native tool snapshots.
 *
 *  - Read-only membership for the checkpoint-gate (`READ_ONLY_TOOLS` in
 *    `@/shared/tools`) is a separately curated list and is deliberately NOT
 *    derived from `unit.readonly`. The two encode different concepts: `readonly`
 *    is a per-tool "does it mutate the workspace" truth flag (used elsewhere),
 *    while `READ_ONLY_TOOLS` is the curated set the initial-checkpoint gate waits
 *    on — its membership differs (e.g. it includes `use_subagents`, which has no
 *    unit, and excludes several non-mutating-but-gated tools). Deriving one from
 *    the other would silently change runtime gating behavior.
 */
const UNITS: ReadonlyArray<IsaacToolUnit<IToolHandler>> = [
	ask_followup_question_unit,
	attempt_completion_unit,
	summarize_task_unit,
	diagnostics_scan_unit,
	browser_action_unit,
	edit_file_unit,
	replace_symbol_unit,
	rename_symbol_unit,
	execute_command_unit,
	generate_explanation_unit,
	get_function_unit,
	get_file_skeleton_unit,
	get_tool_result_unit,
	find_symbol_references_unit,
	list_files_unit,
	new_task_unit,
	plan_mode_respond_unit,
	read_file_unit,
	search_files_unit,
	use_skill_unit,
	list_skills_unit,
	find_tools_unit,
	write_to_file_unit,
]

/**
 * Units whose handler is registered but whose spec is NOT exposed to the LLM.
 * Mirrors the historical commented-out `generate_explanation` entry in init.ts.
 */
export const SPEC_SUPPRESSED_UNIT_IDS: ReadonlySet<IsaacDefaultTool> = new Set([IsaacDefaultTool.GENERATE_EXPLANATION])

/** All migrated tool units (handler + spec co-located). */
export function getUnits(): ReadonlyArray<IsaacToolUnit<IToolHandler>> {
	return UNITS
}

/** Units whose spec is exposed to the LLM (drives `IsaacToolSet` registration). */
export function getExposedUnits(): ReadonlyArray<IsaacToolUnit<IToolHandler>> {
	return UNITS.filter((unit) => !SPEC_SUPPRESSED_UNIT_IDS.has(unit.id))
}
