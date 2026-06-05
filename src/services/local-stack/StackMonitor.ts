import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import type {
	JinaRoute,
	McpServerInfo,
	ProcessStatus,
	StackModel,
	StackPluginInfo,
	StackSnapshot,
} from "@shared/proto/isaac/stack"
import { loadMcpConfigsFromPlugins } from "@/core/mcp/McpServerConfigLoader"
import { pluginDiscoveryService } from "@/core/plugins/PluginDiscoveryService"
import { jinaRouterManager } from "../jina-router/JinaRouterManager"
import { liteLLMProxyManager } from "../litellm/LiteLLMProxyManager"

export type { StackSnapshot }

const TAIL_LINES = 50
const MAX_FILE_SIZE = 1_000_000 // 1 MB — do not read beyond this

/** Read the last N lines of a file safely. Returns [] on error. */
async function tailFile(filePath: string, n: number): Promise<string[]> {
	try {
		const stat = await fs.stat(filePath)
		if (stat.size > MAX_FILE_SIZE) return ["[log file too large — truncated]"]
		const raw = await fs.readFile(filePath, "utf8")
		const lines = raw.split("\n").filter((l) => l.trim().length > 0)
		return lines.slice(-n)
	} catch {
		return []
	}
}

/** Fetch model names from the proxy and check each for reachability. */
async function fetchModels(): Promise<StackModel[]> {
	// Read model names from config (reliable, no network needed)
	const configPath = path.join(os.homedir(), ".isaac", "litellm", "config.yaml")
	const modelNames: string[] = []
	try {
		const yaml = await fs.readFile(configPath, "utf8")
		// Simple regex to extract model_name values from YAML
		const matches = yaml.matchAll(/model_name:\s*(\S+)/g)
		for (const m of matches) {
			modelNames.push(m[1])
		}
	} catch {
		// Config not found — return empty
		return []
	}

	// Try to reach the proxy /v1/models endpoint
	let proxyReachable = false
	try {
		const res = await fetch("http://127.0.0.1:4000/v1/models", { signal: AbortSignal.timeout(2000) })
		if (res.ok) {
			proxyReachable = true
			// If proxy is up, fetch actual model list from it
			const data = await res.json()
			const liveNames: string[] = (data?.data ?? []).map((m: any) => String(m.id))
			if (liveNames.length > 0) {
				return liveNames.map((name) => ({ name, reachable: true }))
			}
		}
	} catch {
		// Proxy not reachable
	}

	return modelNames.map((name) => ({ name, reachable: proxyReachable }))
}

/** Read Jina router routes.json */
async function fetchRoutes(): Promise<JinaRoute[]> {
	const routesPath = path.join(os.homedir(), ".isaac", "jina-router", "routes.json")
	try {
		const raw = await fs.readFile(routesPath, "utf8")
		const data = JSON.parse(raw) as Record<string, { examples?: string[]; preferred_model?: string }>
		return Object.entries(data).map(([category, cfg]) => ({
			category,
			examples: cfg.examples ?? [],
			preferredModel: cfg.preferred_model ?? "",
		}))
	} catch {
		return []
	}
}

/** Collect MCP server info (configs + tool counts). */
async function fetchMcpServers(enabledIds?: string[]): Promise<McpServerInfo[]> {
	let configs: Awaited<ReturnType<typeof loadMcpConfigsFromPlugins>> = []
	try {
		configs = await loadMcpConfigsFromPlugins()
	} catch {
		return []
	}

	return configs.map((cfg) => {
		const enabled = !enabledIds || enabledIds.length === 0 || enabledIds.includes(cfg.id)
		return {
			id: cfg.id,
			name: cfg.pluginName ?? cfg.id,
			enabled,
			toolCount: 0, // We don't connect to get tool count here (expensive)
			toolNames: [],
		}
	})
}

/** Count files in a directory, return 0 on error. */
async function countFiles(dir: string): Promise<number> {
	try {
		const entries = await fs.readdir(dir)
		return entries.filter((e) => e.endsWith(".md") || e.endsWith(".ts") || e.endsWith(".js")).length
	} catch {
		return 0
	}
}

/** Collect plugin info from the discovery service. */
async function fetchPlugins(): Promise<StackPluginInfo[]> {
	let plugins: Awaited<ReturnType<typeof pluginDiscoveryService.discover>> = []
	try {
		plugins = await pluginDiscoveryService.discover()
	} catch {
		return []
	}

	const result: StackPluginInfo[] = []
	for (const p of plugins) {
		const skillsCount = await countFiles(path.join(p.rootDir, "skills"))
		const commandsCount = await countFiles(path.join(p.rootDir, "commands"))
		const agentsCount = await countFiles(path.join(p.rootDir, "agents"))
		// Hooks: look for .claude/hooks/ dir
		const hooksCount = await countFiles(path.join(p.rootDir, ".claude", "hooks"))
		result.push({
			name: p.manifest.name,
			path: p.rootDir,
			skillsCount,
			commandsCount,
			agentsCount,
			hooksCount,
		})
	}
	return result
}

export class StackMonitor {
	/** Aggregate all stack info into a single snapshot. */
	async snapshot(enabledMcpServers?: string[], useLocalStack?: boolean): Promise<StackSnapshot> {
		const [stackStatus, models, routes, mcpServers, plugins, proxyLogs, routerLogs] = await Promise.all([
			liteLLMProxyManager.status().then(async (proxyStatus) => {
				const routerStatus = await jinaRouterManager.status()
				return { proxyStatus, routerStatus }
			}),
			fetchModels(),
			fetchRoutes(),
			fetchMcpServers(enabledMcpServers),
			fetchPlugins(),
			tailFile(path.join(os.homedir(), ".isaac", "litellm.log"), TAIL_LINES),
			tailFile(path.join(os.homedir(), ".isaac", "jina-router.log"), TAIL_LINES),
		])

		const proxyStatus = stackStatus.proxyStatus
		const routerStatus = stackStatus.routerStatus

		const proxy: ProcessStatus = {
			running: proxyStatus.running,
			url: proxyStatus.url,
			pid: proxyStatus.pid,
			uptimeMs: proxyStatus.uptime,
		}

		const router: ProcessStatus = {
			running: routerStatus.running,
			url: routerStatus.url,
			pid: routerStatus.pid,
			uptimeMs: undefined,
		}

		return {
			proxy,
			router,
			useLocalStack: useLocalStack ?? false,
			models,
			routes,
			mcpServers,
			plugins,
			proxyLogs,
			routerLogs,
		}
	}
}

export const stackMonitor = new StackMonitor()
