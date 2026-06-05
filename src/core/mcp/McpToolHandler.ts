import type { ToolUse } from "@core/assistant-message"
import type { ToolResponse } from "@core/task/index"
import type { IFullyManagedTool } from "@core/task/tools/ToolExecutorCoordinator"
import type { TaskConfig } from "@core/task/tools/types/TaskConfig"
import type { StronglyTypedUIHelpers } from "@core/task/tools/types/UIHelpers"
import { IsaacDefaultTool } from "@/shared/tools"
import { mcpClientManager } from "./McpClientManager"
import type { McpToolMetadata } from "./types"

/**
 * Format raw MCP content (text/image/resource array or string) into a plain string.
 */
export function formatMcpContent(content: unknown): string {
	if (typeof content === "string") return content
	if (Array.isArray(content)) {
		return content
			.map((c) => {
				if (typeof c === "string") return c
				if (typeof c === "object" && c !== null && "type" in c) {
					const item = c as Record<string, unknown>
					if (item.type === "text" && typeof item.text === "string") return item.text
					if (item.type === "image") return "[image]"
					if (item.type === "resource") return JSON.stringify(c)
				}
				return JSON.stringify(c)
			})
			.join("\n")
	}
	return JSON.stringify(content)
}

/**
 * Tool handler that delegates execution to an MCP server via McpClientManager.
 * Registered per-tool in ToolExecutorCoordinator for each discovered MCP tool.
 */
export class McpToolHandler implements IFullyManagedTool {
	readonly name: IsaacDefaultTool

	constructor(public readonly toolMetadata: McpToolMetadata) {
		// Cast is intentional: MCP tools use dynamic qualified names, not enum values.
		// ToolExecutorCoordinator.handlers is Map<string, IToolHandler> so lookup works by string.
		this.name = toolMetadata.qualifiedName as IsaacDefaultTool
	}

	getDescription(_block: ToolUse): string {
		return `[mcp: ${this.toolMetadata.qualifiedName}]`
	}

	async handlePartialBlock(_block: ToolUse, _uiHelpers: StronglyTypedUIHelpers): Promise<void> {
		// MCP tools do not support streaming partial blocks
	}

	async execute(_config: TaskConfig, block: ToolUse): Promise<ToolResponse> {
		const args: Record<string, unknown> = block.params ?? {}
		try {
			const result = await mcpClientManager.callTool(this.toolMetadata.qualifiedName, args)
			const text = formatMcpContent(result.content)
			if (result.isError) {
				return `[mcp error] ${text}`
			}
			return text
		} catch (err) {
			return `[mcp error] ${err instanceof Error ? err.message : String(err)}`
		}
	}
}
