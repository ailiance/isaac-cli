import { IsaacDefaultTool } from "@/shared/tools"
import type { IsaacToolSpec } from "../spec"

const id = IsaacDefaultTool.SUMMARIZE_TASK

export const summarize_task: IsaacToolSpec = {
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
}
