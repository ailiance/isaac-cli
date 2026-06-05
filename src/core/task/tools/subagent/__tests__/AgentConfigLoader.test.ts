import { strict as assert } from "node:assert"
import fs from "fs/promises"
import { afterEach, describe, it } from "mocha"
import os from "os"
import * as path from "path"
import sinon from "sinon"
import * as pluginModule from "@/core/plugins/PluginDiscoveryService"
import { IsaacDefaultTool, getToolUseNames } from "@/shared/tools"
import {
	AgentConfigLoader,
	getAgentsConfigPath,
	parseAgentConfigFromYaml,
	readAgentConfigsFromDisk,
	readPluginAgentConfigs,
} from "../AgentConfigLoader"

async function createTempHomeDir(): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), "agent-config-loader-"))
}

describe("AgentConfigLoader", () => {
	const tempDirs: string[] = []

	afterEach(async () => {
		await AgentConfigLoader.resetInstanceForTests()
		await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })))
		tempDirs.length = 0
	})

	it("parses an Agents.yaml frontmatter config and system prompt body", () => {
		const content = `---
name: code-reviewer
description: Reviews code for quality and best practices
tools: read_file, list_files, search_files
modelId: sonnet
---

You are a code reviewer.`

		const parsed = parseAgentConfigFromYaml(content)

		assert.equal(parsed.name, "code-reviewer")
		assert.equal(parsed.description, "Reviews code for quality and best practices")
		assert.equal(parsed.modelId, "sonnet")
		assert.deepEqual(parsed.tools, [IsaacDefaultTool.FILE_READ, IsaacDefaultTool.LIST_FILES, IsaacDefaultTool.SEARCH])
		assert.equal(parsed.systemPrompt, "You are a code reviewer.")
	})

	it("supports raw Isaac tool ids in tools", () => {
		const content = `---
name: cli-agent
description: Uses internal ids
tools:
  - read_file
  - list_files
modelId: sonnet
---

Prompt body`

		const parsed = parseAgentConfigFromYaml(content)
		assert.deepEqual(parsed.tools, [IsaacDefaultTool.FILE_READ, IsaacDefaultTool.LIST_FILES])
	})

	it("throws for unknown tools", () => {
		const content = `---
name: bad-agent
description: bad
tools: Read, NotARealTool
modelId: sonnet
---

Prompt body`

		assert.throws(() => parseAgentConfigFromYaml(content), /Unknown tool/)
	})

	it("returns an empty config map when the agents directory does not exist", async () => {
		const tempHome = await createTempHomeDir()
		tempDirs.push(tempHome)

		const result = await readAgentConfigsFromDisk(tempHome)
		assert.equal(result.size, 0)
	})

	it("loads all yaml/yml files from homeDir/.dirac/data/agents", async () => {
		const tempHome = await createTempHomeDir()
		tempDirs.push(tempHome)

		const directoryPath = getAgentsConfigPath(tempHome)
		await fs.mkdir(directoryPath, { recursive: true })
		await fs.writeFile(
			path.join(directoryPath, "local-agent.yaml"),
			`---
name: local-agent
description: local agent
tools: read_file
modelId: sonnet
---

Prompt body`,
			"utf8",
		)
		await fs.writeFile(
			path.join(directoryPath, "reviewer.yml"),
			`---
name: reviewer
description: reviewer agent
tools: list_files
modelId: sonnet
---

Reviewer prompt`,
			"utf8",
		)
		await fs.writeFile(path.join(directoryPath, "ignored.txt"), "not yaml", "utf8")

		const loader = AgentConfigLoader.getInstance(tempHome)
		await loader.load()

		const localAgent = loader.getCachedConfig("local-agent")
		const reviewer = loader.getCachedConfig("reviewer")
		assert.equal(localAgent?.name, "local-agent")
		assert.deepEqual(localAgent?.tools, [IsaacDefaultTool.FILE_READ])
		assert.equal(localAgent?.systemPrompt, "Prompt body")
		assert.equal(reviewer?.name, "reviewer")
		assert.deepEqual(reviewer?.tools, [IsaacDefaultTool.LIST_FILES])
		assert.equal(loader.getAllCachedConfigs().size, 2)
	})

	it("creates dynamic subagent tool mappings after loading configs", async () => {
		const tempHome = await createTempHomeDir()
		tempDirs.push(tempHome)

		const directoryPath = getAgentsConfigPath(tempHome)
		await fs.mkdir(directoryPath, { recursive: true })
		await fs.writeFile(
			path.join(directoryPath, "code-reviewer.yaml"),
			`---
name: code reviewer
description: reviewer agent
tools: read_file
modelId: sonnet
---

Reviewer prompt`,
			"utf8",
		)

		const loader = AgentConfigLoader.getInstance(tempHome)
		await loader.load()

		const withToolNames = loader.getAllCachedConfigsWithToolNames()
		assert.equal(withToolNames.length, 1)
		assert.equal(withToolNames[0].config.name, "code reviewer")
		assert.equal(loader.resolveSubagentNameForTool(withToolNames[0].toolName), "code reviewer")
		assert.equal(loader.isDynamicSubagentTool(withToolNames[0].toolName), true)
		assert.ok(getToolUseNames().includes(withToolNames[0].toolName))
	})
})

