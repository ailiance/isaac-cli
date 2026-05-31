import { expect } from "chai"
import fs from "fs/promises"
import { afterEach, beforeEach, describe, it } from "vitest"
import os from "os"
import path from "path"

import type { DiscoveredPlugin } from "../../plugins/PluginDiscoveryService"

// We test loadMcpConfigsFromPlugins by patching pluginDiscoveryService.discover()
// to return fake plugins pointing at a tmpdir, without touching the real ~/.claude/plugins.

async function createFakePlugin(
	baseDir: string,
	owner: string,
	name: string,
	version: string,
	manifest: object,
): Promise<DiscoveredPlugin> {
	const versionDir = path.join(baseDir, owner, name, version)
	await fs.mkdir(path.join(versionDir, ".claude-plugin"), { recursive: true })
	await fs.writeFile(path.join(versionDir, ".claude-plugin", "plugin.json"), JSON.stringify(manifest))
	return {
		manifest: manifest as any,
		rootDir: versionDir,
		marketplaceOwner: owner,
		pluginId: name,
	}
}

describe("McpServerConfigLoader", () => {
	let tmpDir: string
	let pluginDiscoveryModule: typeof import("../../plugins/PluginDiscoveryService")
	let loaderModule: typeof import("../McpServerConfigLoader")

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "isaac-mcp-test-"))
		pluginDiscoveryModule = await import("../../plugins/PluginDiscoveryService")
		loaderModule = await import("../McpServerConfigLoader")
	})

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true })
		// Invalidate cache so next test starts fresh
		pluginDiscoveryModule.pluginDiscoveryService.invalidate()
	})

	it("returns empty array when no plugin has .mcp.json", async () => {
		const fakePlugin = await createFakePlugin(tmpDir, "owner", "plugin-no-mcp", "1.0.0", {
			name: "plugin-no-mcp",
		})

		const original = pluginDiscoveryModule.pluginDiscoveryService.discover.bind(pluginDiscoveryModule.pluginDiscoveryService)
		;(pluginDiscoveryModule.pluginDiscoveryService as any).discover = async () => [fakePlugin]

		const { loadMcpConfigsFromPlugins } = loaderModule
		const result = await loadMcpConfigsFromPlugins()
		expect(result).to.deep.equal([])

		;(pluginDiscoveryModule.pluginDiscoveryService as any).discover = original
	})

	it("parses a valid .mcp.json and returns McpServerConfig", async () => {
		const fakePlugin = await createFakePlugin(tmpDir, "owner", "plugin-with-mcp", "1.0.0", {
			name: "plugin-with-mcp",
		})

		const mcpJson = {
			mcpServers: {
				"my-server": {
					type: "stdio",
					command: "/usr/bin/node",
					args: ["server.js", "--port", "3000"],
				},
			},
		}
		await fs.writeFile(path.join(fakePlugin.rootDir, ".mcp.json"), JSON.stringify(mcpJson))

		;(pluginDiscoveryModule.pluginDiscoveryService as any).discover = async () => [fakePlugin]

		const { loadMcpConfigsFromPlugins } = loaderModule
		const result = await loadMcpConfigsFromPlugins()
		expect(result).to.have.length(1)
		expect(result[0].id).to.equal("my-server")
		expect(result[0].pluginName).to.equal("plugin-with-mcp")
		expect(result[0].type).to.equal("stdio")
		expect(result[0].command).to.equal("/usr/bin/node")
		expect(result[0].args).to.deep.equal(["server.js", "--port", "3000"])

		;(pluginDiscoveryModule.pluginDiscoveryService as any).discover = async () => []
	})

	it("dedupes the same server id across plugins (first plugin wins)", async () => {
		const pluginA = await createFakePlugin(tmpDir, "owner", "plugin-a", "1.0.0", { name: "plugin-a" })
		const pluginB = await createFakePlugin(tmpDir, "owner", "plugin-b", "1.0.0", { name: "plugin-b" })
		const mkMcp = (pkg: string) => ({
			mcpServers: { context7: { type: "stdio", command: "npx", args: ["-y", pkg] } },
		})
		await fs.writeFile(path.join(pluginA.rootDir, ".mcp.json"), JSON.stringify(mkMcp("@upstash/context7-mcp@2.1.4")))
		await fs.writeFile(path.join(pluginB.rootDir, ".mcp.json"), JSON.stringify(mkMcp("@upstash/context7-mcp")))

		;(pluginDiscoveryModule.pluginDiscoveryService as any).discover = async () => [pluginA, pluginB]

		const { loadMcpConfigsFromPlugins } = loaderModule
		const result = await loadMcpConfigsFromPlugins()
		const context7s = result.filter((c) => c.id === "context7")
		expect(context7s).to.have.length(1)
		expect(context7s[0].pluginName).to.equal("plugin-a") // first declarer wins
		expect(context7s[0].args).to.deep.equal(["-y", "@upstash/context7-mcp@2.1.4"])

		;(pluginDiscoveryModule.pluginDiscoveryService as any).discover = async () => []
	})

	it("expands ${CLAUDE_PLUGIN_ROOT} in command and args", async () => {
		const fakePlugin = await createFakePlugin(tmpDir, "owner", "plugin-expand", "1.0.0", {
			name: "plugin-expand",
		})

		const mcpJson = {
			mcpServers: {
				"expand-server": {
					type: "stdio",
					command: "${CLAUDE_PLUGIN_ROOT}/bin/server",
					args: ["--root", "${CLAUDE_PLUGIN_ROOT}/data"],
				},
			},
		}
		await fs.writeFile(path.join(fakePlugin.rootDir, ".mcp.json"), JSON.stringify(mcpJson))

		;(pluginDiscoveryModule.pluginDiscoveryService as any).discover = async () => [fakePlugin]

		const { loadMcpConfigsFromPlugins } = loaderModule
		const result = await loadMcpConfigsFromPlugins()
		expect(result).to.have.length(1)
		expect(result[0].command).to.equal(`${fakePlugin.rootDir}/bin/server`)
		expect(result[0].args).to.deep.equal([`--root`, `${fakePlugin.rootDir}/data`])

		;(pluginDiscoveryModule.pluginDiscoveryService as any).discover = async () => []
	})

	it("swallows malformed .mcp.json without throwing", async () => {
		const fakePlugin = await createFakePlugin(tmpDir, "owner", "plugin-bad-json", "1.0.0", {
			name: "plugin-bad-json",
		})

		await fs.writeFile(path.join(fakePlugin.rootDir, ".mcp.json"), "{ invalid json }")

		;(pluginDiscoveryModule.pluginDiscoveryService as any).discover = async () => [fakePlugin]

		const { loadMcpConfigsFromPlugins } = loaderModule
		// Should not throw, returns empty array
		const result = await loadMcpConfigsFromPlugins()
		expect(result).to.deep.equal([])

		;(pluginDiscoveryModule.pluginDiscoveryService as any).discover = async () => []
	})

	it("loads an http server (type=http) with its url and headers", async () => {
		const fakePlugin = await createFakePlugin(tmpDir, "owner", "plugin-http", "1.0.0", { name: "plugin-http" })
		const mcpJson = {
			mcpServers: {
				exa: {
					type: "http",
					url: "https://mcp.exa.ai/mcp",
					headers: { "X-Source-Name": "isaac" },
				},
			},
		}
		await fs.writeFile(path.join(fakePlugin.rootDir, ".mcp.json"), JSON.stringify(mcpJson))

		;(pluginDiscoveryModule.pluginDiscoveryService as any).discover = async () => [fakePlugin]

		const { loadMcpConfigsFromPlugins } = loaderModule
		const result = await loadMcpConfigsFromPlugins()
		expect(result).to.have.length(1)
		expect(result[0].id).to.equal("exa")
		expect(result[0].type).to.equal("http")
		expect((result[0] as { url?: string }).url).to.equal("https://mcp.exa.ai/mcp")
		expect((result[0] as { headers?: Record<string, string> }).headers).to.deep.equal({ "X-Source-Name": "isaac" })

		;(pluginDiscoveryModule.pluginDiscoveryService as any).discover = async () => []
	})

	it("skips an http server that has no url", async () => {
		const fakePlugin = await createFakePlugin(tmpDir, "owner", "plugin-http-bad", "1.0.0", { name: "plugin-http-bad" })
		await fs.writeFile(
			path.join(fakePlugin.rootDir, ".mcp.json"),
			JSON.stringify({ mcpServers: { broken: { type: "http" } } }),
		)

		;(pluginDiscoveryModule.pluginDiscoveryService as any).discover = async () => [fakePlugin]

		const { loadMcpConfigsFromPlugins } = loaderModule
		const result = await loadMcpConfigsFromPlugins()
		expect(result).to.deep.equal([])

		;(pluginDiscoveryModule.pluginDiscoveryService as any).discover = async () => []
	})
})
