import type { ToolUse } from "@core/assistant-message"
import { getActiveMcpToolSet } from "@core/mcp/retrieval/session"
import { DiracDefaultTool } from "@/shared/tools"
import type { ToolResponse } from "../../index"
import type { IPartialBlockHandler, IToolHandler } from "../ToolExecutorCoordinator"
import type { TaskConfig } from "../types/TaskConfig"
import type { StronglyTypedUIHelpers } from "../types/UIHelpers"

export class FindToolsToolHandler implements IToolHandler, IPartialBlockHandler {
	readonly name = DiracDefaultTool.FIND_TOOLS

	constructor() {}

	getDescription(block: ToolUse): string {
		return `[find_tools for '${(block.params?.query as string) || ""}']`
	}

	async handlePartialBlock(_block: ToolUse, _uiHelpers: StronglyTypedUIHelpers): Promise<void> {
		// no-op: no streaming UI needed for find_tools
	}

	async execute(_config: TaskConfig, block: ToolUse): Promise<ToolResponse> {
		const query = ((block.params?.query as string) || "").trim()
		const set = getActiveMcpToolSet()
		if (!set || !set.available()) {
			return "Tool retrieval is unavailable in this run; the default tool set is all that is available."
		}
		if (!query) {
			return "find_tools requires a non-empty 'query' describing the capability you need."
		}
		const added = await set.expand(query)
		if (added.length === 0) {
			return `No additional tools matched "${query}". The relevant tools may already be available, or none exist for this need.`
		}
		return `Activated ${added.length} tool(s) for "${query}" (available next turn):\n${added.map((n) => `- ${n}`).join("\n")}`
	}
}
