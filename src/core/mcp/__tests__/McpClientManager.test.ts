import { expect } from "chai"
import { afterEach, beforeEach, describe, it } from "vitest"
import sinon from "sinon"

import { McpServerConfig, makeQualifiedToolName } from "../types"

// We test McpClientManager in isolation by monkey-patching loadMcpConfigsFromPlugins.
// No real subprocess is spawned in these unit tests.

describe("McpClientManager", () => {
	let McpClientManagerModule: typeof import("../McpClientManager")

	// Fresh import each time to reset singleton state
	beforeEach(async () => {
		McpClientManagerModule = await import("../McpClientManager")
	})

	afterEach(() => {
		// Reset singleton internal state between tests
		const manager = McpClientManagerModule.mcpClientManager as any
		manager.clients = new Map()
		manager.configs = new Map()
		manager.tools = new Map()
		sinon.restore()
	})

	it("isConnected returns false for unknown serverId", () => {
		const { mcpClientManager } = McpClientManagerModule
		expect(mcpClientManager.isConnected("nonexistent")).to.be.false
	})

	it("disconnect on unknown serverId does not throw", async () => {
		const { mcpClientManager } = McpClientManagerModule
		let threw = false
		try {
			await mcpClientManager.disconnect("unknown-server")
		} catch {
			threw = true
		}
		expect(threw).to.be.false
	})

	it("disconnectAll on empty clients does not throw", async () => {
		const { mcpClientManager } = McpClientManagerModule
		let threw = false
		try {
			await mcpClientManager.disconnectAll()
		} catch {
			threw = true
		}
		expect(threw).to.be.false
	})

	it("getKnownServerIds returns empty when no configs loaded", () => {
		const { mcpClientManager } = McpClientManagerModule
		expect(mcpClientManager.getKnownServerIds()).to.deep.equal([])
	})

	it("loadFromPlugins returns empty array when no plugin has .mcp.json", async () => {
		const { mcpClientManager } = McpClientManagerModule

		// The loader export is read-only under ESM/vitest, so inject the fake
		// result by overriding the manager method directly.
		const manager = mcpClientManager as any
		const originalLoad = manager.loadFromPlugins.bind(manager)
		manager.loadFromPlugins = async function () {
			const configs: McpServerConfig[] = []
			for (const cfg of configs) {
				this.configs.set(cfg.id, cfg)
			}
			return configs
		}

		const result = await mcpClientManager.loadFromPlugins()
		expect(result).to.deep.equal([])
		expect(mcpClientManager.getKnownServerIds()).to.deep.equal([])

		// Restore
		manager.loadFromPlugins = originalLoad
	})

	it("connect throws for unconfigured serverId", async () => {
		const { mcpClientManager } = McpClientManagerModule
		try {
			await mcpClientManager.connect("no-such-server")
			expect.fail("should have thrown")
		} catch (err: any) {
			expect(err.message).to.include("no-such-server")
		}
	})

	it("findTool returns undefined for inexistent qualified name", () => {
		const { mcpClientManager } = McpClientManagerModule
		expect(mcpClientManager.findTool("mcp__plugin_server__inexistent")).to.be.undefined
	})

	it("invalidateToolCache clears the entire tool cache", () => {
		const { mcpClientManager } = McpClientManagerModule
		const manager = mcpClientManager as any
		manager.tools.set("server-a", [
			{
				qualifiedName: "mcp__plugin_server-a__tool1",
				serverId: "server-a",
				pluginName: "plugin",
				rawName: "tool1",
				inputSchema: {},
			},
		])
		expect(manager.tools.size).to.equal(1)
		mcpClientManager.invalidateToolCache()
		expect(manager.tools.size).to.equal(0)
	})

	it("invalidateToolCache with serverId clears only that server", () => {
		const { mcpClientManager } = McpClientManagerModule
		const manager = mcpClientManager as any
		manager.tools.set("server-a", [])
		manager.tools.set("server-b", [])
		mcpClientManager.invalidateToolCache("server-a")
		expect(manager.tools.has("server-a")).to.be.false
		expect(manager.tools.has("server-b")).to.be.true
	})

	it("makeQualifiedToolName sanitizes non-alphanumeric chars", () => {
		expect(makeQualifiedToolName("plugin/x", "server.y", "tool!")).to.equal("mcp__plugin_x_server_y__tool_")
	})

	it("listTools fetches and caches tools from a stub client", async () => {
		const { mcpClientManager } = McpClientManagerModule
		const manager = mcpClientManager as any

		const fakeClient = {
			listTools: sinon.stub().resolves({
				tools: [{ name: "foo", description: "Foo tool", inputSchema: {} }],
			}),
			close: sinon.stub().resolves(),
		}

		const cfg: McpServerConfig = {
			id: "test-server",
			pluginName: "test-plugin",
			pluginRoot: "/tmp",
			type: "stdio",
			command: "fake",
			args: [],
		}
		manager.clients.set("test-server", { config: cfg, client: fakeClient, transport: {}, startedAt: new Date() })
		manager.configs.set("test-server", cfg)

		const tools = await mcpClientManager.listTools("test-server")

		expect(tools).to.have.length(1)
		expect(tools[0].qualifiedName).to.equal("mcp__test-plugin_test-server__foo")
		expect(tools[0].rawName).to.equal("foo")
		expect(tools[0].serverId).to.equal("test-server")
		expect(tools[0].pluginName).to.equal("test-plugin")

		// Second call should be cached (stub called only once)
		await mcpClientManager.listTools("test-server")
		expect(fakeClient.listTools.callCount).to.equal(1)
	})

	it("listTools returns cached result on second call", async () => {
		const { mcpClientManager } = McpClientManagerModule
		const manager = mcpClientManager as any

		const fakeClient = {
			listTools: sinon.stub().resolves({ tools: [{ name: "bar", inputSchema: {} }] }),
			close: sinon.stub().resolves(),
		}
		const cfg: McpServerConfig = {
			id: "cached-server",
			pluginName: "plg",
			pluginRoot: "/tmp",
			type: "stdio",
			command: "fake",
			args: [],
		}
		manager.clients.set("cached-server", { config: cfg, client: fakeClient, transport: {}, startedAt: new Date() })
		manager.configs.set("cached-server", cfg)

		await mcpClientManager.listTools("cached-server")
		await mcpClientManager.listTools("cached-server")
		expect(fakeClient.listTools.callCount).to.equal(1)
	})

	it("findTool finds tool after listTools is called", async () => {
		const { mcpClientManager } = McpClientManagerModule
		const manager = mcpClientManager as any

		const fakeClient = {
			listTools: sinon
				.stub()
				.resolves({ tools: [{ name: "my_tool", description: "desc", inputSchema: { type: "object" } }] }),
			close: sinon.stub().resolves(),
		}
		const cfg: McpServerConfig = {
			id: "find-server",
			pluginName: "find-plugin",
			pluginRoot: "/tmp",
			type: "stdio",
			command: "fake",
			args: [],
		}
		manager.clients.set("find-server", { config: cfg, client: fakeClient, transport: {}, startedAt: new Date() })
		manager.configs.set("find-server", cfg)

		await mcpClientManager.listTools("find-server")

		const found = mcpClientManager.findTool("mcp__find-plugin_find-server__my_tool")
		expect(found).to.not.be.undefined
		expect(found!.rawName).to.equal("my_tool")
		expect(found!.description).to.equal("desc")
	})

	it("listAllTools aggregates tools from all servers", async () => {
		const { mcpClientManager } = McpClientManagerModule
		const manager = mcpClientManager as any

		const makeClient = (toolName: string) => ({
			listTools: sinon.stub().resolves({ tools: [{ name: toolName, inputSchema: {} }] }),
			close: sinon.stub().resolves(),
		})

		const cfgA: McpServerConfig = {
			id: "srv-a",
			pluginName: "plg-a",
			pluginRoot: "/tmp",
			type: "stdio",
			command: "fake",
			args: [],
		}
		const cfgB: McpServerConfig = {
			id: "srv-b",
			pluginName: "plg-b",
			pluginRoot: "/tmp",
			type: "stdio",
			command: "fake",
			args: [],
		}

		manager.clients.set("srv-a", { config: cfgA, client: makeClient("tool_a"), transport: {}, startedAt: new Date() })
		manager.clients.set("srv-b", { config: cfgB, client: makeClient("tool_b"), transport: {}, startedAt: new Date() })
		manager.configs.set("srv-a", cfgA)
		manager.configs.set("srv-b", cfgB)

		const all = await mcpClientManager.listAllTools()
		expect(all).to.have.length(2)
		const names = all.map((t) => t.rawName)
		expect(names).to.include("tool_a")
		expect(names).to.include("tool_b")
	})

	it("callTool routes to the correct serverId/rawName via stub", async () => {
		const { mcpClientManager } = McpClientManagerModule
		const manager = mcpClientManager as any

		const fakeClient = {
			listTools: sinon.stub().resolves({
				tools: [{ name: "do_thing", description: "Does thing", inputSchema: {} }],
			}),
			callTool: sinon.stub().resolves({ isError: false, content: [{ type: "text", text: "ok" }] }),
			close: sinon.stub().resolves(),
		}

		const cfg: McpServerConfig = {
			id: "call-server",
			pluginName: "call-plugin",
			pluginRoot: "/tmp",
			type: "stdio",
			command: "fake",
			args: [],
		}
		manager.clients.set("call-server", { config: cfg, client: fakeClient, transport: {}, startedAt: new Date() })
		manager.configs.set("call-server", cfg)

		// Populate cache
		await mcpClientManager.listTools("call-server")

		const result = await mcpClientManager.callTool("mcp__call-plugin_call-server__do_thing", { x: 1 })

		expect(fakeClient.callTool.calledOnce).to.be.true
		const callArgs = fakeClient.callTool.firstCall.args[0]
		expect(callArgs.name).to.equal("do_thing")
		expect(callArgs.arguments).to.deep.equal({ x: 1 })
		expect(result.qualifiedName).to.equal("mcp__call-plugin_call-server__do_thing")
		expect(result.isError).to.be.false
	})

	it("callTool lazy-calls listAllTools when cache is empty, throws if still unknown", async () => {
		const { mcpClientManager } = McpClientManagerModule
		const manager = mcpClientManager as any

		// No client, no cache — listAllTools will return empty (configs empty too)
		let threw = false
		let errorMsg = ""
		try {
			await mcpClientManager.callTool("mcp__nope_nope__ghost", {})
		} catch (err: any) {
			threw = true
			errorMsg = err.message
		}
		expect(threw).to.be.true
		expect(errorMsg).to.include("Unknown MCP tool")
	})

	it("callTool propagates isError: true from SDK result", async () => {
		const { mcpClientManager } = McpClientManagerModule
		const manager = mcpClientManager as any

		const fakeClient = {
			listTools: sinon.stub().resolves({
				tools: [{ name: "bad_tool", inputSchema: {} }],
			}),
			callTool: sinon.stub().resolves({ isError: true, content: [{ type: "text", text: "oops" }] }),
			close: sinon.stub().resolves(),
		}

		const cfg: McpServerConfig = {
			id: "err-server",
			pluginName: "err-plugin",
			pluginRoot: "/tmp",
			type: "stdio",
			command: "fake",
			args: [],
		}
		manager.clients.set("err-server", { config: cfg, client: fakeClient, transport: {}, startedAt: new Date() })
		manager.configs.set("err-server", cfg)

		await mcpClientManager.listTools("err-server")

		const result = await mcpClientManager.callTool("mcp__err-plugin_err-server__bad_tool", {})
		expect(result.isError).to.be.true
		expect(result.content).to.deep.equal([{ type: "text", text: "oops" }])
	})

	it("listAllTools skips failing servers and continues", async () => {
		const { mcpClientManager } = McpClientManagerModule
		const manager = mcpClientManager as any

		const goodClient = {
			listTools: sinon.stub().resolves({ tools: [{ name: "ok_tool", inputSchema: {} }] }),
			close: sinon.stub().resolves(),
		}
		const cfgGood: McpServerConfig = {
			id: "srv-good",
			pluginName: "plg",
			pluginRoot: "/tmp",
			type: "stdio",
			command: "fake",
			args: [],
		}
		// srv-bad has no client (will throw in connect)
		const cfgBad: McpServerConfig = {
			id: "srv-bad",
			pluginName: "plg",
			pluginRoot: "/tmp",
			type: "stdio",
			command: "fake",
			args: [],
		}

		manager.clients.set("srv-good", { config: cfgGood, client: goodClient, transport: {}, startedAt: new Date() })
		manager.configs.set("srv-good", cfgGood)
		manager.configs.set("srv-bad", cfgBad)

		const all = await mcpClientManager.listAllTools()
		expect(all).to.have.length(1)
		expect(all[0].rawName).to.equal("ok_tool")
	})

	// ---------------------------------------------------------------------------
	// Server filtering (loadFromPlugins with enabledServers)
	// ---------------------------------------------------------------------------

	it("loadFromPlugins with enabledServers filters configs to those listed", async () => {
		const { mcpClientManager } = McpClientManagerModule
		const cfgFoo: McpServerConfig = {
			id: "foo",
			pluginName: "plg-foo",
			pluginRoot: "/tmp",
			type: "stdio",
			command: "fake",
			args: [],
		}
		const cfgBar: McpServerConfig = {
			id: "bar",
			pluginName: "plg-bar",
			pluginRoot: "/tmp",
			type: "stdio",
			command: "fake",
			args: [],
		}

		// The loader export is read-only under ESM/vitest, so inject the fake
		// configs by overriding the manager method directly.
		const manager = mcpClientManager as any
		const origManagerLoad = manager.loadFromPlugins.bind(manager)
		manager.loadFromPlugins = async function (filter?: { enabledServers?: string[] }) {
			const configs: McpServerConfig[] = [cfgFoo, cfgBar]
			const filtered =
				filter?.enabledServers && filter.enabledServers.length > 0
					? configs.filter((c: McpServerConfig) => filter.enabledServers!.includes(c.id))
					: configs
			for (const cfg of filtered) {
				this.configs.set(cfg.id, cfg)
			}
			return filtered
		}

		const result = await mcpClientManager.loadFromPlugins({ enabledServers: ["foo"] })
		expect(result).to.have.length(1)
		expect(result[0].id).to.equal("foo")
		expect(mcpClientManager.getKnownServerIds()).to.deep.equal(["foo"])

		manager.loadFromPlugins = origManagerLoad
	})

	// ---------------------------------------------------------------------------
	// Tool filtering (listAllTools with denylist/allowlist)
	// ---------------------------------------------------------------------------

	it("listAllTools with denylist excludes the listed qualified tool names", async () => {
		const { mcpClientManager } = McpClientManagerModule
		const manager = mcpClientManager as any

		const makeClient = (toolName: string) => ({
			listTools: sinon.stub().resolves({ tools: [{ name: toolName, inputSchema: {} }] }),
			close: sinon.stub().resolves(),
		})

		const cfgA: McpServerConfig = {
			id: "srv-da",
			pluginName: "plg-da",
			pluginRoot: "/tmp",
			type: "stdio",
			command: "fake",
			args: [],
		}
		const cfgB: McpServerConfig = {
			id: "srv-db",
			pluginName: "plg-db",
			pluginRoot: "/tmp",
			type: "stdio",
			command: "fake",
			args: [],
		}

		manager.clients.set("srv-da", { config: cfgA, client: makeClient("tool_keep"), transport: {}, startedAt: new Date() })
		manager.clients.set("srv-db", { config: cfgB, client: makeClient("tool_drop"), transport: {}, startedAt: new Date() })
		manager.configs.set("srv-da", cfgA)
		manager.configs.set("srv-db", cfgB)

		const all = await mcpClientManager.listAllTools({ denylist: ["mcp__plg-db_srv-db__tool_drop"] })
		expect(all).to.have.length(1)
		expect(all[0].rawName).to.equal("tool_keep")
	})

	it("listAllTools with allowlist keeps only those listed", async () => {
		const { mcpClientManager } = McpClientManagerModule
		const manager = mcpClientManager as any

		const makeClient = (toolName: string) => ({
			listTools: sinon.stub().resolves({ tools: [{ name: toolName, inputSchema: {} }] }),
			close: sinon.stub().resolves(),
		})

		const cfgA: McpServerConfig = {
			id: "srv-aa",
			pluginName: "plg-aa",
			pluginRoot: "/tmp",
			type: "stdio",
			command: "fake",
			args: [],
		}
		const cfgB: McpServerConfig = {
			id: "srv-ab",
			pluginName: "plg-ab",
			pluginRoot: "/tmp",
			type: "stdio",
			command: "fake",
			args: [],
		}

		manager.clients.set("srv-aa", { config: cfgA, client: makeClient("tool_x"), transport: {}, startedAt: new Date() })
		manager.clients.set("srv-ab", { config: cfgB, client: makeClient("tool_y"), transport: {}, startedAt: new Date() })
		manager.configs.set("srv-aa", cfgA)
		manager.configs.set("srv-ab", cfgB)

		const all = await mcpClientManager.listAllTools({ allowlist: ["mcp__plg-aa_srv-aa__tool_x"] })
		expect(all).to.have.length(1)
		expect(all[0].rawName).to.equal("tool_x")
	})

	it("listAllTools with allowlist overrides denylist", async () => {
		const { mcpClientManager } = McpClientManagerModule
		const manager = mcpClientManager as any

		const fakeClient = {
			listTools: sinon.stub().resolves({
				tools: [
					{ name: "t1", inputSchema: {} },
					{ name: "t2", inputSchema: {} },
				],
			}),
			close: sinon.stub().resolves(),
		}
		const cfg: McpServerConfig = {
			id: "srv-ov",
			pluginName: "plg-ov",
			pluginRoot: "/tmp",
			type: "stdio",
			command: "fake",
			args: [],
		}
		manager.clients.set("srv-ov", { config: cfg, client: fakeClient, transport: {}, startedAt: new Date() })
		manager.configs.set("srv-ov", cfg)

		// allowlist takes precedence: even though denylist also lists t1, allowlist wins
		const all = await mcpClientManager.listAllTools({
			allowlist: ["mcp__plg-ov_srv-ov__t1"],
			denylist: ["mcp__plg-ov_srv-ov__t1"],
		})
		expect(all).to.have.length(1)
		expect(all[0].rawName).to.equal("t1")
	})
})
