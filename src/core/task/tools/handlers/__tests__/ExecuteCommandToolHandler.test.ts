import { strict as assert } from "node:assert"
import { LocalEnvironment } from "@services/environment"
import { describe, it } from "mocha"
import sinon from "sinon"
import { IsaacDefaultTool } from "@/shared/tools"
import { TaskState } from "../../../TaskState"
import { ToolValidator } from "../../ToolValidator"
import type { TaskConfig } from "../../types/TaskConfig"
import { ExecuteCommandToolHandler } from "../ExecuteCommandToolHandler"

function createConfig() {
	const taskState = new TaskState()
	const runCommandStub = sinon.stub().resolves([false, "ok"])
	const callbacks = {
		say: sinon.stub().resolves(undefined),
		ask: sinon.stub().resolves({ response: "yesButtonClicked" }),
		sayAndCreateMissingParamError: sinon.stub().resolves("missing"),
		removeLastPartialMessageIfExistsWithType: sinon.stub().resolves(),
		executeCommandTool: runCommandStub,
		getIsaacMessages: sinon.stub().returns([]),
		updateIsaacMessage: sinon.stub().resolves(),
	}

	const config = {
		taskId: "task-1",
		ulid: "ulid-1",
		cwd: "/tmp",
		environment: new LocalEnvironment("/tmp", runCommandStub),
		mode: "act",
		yoloModeToggled: true,
		taskState,
		api: {
			getModel: () => ({ id: "test-model" }),
		},
		services: {
			stateManager: {
				getGlobalSettingsKey: (key: string) => {
					if (key === "mode") return "act"
					if (key === "hooksEnabled") return false
					return undefined
				},
				getApiConfiguration: () => ({
					planModeApiProvider: "openai",
					actModeApiProvider: "openai",
				}),
			},
			commandPermissionController: {
				validateCommand: () => ({ allowed: true }),
			},
			isaacIgnoreController: {
				validateCommand: () => undefined,
			},
		},
		callbacks,
		autoApprovalSettings: {
			enableNotifications: false,
		},
	} as unknown as TaskConfig

	const validator = new ToolValidator({ validateAccess: () => true } as any)

	return { config, callbacks, taskState, validator }
}

describe("ExecuteCommandToolHandler", () => {
	it("blocks path arguments exceeding 255 bytes", async () => {
		const { config, validator } = createConfig()
		const handler = new ExecuteCommandToolHandler(validator)
		const longPath = "/tmp/" + "a".repeat(300)
		const result = await handler.execute(config, {
			type: "tool_use",
			call_id: "t1",
			name: IsaacDefaultTool.BASH,
			params: { commands: [`cat ${longPath}`] },
			partial: false,
		})

		const parsed = JSON.parse(result as string)
		assert.equal(parsed.ok, false)
		assert.equal(parsed.error, "PATH_TOO_LONG")
		assert.ok(parsed.message.includes("305 bytes"))
	})

	it("allows normal-length path arguments", async () => {
		const { config, validator } = createConfig()
		const handler = new ExecuteCommandToolHandler(validator)
		const normalPath = "/tmp/test.txt"
		const result = await handler.execute(config, {
			type: "tool_use",
			call_id: "t1",
			name: IsaacDefaultTool.BASH,
			params: { commands: [`cat ${normalPath}`] },
			partial: false,
		})

		// If it passed validation, it would proceed to ask for approval or execute.
		// In our mock config, it should return the result of executeCommandTool or similar.
		// Since we stubbed executeCommandTool to return "ok", and it's wrapped in results array.
		assert.ok(typeof result === "string")
		assert.ok(!result.includes("PATH_TOO_LONG"))
	})

	it("blocks long path components even if they don't start with /", async () => {
		const { config, validator } = createConfig()
		const handler = new ExecuteCommandToolHandler(validator)
		const longPath = "some/dir/" + "a".repeat(300)
		const result = await handler.execute(config, {
			type: "tool_use",
			call_id: "t1",
			name: IsaacDefaultTool.BASH,
			params: { commands: [`ls ${longPath}`] },
			partial: false,
		})

		const parsed = JSON.parse(result as string)
		assert.equal(parsed.ok, false)
		assert.equal(parsed.error, "PATH_TOO_LONG")
	})

	it("allows long commands with short path components", async () => {
		const { config, validator } = createConfig()
		const handler = new ExecuteCommandToolHandler(validator)
		const longCommand = "echo " + "word ".repeat(100) + "/tmp/short"
		const result = await handler.execute(config, {
			type: "tool_use",
			call_id: "t1",
			name: IsaacDefaultTool.BASH,
			params: { commands: [longCommand] },
			partial: false,
		})

		assert.ok(typeof result === "string")
		assert.ok(!result.includes("PATH_TOO_LONG"))
	})
})
