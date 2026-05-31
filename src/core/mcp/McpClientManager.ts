import { createHash } from "node:crypto"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"

import { Client } from "@modelcontextprotocol/sdk/client"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"

import { Logger } from "../../shared/services/Logger"
import { loadMcpConfigsFromPlugins } from "./McpServerConfigLoader"
import type { ConnectedClient, McpServerConfig, McpToolMetadata, McpToolResult } from "./types"
import { makeQualifiedToolName } from "./types"

export interface McpLoadFilter {
	enabledServers?: string[]
}

export interface McpToolFilter {
	denylist?: string[]
	allowlist?: string[]
}

// ---------------------------------------------------------------------------
// Startup performance: enumerating MCP tools for the system prompt used to
// spawn every stdio server serially on every `isaac` invocation (~1-3s each,
// ~13s+ for a full plugin set). Two mitigations live here:
//   1. A disk cache of tool metadata keyed by each server's config hash, so a
//      warm run reads the tool list from ~/.isaac/mcp-tools-cache.json and
//      spawns NOTHING — servers boot lazily only when a tool is actually
//      called (see callTool -> connect).
//   2. Cold fetches (cache miss / expired / changed config) run with bounded
//      concurrency instead of serially, and each connect is time-boxed so one
//      slow server can't stall the whole startup.
// ---------------------------------------------------------------------------

const CACHE_FILE = path.join(os.homedir(), ".isaac", "mcp-tools-cache.json")
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000 // 24h
const CACHE_TTL_MS = Number(process.env.ISAAC_MCP_CACHE_TTL_MS) || DEFAULT_TTL_MS
const CONNECT_TIMEOUT_MS = Number(process.env.ISAAC_MCP_CONNECT_TIMEOUT_MS) || 15_000
const MAX_CONCURRENCY = Number(process.env.ISAAC_MCP_CONCURRENCY) || 8
const FORCE_REFRESH = ["1", "true", "yes"].includes((process.env.ISAAC_MCP_REFRESH ?? "").toLowerCase())
// Never touch the user's real cache from the test harnesses (mocha sets
// TS_NODE_PROJECT, vitest sets VITEST). Mirrors the guard in TelemetryService.
const CACHE_DISABLED =
	!!process.env.TS_NODE_PROJECT || !!process.env.MOCHA || !!process.env.VITEST || process.env.ISAAC_MCP_CACHE === "0"

interface DiskCacheEntry {
	configHash: string
	cachedAt: number
	tools: McpToolMetadata[]
}
type DiskCache = Record<string, DiskCacheEntry>

function configHash(cfg: McpServerConfig): string {
	const basis =
		cfg.type === "http"
			? JSON.stringify(["http", cfg.url, cfg.headers ?? null])
			: JSON.stringify(["stdio", cfg.command, cfg.args])
	return createHash("sha1").update(basis).digest("hex").slice(0, 16)
}


function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
		p.then(
			(v) => {
				clearTimeout(timer)
				resolve(v)
			},
			(e) => {
				clearTimeout(timer)
				reject(e)
			},
		)
	})
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
	const results = new Array<R>(items.length)
	let next = 0
	const worker = async () => {
		for (;;) {
			const i = next++
			if (i >= items.length) return
			results[i] = await fn(items[i], i)
		}
	}
	await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length || 1) }, worker))
	return results
}

class McpClientManager {
	private clients = new Map<string, ConnectedClient>()
	private configs = new Map<string, McpServerConfig>()
	private tools = new Map<string, McpToolMetadata[]>()

	private diskCache: DiskCache | null = null
	private diskCacheDirty = false

	async loadFromPlugins(filter?: McpLoadFilter): Promise<McpServerConfig[]> {
		const configs = await loadMcpConfigsFromPlugins()
		const filtered =
			filter?.enabledServers && filter.enabledServers.length > 0
				? configs.filter((cfg) => filter.enabledServers!.includes(cfg.id))
				: configs
		for (const cfg of filtered) {
			this.configs.set(cfg.id, cfg)
		}
		return filtered
	}

