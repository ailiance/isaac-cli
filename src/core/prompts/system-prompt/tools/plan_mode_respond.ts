import { IsaacDefaultTool } from "@/shared/tools"
import type { IsaacToolSpec } from "../spec"
import type { ParamNames } from "../tool-unit"

const id = IsaacDefaultTool.PLAN_MODE

export const plan_mode_respond = {
	id,
	name: "plan_mode_respond",
	description:
		"Proposes a step-by-step solution plan to the user. Use only in PLAN MODE after exploring the codebase. Avoid repeating the plan in text.",
	parameters: [
		{
			name: "response",
			required: true,
			instruction: "The response to provide to the user.",
			usage: "Your response here",
		},
		{
			name: "needs_more_exploration",
			required: false,
			instruction: "Set to true if more exploration is required.",
			usage: "true or false",
			type: "boolean",
		},
	],
} as const satisfies IsaacToolSpec

/**
 * Lot E: typed param-name union derived from the spec literal above.
 * The handler reads the scalar `response`/`needs_more_exploration` params through
 * this contract (the latter compared to the literal "true"); the `options` field
 * the handler also reads is a legacy alias not part of the spec. A rename/removal
 * of a spec parameter changes this union and breaks the handler compile.
 */
export type PlanModeRespondParam = ParamNames<typeof plan_mode_respond>
