import { DiracToolSet } from "../registry/DiracToolSet"
import { ask_followup_question } from "./ask_followup_question"
import { attempt_completion } from "./attempt_completion"
import { diagnostics_scan } from "./diagnostics_scan"
import { browser_action } from "./browser_action"
import { edit_file } from "./edit_file"
import { execute_command } from "./execute_command"
import { find_symbol_references } from "./find_symbol_references"

import { get_file_skeleton } from "./get_file_skeleton"
import { get_function } from "./get_function"
import { get_tool_result } from "./get_tool_result"
import { list_files } from "./list_files"
import { new_task } from "./new_task"
import { plan_mode_respond } from "./plan_mode_respond"
import { read_file } from "./read_file"
import { replace_symbol } from "./replace_symbol"
import { rename_symbol } from "./rename_symbol"
import { search_files } from "./search_files"
import { subagent } from "./subagent"
import { summarize_task } from "./summarize_task"
import { use_skill } from "./use_skill"
import { list_skills } from "./list_skills"
import { write_to_file } from "./write_to_file"

/**
 * Registers all tools with the DiracToolSet provider.
 */
export function registerDiracToolSets(): void {
	const allTools = [
		ask_followup_question,
		attempt_completion,
		summarize_task,
		diagnostics_scan,
		browser_action,
		edit_file,
		replace_symbol,
		rename_symbol,
		execute_command,

		// generate_explanation,
		get_function,
		get_file_skeleton,
		get_tool_result,
		find_symbol_references,

		list_files,
		new_task,
		plan_mode_respond,
		read_file,
		search_files,
		subagent,
		use_skill,
		list_skills,
		write_to_file,
	]

	allTools.forEach((tool) => {
		DiracToolSet.register(tool)
	})
}
