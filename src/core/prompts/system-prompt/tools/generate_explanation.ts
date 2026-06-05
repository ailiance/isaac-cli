import { IsaacDefaultTool } from "@/shared/tools"
import type { IsaacToolSpec } from "../spec"
import type { ParamNames } from "../tool-unit"

const id = IsaacDefaultTool.GENERATE_EXPLANATION

export const generate_explanation = {
	id,
	name: "generate_explanation",
	description:
		"Opens a multi-file diff view and generates AI-powered inline comments explaining the changes between two git references. Use this tool to help users understand code changes from git commits, pull requests, branches, or any git refs. The tool uses git to retrieve file contents and displays a side-by-side diff view with explanatory comments.",
	contextRequirements: (context) => context.isCliEnvironment !== true,
	parameters: [
		{
			name: "title",
			required: true,
			instruction:
				"A descriptive title for the diff view (e.g., 'Changes in commit abc123', 'PR #42: Add authentication', 'Changes between main and feature-branch')",
			usage: "Changes in last commit",
		},
		{
			name: "from_ref",
			required: true,
			instruction:
				"The git reference for the 'before' state. Can be a commit hash, branch name, tag, or relative reference like HEAD~1, HEAD^, origin/main, etc.",
			usage: "HEAD~1",
		},
		{
			name: "to_ref",
			required: false,
			instruction:
				"The git reference for the 'after' state. Can be a commit hash, branch name, tag, or relative reference. If not provided, compares to the current working directory (including uncommitted changes).",
			usage: "HEAD",
		},
	],
} as const satisfies IsaacToolSpec

/**
 * Lot E: typed param-name union derived from the spec literal above.
 * The handler reads the scalar `title`/`from_ref`/`to_ref` params through this
 * contract. The `contextRequirements` gate is preserved verbatim by
 * `as const satisfies IsaacToolSpec`. A rename/removal of a spec parameter
 * changes this union and breaks the handler compile (kills drift).
 */
export type GenerateExplanationParam = ParamNames<typeof generate_explanation>
