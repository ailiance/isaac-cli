import { strict as assert } from "node:assert"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import * as pathUtils from "@utils/path"
import { IsaacDefaultTool } from "@shared/tools"
import { afterEach, beforeEach, describe, it } from "mocha"
import sinon from "sinon"
import { TaskState } from "../../../TaskState"
import { ToolValidator } from "../../ToolValidator"
import type { TaskConfig } from "../../types/TaskConfig"
import { ReadFileToolHandler } from "../ReadFileToolHandler"

/**
 * Tests for the ReadFileToolHandler pagination & sizing additions:
 *  - offset/limit slicing
 *  - start_line/end_line backwards-compat
 *  - mutual exclusion
 *  - actionable error when file > readFileMaxSize
 *  - readFileMaxSize read from StateManager
 */

let tmpDir: string

interface CreateConfigOpts {
	readFileMaxSize?: number
}

function createConfig(opts: CreateConfigOpts = {}) {
	const taskState = new TaskState()

	const callbacks = {
		say: sinon.stub().resolves(undefined),
		ask: sinon.stub().resolves({ response: "yesButtonClicked" }),
		saveCheckpoint: sinon.stub().resolves(),
		sayAndCreateMissingParamError: sinon.stub().resolves("missing"),
		removeLastPartialMessageIfExistsWithType: sinon.stub().resolves(),
		shouldAutoApproveToolWithPath: sinon.stub().resolves(true),
		postStateToWebview: sinon.stub().resolves(),
		cancelTask: sinon.stub().resolves(),
		updateTaskHistory: sinon.stub().resolves([]),
		switchToActMode: sinon.stub().resolves(false),
		setActiveHookExecution: sinon.stub().resolves(),
		clearActiveHookExecution: sinon.stub().resolves(),
		getActiveHookExecution: sinon.stub().resolves(undefined),
		runUserPromptSubmitHook: sinon.stub().resolves({}),
		executeCommandTool: sinon.stub().resolves([false, "ok"]),
		cancelRunningCommandTool: sinon.stub().resolves(false),
		doesLatestTaskCompletionHaveNewChanges: sinon.stub().resolves(false),
		updateFCListFromToolResponse: sinon.stub().resolves(),
		shouldAutoApproveTool: sinon.stub().returns([true, true]),
		reinitExistingTaskFromId: sinon.stub().resolves(),
		applyLatestBrowserSettings: sinon.stub().resolves(undefined),
	}

	const stateGetSpy = sinon.spy((key: string) => {
		if (key === "mode") return "act"
		if (key === "hooksEnabled") return false
		if (key === "readFileMaxSize") return opts.readFileMaxSize
		return undefined
	})

	const config = {
		taskId: "task-1",
		ulid: "ulid-1",
		cwd: tmpDir,
		mode: "act",
		strictPlanModeEnabled: false,
		yoloModeToggled: true,
		doubleCheckCompletionEnabled: false,
		vscodeTerminalExecutionMode: "backgroundExec",
		enableParallelToolCalling: true,
		isSubagentExecution: true,
		taskState,
		messageState: {
			getApiConversationHistory: sinon.stub().returns([]),
		},
		api: {
			getModel: () => ({ id: "test-model", info: { supportsImages: false } }),
		},
		autoApprovalSettings: {
			enableNotifications: false,
			actions: { executeCommands: false },
		},
		autoApprover: {
			shouldAutoApproveTool: sinon.stub().returns([true, true]),
		},
		browserSettings: {},
		focusChainSettings: {},
		services: {
			stateManager: {
				getGlobalStateKey: () => undefined,
				getGlobalSettingsKey: stateGetSpy,
				getApiConfiguration: () => ({
					planModeApiProvider: "openai",
					actModeApiProvider: "openai",
				}),
			},
			fileContextTracker: {
				trackFileContext: sinon.stub().resolves(),
			},
			browserSession: {},
			urlContentFetcher: {},
			diffViewProvider: {},
			diracIgnoreController: { validateAccess: () => true },
			commandPermissionController: {},
			contextManager: {},
		},
		callbacks,
		coordinator: { getHandler: sinon.stub() },
	} as unknown as TaskConfig

	const validator = new ToolValidator({ validateAccess: () => true } as any)

	return { config, callbacks, taskState, validator, stateGetSpy }
}

function makeBlock(params: Record<string, any>) {
	return {
		type: "tool_use" as const,
		name: IsaacDefaultTool.FILE_READ,
		params,
		partial: false,
	}
}

