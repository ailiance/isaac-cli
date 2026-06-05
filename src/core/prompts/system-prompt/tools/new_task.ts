import { IsaacDefaultTool } from "@/shared/tools"
import type { IsaacToolSpec } from "../spec"
import type { ParamNames } from "../tool-unit"

const id = IsaacDefaultTool.NEW_TASK

export const new_task = {
	id,
	name: "new_task",
	description: "Creates a new task with preloaded context from the current conversation.",
	parameters: [
		{
			name: "context",
			required: true,
			instruction:
				"Detailed summary of the conversation so far, including current work, technical concepts, modified files, problems solved, and exact pending next steps.",
			usage: "Detailed conversation summary here",
		},
	],
} as const satisfies IsaacToolSpec

/**
 * Lot E: typed param-name union derived from the spec literal above.
 * The handler reads the scalar `context` param through this contract; a
 * rename/removal of a spec parameter changes this union and breaks the handler
 * compile (kills drift).
 */
export type NewTaskParam = ParamNames<typeof new_task>
