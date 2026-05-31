import type { Client } from "@modelcontextprotocol/sdk/client"
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"

interface McpServerConfigBase {
	id: string
	pluginName: string
	pluginRoot: string
}

/** A plugin-provided MCP server launched as a stdio subprocess. */
export interface McpStdioServerConfig extends McpServerConfigBase {
	type: "stdio"
	command: string
	args: string[]
}

/** A plugin-provided MCP server reached over Streamable HTTP (e.g. exa, supabase). */
export interface McpHttpServerConfig extends McpServerConfigBase {
	type: "http"
	url: string
	headers?: Record<string, string>
}

export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig

export interface ConnectedClient {
	config: McpServerConfig
	client: Client
	transport: Transport
	startedAt: Date
}

export interface McpToolMetadata {
	qualifiedName: string
	serverId: string
	pluginName: string
	rawName: string
	description?: string
	inputSchema: object
}

export interface McpToolResult {
	qualifiedName: string
	isError: boolean
	content: unknown // raw from SDK; usually Array<{ type: "text"; text: string } | ...>
}

export function makeQualifiedToolName(plugin: string, server: string, tool: string): string {
	const sanitize = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "_")
	return `mcp__${sanitize(plugin)}_${sanitize(server)}__${sanitize(tool)}`
}
