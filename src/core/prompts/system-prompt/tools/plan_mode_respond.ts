import { IsaacDefaultTool } from "@/shared/tools"
import type { IsaacToolSpec } from "../spec"

const id = IsaacDefaultTool.PLAN_MODE

export const plan_mode_respond: IsaacToolSpec = {
	id,
	name: "plan_mode_respond",
	description: "Proposes a step-by-step solution plan to the user. Use only in PLAN MODE after exploring the codebase. Avoid repeating the plan in text.",
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
}
