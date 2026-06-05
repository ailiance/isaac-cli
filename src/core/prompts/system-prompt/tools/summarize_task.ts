import { IsaacDefaultTool } from "@/shared/tools"
import type { IsaacToolSpec } from "../spec"
import type { ParamNames } from "../tool-unit"

const id = IsaacDefaultTool.SUMMARIZE_TASK

export const summarize_task = {
	id,
	name: "summarize_task",
	description: "Summarize the task to free up context window space.",
	parameters: [
		{
			name: "context",
			required: true,
			type: "string",
			instruction:
				"Detailed summary of the conversation so far, including current work, technical concepts, modified files, problems solved, and exact pending next steps.",
		},
		{
			name: "required_files",
			required: false,
			type: "array",
			items: { type: "string" },
			instruction: "List of relative paths to the most important files needed to continue the task.",
		},
	],
	contextRequirements: (context) => context.shouldCompact === true,
} as const satisfies IsaacToolSpec

/**
 * Lot E: typed param-name union derived from the spec literal above.
 * The handler reads the scalar `context` param through this contract; the array
 * `required_files` is read raw as `string[]`. The `contextRequirements` gate is
 * preserved verbatim by `as const satisfies IsaacToolSpec`. A rename/removal of
 * a spec parameter changes this union and breaks the handler compile.
 */
export type SummarizeTaskParam = ParamNames<typeof summarize_task>
