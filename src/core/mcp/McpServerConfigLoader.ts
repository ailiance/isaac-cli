import { promises as fs } from "node:fs"
import path from "node:path"

import { Logger } from "@/shared/services/Logger"

import { pluginDiscoveryService } from "../plugins/PluginDiscoveryService"
import type { McpServerConfig } from "./types"

interface RawMcpJson {
	mcpServers?: Record<
		string,
		{
			type?: string
			command?: string
			args?: string[]
			url?: string
			headers?: Record<string, string>
		}
	>
}

function expandPluginRoot(value: string, pluginRoot: string): string {
	return value.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, pluginRoot)
}

export async function loadMcpConfigsFromPlugins(): Promise<McpServerConfig[]> {
	const plugins = await pluginDiscoveryService.discover()
	const configs: McpServerConfig[] = []
	// Dedupe by server id across plugins: several plugins ship the same MCP
	// server (e.g. context7 + sequential-thinking from both ecc and
	// oh-my-claude). Loading both spawns duplicate processes and double-counts
	// their tools in the agent prompt. First plugin to declare it wins.
	const seenServers = new Map<string, string>()

	for (const plugin of plugins) {
		const mcpJsonPath = path.join(plugin.rootDir, ".mcp.json")
		let raw: string
		try {
			raw = await fs.readFile(mcpJsonPath, "utf8")
		} catch {
			// plugin has no .mcp.json — skip silently
			continue
		}

		let parsed: RawMcpJson
		try {
			parsed = JSON.parse(raw) as RawMcpJson
		} catch {
			// malformed JSON — warn and skip
			Logger.warn(`[mcp] Malformed .mcp.json in plugin ${plugin.manifest.name} (${mcpJsonPath}), skipping`)
			continue
		}

		const servers = parsed.mcpServers ?? {}
		for (const [serverId, server] of Object.entries(servers)) {
			const kind = server.type ?? "stdio"
			if (kind !== "stdio" && kind !== "http") continue

			// Validate required fields per transport before claiming the id, so an
			// invalid entry doesn't shadow a valid same-id server from a later plugin.
			if (kind === "stdio" && !server.command) {
				Logger.warn(`[mcp] Server "${serverId}" in plugin ${plugin.manifest.name} has no command, skipping`)
				continue
			}
			if (kind === "http" && !server.url) {
				Logger.warn(`[mcp] HTTP server "${serverId}" in plugin ${plugin.manifest.name} has no url, skipping`)
				continue
			}

			const dupOwner = seenServers.get(serverId)
			if (dupOwner !== undefined) {
				Logger.warn(
					`[mcp] Duplicate server "${serverId}" from plugin ${plugin.manifest.name} ignored (already provided by ${dupOwner})`,
				)
				continue
			}
			seenServers.set(serverId, plugin.manifest.name)

			const pluginRoot = plugin.rootDir
			if (kind === "http") {
				configs.push({
					id: serverId,
					pluginName: plugin.manifest.name,
					pluginRoot,
					type: "http",
					url: server.url!,
					headers: server.headers,
				})
			} else {
				configs.push({
					id: serverId,
					pluginName: plugin.manifest.name,
					pluginRoot,
					type: "stdio",
					command: expandPluginRoot(server.command!, pluginRoot),
					args: (server.args ?? []).map((a) => expandPluginRoot(a, pluginRoot)),
				})
			}
		}
	}

	return configs
}
