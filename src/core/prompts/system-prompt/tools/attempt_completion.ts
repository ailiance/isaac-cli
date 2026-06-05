import { IsaacDefaultTool } from "@/shared/tools"
import type { IsaacToolSpec } from "../spec"
import type { ParamNames } from "../tool-unit"

const id = IsaacDefaultTool.ATTEMPT

export const attempt_completion = {
	id,
	name: "attempt_completion",
	description:
		"Presents a brief and informative summary of the final result. Keep it concise while covering important changes. Avoid redundant text.",
	parameters: [
		{
			name: "result",
			required: true,
			instruction: "The final result of the task.",
			usage: "I have completed the task...",
		},
		{
			name: "command",
			required: false,
			instruction: "Optional CLI command to demo the result (e.g., 'open index.html'). Do not use 'echo' or 'cat'.",
			usage: "open index.html",
		},
	],
} as const satisfies IsaacToolSpec

/**
 * Lot E: typed param-name union derived from the spec literal above.
 * The handler reads the scalar `result`/`command` params through this contract;
 * a rename/removal of a spec parameter changes this union and breaks the handler
 * compile (kills drift).
 */
export type AttemptCompletionParam = ParamNames<typeof attempt_completion>

export const attempt_completion_variants = [attempt_completion]
