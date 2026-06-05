import { IsaacDefaultTool } from "@/shared/tools"
import type { IsaacToolSpec } from "../spec"
import type { ParamNames } from "../tool-unit"

export const find_tools = {
	id: IsaacDefaultTool.FIND_TOOLS,
	name: "find_tools",
	description:
		"Discover and activate additional MCP tools that are not currently available to you. " +
		"Only a relevant subset of external (MCP) tools is loaded by default to keep the tool list small. " +
		"If you need a capability you don't see (e.g. interacting with GitHub, a database, a browser, etc.), " +
		"call find_tools with a short natural-language description of the capability you need. The matching " +
		'tools become available on your next turn. Example: { query: "search and comment on GitHub issues" }.',
	parameters: [
		{
			name: "query",
			required: true,
			instruction: "A short natural-language description of the capability or tool you need.",
		},
	],
} as const satisfies IsaacToolSpec

/**
 * Lot E: typed param-name union derived from the spec literal above.
 * The handler reads the scalar `query` param through this contract; a
 * rename/removal of a spec parameter changes this union and breaks the handler
 * compile (kills drift).
 */
export type FindToolsParam = ParamNames<typeof find_tools>
