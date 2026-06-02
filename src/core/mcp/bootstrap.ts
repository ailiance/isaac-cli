import { DiracToolSet } from "@core/prompts/system-prompt"
import type { DiracToolSpec } from "@core/prompts/system-prompt/spec"
import { StateManager } from "@core/storage/StateManager"
import type { ToolExecutor } from "@core/task/ToolExecutor"
import { Logger } from "@/shared/services/Logger"
import { DiracDefaultTool } from "@/shared/tools"
import { mcpClientManager } from "./McpClientManager"
import { McpToolHandler } from "./McpToolHandler"
import type { McpToolMetadata } from "./types"

/**
 * Converts a JSON Schema property type string to a DiracToolSpec parameter type.
 * Falls back to "string" for unknown types.
 */
function mapJsonSchemaType(type: unknown): "string" | "boolean" | "integer" | "array" | "object" {
	switch (type) {
		case "boolean":
			return "boolean"
		case "integer":
		case "number":
			return "integer"
		case "array":
			return "array"
		case "object":
			return "object"
		default:
			return "string"
	}
}

/**
 * Converts a flat JSON Schema (top-level properties only) to DiracToolSpec parameters.
 * Nested objects are preserved via the `properties` field but not recursed.
 */
export function convertJsonSchemaToParams(inputSchema: object): NonNullable<DiracToolSpec["parameters"]> {
	const schema = inputSchema as {
		properties?: Record<string, { type?: unknown; description?: string; items?: unknown; properties?: unknown }>
		required?: string[]
	}

	if (!schema.properties) {
		return []
	}

	const requiredSet = new Set<string>(Array.isArray(schema.required) ? schema.required : [])

	return Object.entries(schema.properties).map(([name, prop]) => {
		const paramType = mapJsonSchemaType(prop.type)
		const param: NonNullable<DiracToolSpec["parameters"]>[number] = {
			name,
			required: requiredSet.has(name),
			instruction: prop.description ?? name,
			type: paramType,
		}
		if (paramType === "array" && prop.items) {
			param.items = prop.items
		}
		if (paramType === "object" && prop.properties) {
			param.properties = prop.properties
		}
		return param
	})
}

/**
 * Converts an McpToolMetadata to a DiracToolSpec for LLM function-calling exposure.
 * Uses qualifiedName as both id and name so the LLM calls the tool by its full qualified name.
 */
export function mcpToolToSpec(tool: McpToolMetadata): DiracToolSpec {
	const qualifiedName = tool.qualifiedName
	return {
		// Cast is intentional: MCP tools use dynamic qualified names, not enum values.
		// The same pattern is used in McpToolHandler.
		id: qualifiedName as DiracDefaultTool,
		name: qualifiedName,
		description: tool.description ?? `MCP tool from plugin ${tool.pluginName}`,
		parameters: convertJsonSchemaToParams(tool.inputSchema),
		contextRequirements: (ctx) => ctx.activeMcpTools === undefined || ctx.activeMcpTools.has(qualifiedName),
	}
}

/**
 * Initialize MCP integration: load plugin configs, discover tools, register handlers
 * in the ToolExecutor coordinator, and expose tool specs to the LLM via DiracToolSet.
 *
 * Lazy-spawns MCP servers (only when listAllTools is called). Failures are logged
 * but never crash the boot — ailiance-agent must work without plugins.
 *
 * @param toolExecutor - The ToolExecutor instance to register MCP tool handlers on.
 * @param registerSpec - Optional override for tool spec registration (default: DiracToolSet.register).
 *                       Useful in tests to prevent polluting the shared DiracToolSet singleton.
 */
/**
 * Read MCP filter settings from StateManager if available.
 * Returns undefined for each field if StateManager is not initialized or throws.
 */
