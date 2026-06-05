import { IsaacDefaultTool } from "@/shared/tools"
import type { IsaacToolSpec } from "../spec"

const id = IsaacDefaultTool.LIST_SKILLS

export const list_skills = {
	id,
	name: "list_skills",
	description:
		"List all available skills and their descriptions. Use this to discover specialized capabilities when the initial list in the system prompt is truncated.",
	contextRequirements: (context) => context.skills !== undefined && context.skills.length > 0,
} as const satisfies IsaacToolSpec

/**
 * Lot E: this tool declares no `parameters`, so there is no param-name union to
 * derive (`ParamNames` would resolve to `never`) — no `XxxParam` export is
 * emitted. The drift-detecting typed link is therefore not applicable here; the
 * tool is still wrapped in a `list_skills_unit` for registration parity. The
 * `contextRequirements` gate is preserved verbatim by `as const satisfies`.
 */
