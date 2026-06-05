import { expect } from "chai"
import fs from "fs/promises"
import { afterEach, beforeEach, describe, it } from "mocha"
import os from "os"
import path from "path"
import sinon from "sinon"

import * as pluginModule from "@/core/plugins/PluginDiscoveryService"
import { StateManager } from "@/core/storage/StateManager"
import { getGlobalIsaacRules } from "../dirac-rules"

describe("getGlobalIsaacRules — plugin CLAUDE.md injection", () => {
	let tmpDir: string
	let sandbox: sinon.SinonSandbox
	let discoveryStub: sinon.SinonStub
	let stateManagerStub: sinon.SinonStub

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "isaac-plugin-rules-"))
		sandbox = sinon.createSandbox()

		// Stub StateManager.get() to avoid singleton issues in tests
		stateManagerStub = sandbox.stub(StateManager, "get").returns({
			getGlobalStateKey: () => undefined,
		} as any)

		// Default: no plugin CLAUDE.md files
		discoveryStub = sandbox.stub(pluginModule.pluginDiscoveryService, "getClaudeMdPaths").resolves([])
	})

	afterEach(async () => {
		sandbox.restore()
		await fs.rm(tmpDir, { recursive: true, force: true })
	})

	it("includes plugin CLAUDE.md content in global rules when file exists", async () => {
		// Create a fake CLAUDE.md for the plugin
		const pluginRootDir = path.join(tmpDir, "myplugin")
		await fs.mkdir(pluginRootDir, { recursive: true })
		const mdPath = path.join(pluginRootDir, "CLAUDE.md")
		await fs.writeFile(mdPath, "Always use snake_case for identifiers.")

		// Stub discovery to return our plugin
		discoveryStub.resolves([{ pluginName: "my-awesome-plugin", mdPath }])

		// Create an empty global rules dir (no file-based rules)
		const rulesDir = path.join(tmpDir, ".diracrules")
		await fs.mkdir(rulesDir, { recursive: true })

		const result = await getGlobalIsaacRules(rulesDir, {})

		expect(result.instructions).to.be.a("string")
		expect(result.instructions).to.include("my-awesome-plugin")
		expect(result.instructions).to.include("Always use snake_case for identifiers.")
	})

	it("skips plugins whose CLAUDE.md does not exist (fail-open)", async () => {
		const missingMdPath = path.join(tmpDir, "nonexistent", "CLAUDE.md")
		discoveryStub.resolves([{ pluginName: "ghost-plugin", mdPath: missingMdPath }])

		const rulesDir = path.join(tmpDir, ".diracrules")
		await fs.mkdir(rulesDir, { recursive: true })

		// Should not throw — no instructions from missing plugin
		const result = await getGlobalIsaacRules(rulesDir, {})

		// No file-based rules + empty plugin = no instructions
		expect(result.instructions).to.be.undefined
	})

	it("merges plugin CLAUDE.md with existing file-based rules", async () => {
		// Plugin CLAUDE.md
		const pluginDir = path.join(tmpDir, "pluginA")
		await fs.mkdir(pluginDir, { recursive: true })
		const mdPath = path.join(pluginDir, "CLAUDE.md")
		await fs.writeFile(mdPath, "Plugin-specific rule here.")
		discoveryStub.resolves([{ pluginName: "plugin-a", mdPath }])

		// File-based rule
		const rulesDir = path.join(tmpDir, ".diracrules")
		await fs.mkdir(rulesDir, { recursive: true })
		await fs.writeFile(path.join(rulesDir, "global-rule.md"), "Global project rule.")

		const result = await getGlobalIsaacRules(rulesDir, {
			[path.join(rulesDir, "global-rule.md")]: true,
		})

		expect(result.instructions).to.include("global-rule.md")
		expect(result.instructions).to.include("Global project rule.")
		expect(result.instructions).to.include("plugin-a")
		expect(result.instructions).to.include("Plugin-specific rule here.")
	})
})