	async connect(serverId: string): Promise<Client> {
		const existing = this.clients.get(serverId)
		if (existing) return existing.client

		const cfg = this.configs.get(serverId)
		if (!cfg) throw new Error(`MCP server "${serverId}" not configured`)

		let transport: Parameters<Client["connect"]>[0]
		if (cfg.type === "http") {
			// Dynamic import so the streamableHttp module (and its ESM-only
			// eventsource-parser dep) is pulled in only when an HTTP server connects.
			// esbuild bundles it into the dist; the MCP unit tests run under vitest
			// (native ESM), so this no longer needs the old new Function() shim.
			const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js")
			transport = new StreamableHTTPClientTransport(
				new URL(cfg.url),
				cfg.headers ? { requestInit: { headers: cfg.headers } } : undefined,
			)
		} else {
			transport = new StdioClientTransport({
				command: cfg.command,
				args: cfg.args,
				env: { ...process.env, CLAUDE_PLUGIN_ROOT: cfg.pluginRoot },
			})
		}

		const client = new Client({ name: "isaac", version: "0.1.0" }, { capabilities: {} })

		try {
			await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, `MCP "${serverId}" connect`)
		} catch (err) {
			// Don't leak the spawned subprocess if the handshake stalls/fails.
			try {
				await client.close()
			} catch {
				// ignore
			}
			throw err
		}

		this.clients.set(serverId, {
			config: cfg,
			client,
			transport,
			startedAt: new Date(),
		})