function readMcpSettings(): {
	enabledServers: string[] | undefined
	toolDenylist: string[] | undefined
	toolAllowlist: string[] | undefined
	noMcp: boolean
} {
	// Per-run CLI overrides via env take precedence over persisted settings,
	// so `isaac --no-mcp` / `isaac --mcp github,context7` can trim the (often
	// large) inherited Claude-Code plugin MCP set without touching global
	// config. AILIANCE_MCP_SERVERS="" (empty) is treated as "no servers".
	const envServersRaw = process.env.AILIANCE_MCP_SERVERS
	const envEnabled =
		envServersRaw !== undefined
			? envServersRaw
					.split(",")
					.map((s) => s.trim())
					.filter(Boolean)
			: undefined
	const noMcp =
		["1", "true", "yes"].includes((process.env.AILIANCE_NO_MCP ?? "").toLowerCase()) ||
		(envEnabled !== undefined && envEnabled.length === 0)
	try {
		const mgr = StateManager.get()
		return {
			enabledServers: envEnabled ?? mgr.getGlobalSettingsKey("enabledMcpServers"),
			toolDenylist: mgr.getGlobalSettingsKey("mcpToolDenylist"),
			toolAllowlist: mgr.getGlobalSettingsKey("mcpToolAllowlist"),
			noMcp,
		}
	} catch {
		// StateManager not initialized yet (e.g. in some tests) — env overrides still apply.
		return { enabledServers: envEnabled, toolDenylist: undefined, toolAllowlist: undefined, noMcp }
	}
}

export async function initializeMcpForTask(
	toolExecutor: ToolExecutor,
	registerSpec: (spec: ReturnType<typeof mcpToolToSpec>) => void = (spec) => DiracToolSet.register(spec),
): Promise<McpToolMetadata[]> {
	try {
		const { enabledServers, toolDenylist, toolAllowlist, noMcp } = readMcpSettings()

		if (noMcp) {
			// --no-mcp (or an empty --mcp allowlist): run with zero plugin MCP
			// servers. Keeps the agent prompt small for big-context backends.
			return []
		}

		await mcpClientManager.loadFromPlugins(enabledServers ? { enabledServers } : undefined)

		const toolFilter = toolAllowlist || toolDenylist ? { allowlist: toolAllowlist, denylist: toolDenylist } : undefined
		const tools = await mcpClientManager.listAllTools(toolFilter)

		for (const tool of tools) {
			try {
				toolExecutor.registerMcpTool(tool.qualifiedName, new McpToolHandler(tool))
				registerSpec(mcpToolToSpec(tool))
			} catch (err) {
				Logger.warn(`MCP: failed to register tool ${tool.qualifiedName}:`, err)
			}
		}

		if (tools.length > 0) {
			Logger.info(`MCP: registered ${tools.length} tool(s) from plugins`)
		}

		// Adaptive retrieval: build the vector index and publish a session active set.
		const { ActiveMcpToolSet } = await import("./retrieval/ActiveMcpToolSet")
		const { getRetrievalConfig } = await import("./retrieval/config")
		const { setActiveMcpToolSet } = await import("./retrieval/session")
		try {
			const { createDefaultEmbedder } = await import("./retrieval/Embedder")
			const { ToolVectorIndex } = await import("./retrieval/ToolVectorIndex")
			const os = await import("os")
			const path = await import("path")
			const cachePath = path.join(os.homedir(), ".dirac", "mcp-tool-vectors.json")
			const embedder = createDefaultEmbedder()
			const index = await new ToolVectorIndex(embedder, cachePath).build(
				tools.map((t) => ({ qualifiedName: t.qualifiedName, text: `${t.qualifiedName}\n${t.description ?? ""}` })),
			)
			setActiveMcpToolSet(new ActiveMcpToolSet(embedder, index, getRetrievalConfig()))
		} catch (err) {
			Logger.warn("MCP adaptive retrieval unavailable; running native-only:", err)
			const { Embedder } = await import("./retrieval/Embedder")
			const dead = new Embedder(async () => {
				throw new Error("embedder unavailable")
			})
			setActiveMcpToolSet(new ActiveMcpToolSet(dead, new Map(), getRetrievalConfig()))
		}

		return tools
	} catch (err) {
		Logger.warn("MCP initialization failed (continuing without plugins):", err)
		return []
	}
}
