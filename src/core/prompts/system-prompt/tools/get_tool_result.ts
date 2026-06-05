import { IsaacDefaultTool } from "@/shared/tools"
import type { IsaacToolSpec } from "../spec"
import type { ParamNames } from "../tool-unit"

const id = IsaacDefaultTool.GET_TOOL_RESULT

export const get_tool_result = {
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
} as const satisfies IsaacToolSpec

/**
 * Lot E: typed param-name union derived from the spec literal above.
 * The handler reads `task_id`/`wait`/`timeout_ms` with bespoke null/empty-string
 * handling and numeric coercion that `readParam` (which String()s non-undefined
 * values) would not preserve, so the scalar reads are intentionally left raw; the
 * typed link is preserved via this export + the `get_tool_result_unit`. A
 * rename/removal of a spec parameter changes this union and breaks the unit.
 */
export type GetToolResultParam = ParamNames<typeof get_tool_result>