		return client
	}

	async disconnect(serverId: string): Promise<void> {
		const c = this.clients.get(serverId)
		if (!c) return
		try {
			await c.client.close()
		} catch {
			// swallow
		}
		this.clients.delete(serverId)
	}

	async disconnectAll(): Promise<void> {
		for (const id of [...this.clients.keys()]) {
			await this.disconnect(id)
		}
	}

	isConnected(serverId: string): boolean {
		return this.clients.has(serverId)
	}

	getKnownServerIds(): string[] {
		return [...this.configs.keys()]
	}

	// --- disk cache helpers ---------------------------------------------------

	private async loadDiskCache(): Promise<DiskCache> {
		if (this.diskCache) return this.diskCache
		if (CACHE_DISABLED) {
			this.diskCache = {}
			return this.diskCache
		}
		try {
			const raw = await fs.readFile(CACHE_FILE, "utf8")
			const parsed = JSON.parse(raw) as DiskCache
			this.diskCache = parsed && typeof parsed === "object" ? parsed : {}
		} catch {
			// missing / corrupt cache = start empty
			this.diskCache = {}
		}
		return this.diskCache
	}

	private async persistDiskCacheIfDirty(): Promise<void> {
		if (CACHE_DISABLED || !this.diskCacheDirty || !this.diskCache) return
		this.diskCacheDirty = false
		try {
			await fs.mkdir(path.dirname(CACHE_FILE), { recursive: true })
			// tmp + rename is atomic per write (no torn reads). Across concurrent
			// isaac processes this is last-writer-wins at the file level: a process
			// that didn't touch some servers can drop another's just-written
			// entries. Accepted — the TTL makes the next cold re-fetch cheap
			// (~1.7s for the full set) and concurrent cold boots are rare.
			const tmp = `${CACHE_FILE}.${process.pid}.tmp`
			await fs.writeFile(tmp, JSON.stringify(this.diskCache), "utf8")
			await fs.rename(tmp, CACHE_FILE) // atomic
		} catch (err) {
			Logger.warn("MCP: failed to persist tool cache:", err)
		}
	}

	/**
	 * Resolve a server's tool metadata, populating the in-memory map. Uses the
	 * disk cache when fresh (no subprocess spawned); otherwise connects, lists,
	 * and records the result for next time. Never persists by itself — callers
	 * flush once via persistDiskCacheIfDirty to avoid concurrent writes.
	 */
	private async fetchTools(serverId: string): Promise<McpToolMetadata[]> {
		const cached = this.tools.get(serverId)
		if (cached) return cached

		const config = this.configs.get(serverId)
		if (!config) throw new Error(`MCP server "${serverId}" not configured`)

		if (!FORCE_REFRESH && !CACHE_DISABLED) {
			const disk = await this.loadDiskCache()
			const entry = disk[serverId]
			if (entry && entry.configHash === configHash(config) && Date.now() - entry.cachedAt < CACHE_TTL_MS) {
				this.tools.set(serverId, entry.tools)
				return entry.tools
			}
		}

		const client = await this.connect(serverId)
		const result = await client.listTools()
		const metadata: McpToolMetadata[] = result.tools.map((t) => ({
			qualifiedName: makeQualifiedToolName(config.pluginName, serverId, t.name),
			serverId,
			pluginName: config.pluginName,
			rawName: t.name,
			description: t.description,
			inputSchema: t.inputSchema as object,
		}))
		this.tools.set(serverId, metadata)

		if (!CACHE_DISABLED) {
			const disk = await this.loadDiskCache()
			disk[serverId] = { configHash: configHash(config), cachedAt: Date.now(), tools: metadata }
			this.diskCacheDirty = true
		}

		return metadata
	}

	async listTools(serverId: string): Promise<McpToolMetadata[]> {
		const tools = await this.fetchTools(serverId)
		await this.persistDiskCacheIfDirty()
		return tools
	}

	async listAllTools(filter?: McpToolFilter): Promise<McpToolMetadata[]> {
		const serverIds = [...this.configs.keys()]

		// Cold servers (cache miss) connect concurrently with a bounded pool;
		// warm servers resolve instantly from the disk cache. One slow/hanging
		// server is time-boxed in connect() and skipped, not blocking the rest.
		const perServer = await mapWithConcurrency(serverIds, MAX_CONCURRENCY, async (serverId) => {
			try {
				return await this.fetchTools(serverId)
			} catch (err) {
				Logger.warn(`Failed to list tools for MCP server "${serverId}":`, err)
				return [] as McpToolMetadata[]
			}
		})
		await this.persistDiskCacheIfDirty()

		const all = perServer.flat()

		if (!filter) return all

		if (filter.allowlist && filter.allowlist.length > 0) {
			return all.filter((t) => filter.allowlist!.includes(t.qualifiedName))
		}
		if (filter.denylist && filter.denylist.length > 0) {
			return all.filter((t) => !filter.denylist!.includes(t.qualifiedName))
		}
		return all
	}

	findTool(qualifiedName: string): McpToolMetadata | undefined {
		for (const tools of this.tools.values()) {
			const found = tools.find((t) => t.qualifiedName === qualifiedName)
			if (found) return found
		}
		return undefined
	}

	invalidateToolCache(serverId?: string): void {
		if (serverId) this.tools.delete(serverId)
		else this.tools.clear()
		// Also purge the disk cache, otherwise the next fetchTools would re-serve
		// the stale on-disk entry (fresh within its TTL) and the invalidation
		// would be a no-op for up to 24h. Best-effort / fire-and-forget: the
		// in-memory clear above already took effect synchronously.
		void this.purgeDiskCache(serverId)
	}

	private async purgeDiskCache(serverId?: string): Promise<void> {
		if (CACHE_DISABLED) return
		try {
			const disk = await this.loadDiskCache()
			if (serverId) {
				if (disk[serverId]) {
					delete disk[serverId]
					this.diskCacheDirty = true
				}
			} else if (Object.keys(disk).length > 0) {
				this.diskCache = {}
				this.diskCacheDirty = true
			}
			await this.persistDiskCacheIfDirty()
		} catch (err) {
			Logger.warn("MCP: failed to purge tool cache:", err)
		}
	}

	/**
	 * Execute an MCP tool via its qualified name.
	 * Lazy-spawns the underlying server if not connected yet.
	 * Returns the raw MCP result (text + isError).
	 */
	async callTool(qualifiedName: string, args: Record<string, unknown>): Promise<McpToolResult> {
		let meta = this.findTool(qualifiedName)
		if (!meta) {
			// Lazy: populate cache via listAllTools, then retry
			await this.listAllTools()
			meta = this.findTool(qualifiedName)
			if (!meta) {
				throw new Error(`Unknown MCP tool: ${qualifiedName}`)
			}
		}

		const client = await this.connect(meta.serverId)
		const result = await client.callTool({
			name: meta.rawName,
			arguments: args,
		})

		return {
			qualifiedName,
			isError: result.isError === true,
			content: result.content,
		}
	}
}

export const mcpClientManager = new McpClientManager()
