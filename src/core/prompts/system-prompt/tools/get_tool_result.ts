import { DiracDefaultTool } from "@/shared/tools"
import type { DiracToolSpec } from "../spec"

const id = DiracDefaultTool.GET_TOOL_RESULT

export const get_tool_result: DiracToolSpec = {
	id,
	name: "get_tool_result",
	description:
		"Retrieve the result of an asynchronous tool call previously launched by execute_command, search_files, or list_files (when recursive=true). Use this when one of those tools returned a placeholder of the form 'task_id: <ULID>\\nstatus: running' instead of an immediate result. You may keep working on independent tasks in parallel — the async work runs in the background.",
	parameters: [
		{
			name: "task_id",
			required: true,
			type: "string",
			instruction: "The task identifier (ULID) returned by the async tool.",
			usage: "01HXYZ…",
		},
		{
			name: "wait",
			required: false,
			type: "boolean",
			instruction:
				"If true (default), block until the task completes or timeout_ms expires. If false, return current status immediately.",
			usage: "true or false (optional, default true)",
		},
		{
			name: "timeout_ms",
			required: false,
			type: "integer",
			instruction: "How long to wait for completion when wait=true. Default 60000ms, hard-capped at 300000ms (5 minutes).",
			usage: "60000 (optional)",
		},
	],
}