describe("ReadFileToolHandler – pagination & sizing", () => {
	let sandbox: sinon.SinonSandbox

	beforeEach(async () => {
		sandbox = sinon.createSandbox()
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "dirac-readpag-test-"))
		sandbox.stub(pathUtils, "isLocatedInWorkspace").resolves(true)
	})

	afterEach(async () => {
		sandbox.restore()
		await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
	})

	async function writeLines(filename: string, count: number) {
		const lines = Array.from({ length: count }, (_, i) => `line${i + 1}`)
		await fs.writeFile(path.join(tmpDir, filename), lines.join("\n"))
		return lines
	}

	it("offset/limit returns the expected slice (0-based)", async () => {
		const { config, validator } = createConfig()
		const handler = new ReadFileToolHandler(validator)
		await writeLines("a.txt", 50)

		const result = (await handler.execute(config, makeBlock({ paths: ["a.txt"], offset: 5, limit: 3 }))) as string

		// content should include line6, line7, line8 and not line5 or line9
		assert.match(result, /line6/)
		assert.match(result, /line7/)
		assert.match(result, /line8/)
		assert.doesNotMatch(result, /line5\b/)
		assert.doesNotMatch(result, /line9\b/)
	})

	it("start_line/end_line still works (backwards compat, 1-based inclusive)", async () => {
		const { config, validator } = createConfig()
		const handler = new ReadFileToolHandler(validator)
		await writeLines("b.txt", 50)

		const result = (await handler.execute(config, makeBlock({ paths: ["b.txt"], start_line: 3, end_line: 5 }))) as string

		assert.match(result, /line3/)
		assert.match(result, /line4/)
		assert.match(result, /line5/)
		assert.doesNotMatch(result, /line2\b/)
		assert.doesNotMatch(result, /line6\b/)
	})

	it("rejects when both line-range and offset/limit are provided", async () => {
		const { config, taskState, validator } = createConfig()
		const handler = new ReadFileToolHandler(validator)
		await writeLines("c.txt", 10)

		const result = (await handler.execute(
			config,
			makeBlock({ paths: ["c.txt"], start_line: 1, end_line: 5, offset: 0, limit: 3 }),
		)) as string

		assert.match(result, /Cannot combine start_line\/end_line with offset\/limit/)
		assert.equal(taskState.consecutiveMistakeCount, 1)
	})

	it("rejects negative offset and non-positive limit", async () => {
		const { config, validator } = createConfig()
		const handler = new ReadFileToolHandler(validator)
		await writeLines("d.txt", 10)

		const r1 = (await handler.execute(config, makeBlock({ paths: ["d.txt"], offset: -1, limit: 1 }))) as string
		assert.match(r1, /Invalid offset/)

		const r2 = (await handler.execute(config, makeBlock({ paths: ["d.txt"], offset: 0, limit: 0 }))) as string
		assert.match(r2, /Invalid limit/)
	})

	it("returns actionable error when file exceeds readFileMaxSize and no pagination", async () => {
		const { config, validator } = createConfig({ readFileMaxSize: 100 })
		const handler = new ReadFileToolHandler(validator)
		const big = "x".repeat(500)
		await fs.writeFile(path.join(tmpDir, "big.txt"), big)

		const result = (await handler.execute(config, makeBlock({ paths: ["big.txt"] }))) as string

		assert.match(result, /exceeds the read limit/)
		assert.match(result, /start_line \/ end_line/)
		assert.match(result, /offset \/ limit/)
		assert.match(result, /readFileMaxSize/)
		assert.match(result, /approximately \d+ lines/)
	})

	it("readFileMaxSize from state is honored (raises limit)", async () => {
		const big = "y".repeat(80_000)
		await fs.writeFile(path.join(tmpDir, "huge.txt"), big)

		// default 50_000: should fail
		{
			const { config, validator } = createConfig()
			const handler = new ReadFileToolHandler(validator)
			const r = (await handler.execute(config, makeBlock({ paths: ["huge.txt"] }))) as string
			assert.match(r, /exceeds the read limit/)
		}

		// raised to 200_000: should succeed
		{
			const { config, validator, stateGetSpy } = createConfig({ readFileMaxSize: 200_000 })
			const handler = new ReadFileToolHandler(validator)
			const r = (await handler.execute(config, makeBlock({ paths: ["huge.txt"] }))) as string
			assert.doesNotMatch(r, /exceeds the read limit/)
			assert.ok(stateGetSpy.calledWith("readFileMaxSize"))
		}
	})

	it("offset past the end of the file yields an empty slice", async () => {
		const { config, validator } = createConfig()
		const handler = new ReadFileToolHandler(validator)
		await writeLines("e.txt", 5)

		const result = (await handler.execute(config, makeBlock({ paths: ["e.txt"], offset: 100, limit: 10 }))) as string

		assert.doesNotMatch(result, /line\d/)
	})
})