describe("readPluginAgentConfigs", () => {
	let tmpDir: string
	let sandbox: sinon.SinonSandbox

	afterEach(async () => {
		sandbox.restore()
		await fs.rm(tmpDir, { recursive: true, force: true })
	})

	it("loads agents from plugin agents directories", async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-agents-"))
		sandbox = sinon.createSandbox()

		// Create a plugin agents directory with one agent
		const agentsDir = path.join(tmpDir, "agents")
		await fs.mkdir(agentsDir, { recursive: true })
		await fs.writeFile(
			path.join(agentsDir, "linter.md"),
			`---
description: Checks code style issues
model: claude-sonnet-4-5
---

You are a linting agent.`,
			"utf8",
		)

		sandbox.stub(pluginModule.pluginDiscoveryService, "getAgentsDirectories").resolves([agentsDir])

		const configs = await readPluginAgentConfigs()

		assert.equal(configs.size, 1)
		const agent = configs.get("linter")
		assert.equal(agent?.name, "linter")
		assert.equal(agent?.description, "Checks code style issues")
		assert.equal(agent?.modelId, "claude-sonnet-4-5")
		assert.equal(agent?.systemPrompt, "You are a linting agent.")
		assert.deepEqual(agent?.tools, [])
	})

	it("skips malformed plugin agent files gracefully", async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-agents-"))
		sandbox = sinon.createSandbox()

		const agentsDir = path.join(tmpDir, "agents")
		await fs.mkdir(agentsDir, { recursive: true })
		// Missing description — should throw during parse, be skipped
		await fs.writeFile(path.join(agentsDir, "bad.md"), `---\nmodel: x\n---\n\nNo description here.`, "utf8")
		// Valid agent
		await fs.writeFile(path.join(agentsDir, "good.md"), `---\ndescription: A good agent\n---\n\nGood prompt.`, "utf8")

		sandbox.stub(pluginModule.pluginDiscoveryService, "getAgentsDirectories").resolves([agentsDir])

		const configs = await readPluginAgentConfigs()

		// Only good.md loaded
		assert.equal(configs.size, 1)
		assert.ok(configs.has("good"))
		assert.ok(!configs.has("bad"))
	})

	it("returns empty map when plugin agents directory does not exist", async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-agents-"))
		sandbox = sinon.createSandbox()

		const nonExistentDir = path.join(tmpDir, "agents-nonexistent")
		sandbox.stub(pluginModule.pluginDiscoveryService, "getAgentsDirectories").resolves([nonExistentDir])

		const configs = await readPluginAgentConfigs()
		assert.equal(configs.size, 0)
	})
})
