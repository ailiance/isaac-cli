import { strict as assert } from "node:assert"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { IsaacDefaultTool } from "@shared/tools"
import { afterEach, beforeEach, describe, it } from "mocha"
import sinon from "sinon"
import { HostProvider } from "@/hosts/host-provider"
import { TaskState } from "../../../TaskState"
import { ToolValidator } from "../../ToolValidator"
import type { TaskConfig } from "../../types/TaskConfig"
import { WriteToFileToolHandler } from "../WriteToFileToolHandler"

let tmpDir: string

function createConfig() {
	const taskState = new TaskState()
	const diffViewProvider = {
		open: sinon.stub().resolves(),
		update: sinon.stub().resolves(),
		reset: sinon.stub().resolves(),
		revertChanges: sinon.stub().resolves(),
		saveChanges: sinon.stub().resolves({ finalContent: "" }),
		isEditing: false,
		editType: undefined as "create" | "modify" | undefined,
	}

	const callbacks = {
		say: sinon.stub().resolves(undefined),
		ask: sinon.stub().resolves({ response: "yesButtonClicked" }),
		sayAndCreateMissingParamError: sinon.stub().resolves("missing"),
		removeLastPartialMessageIfExistsWithType: sinon.stub().resolves(),
		shouldAutoApproveToolWithPath: sinon.stub().resolves(true),
	}

	const config = {
		taskId: "task-1",
		ulid: "ulid-1",
		cwd: tmpDir,
		taskState,
		api: {
			getModel: () => ({ id: "test-model", info: { supportsImages: false } }),
		},
		services: {
			stateManager: {
				getApiConfiguration: () => ({
					planModeApiProvider: "openai",
					actModeApiProvider: "openai",
				}),
				getGlobalSettingsKey: (key: string) => {
					if (key === "mode") return "act"
					return undefined
				},
			},
			diffViewProvider,
			fileContextTracker: {
				markFileAsEditedByIsaac: sinon.stub(),
				trackFileContext: sinon.stub().resolves(),
			},
			diracIgnoreController: { validateAccess: () => true },
		},
		callbacks,
	} as unknown as TaskConfig

	const validator = new ToolValidator({ validateAccess: () => true } as any)

	return { config, callbacks, taskState, validator, diffViewProvider }
}

describe("WriteToFileToolHandler – Error Handling", () => {
	let sandbox: sinon.SinonSandbox

	beforeEach(async () => {
		sandbox = sinon.createSandbox()
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "dirac-write-err-test-"))
	})

	afterEach(async () => {
		sandbox.restore()
		HostProvider.reset()
		await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
	})

	it("handles ENOTDIR (parent is a file)", async () => {
		const { config, validator } = createConfig()
		const handler = new WriteToFileToolHandler(validator)

		const error = new Error("Not a directory") as any
		error.code = "ENOTDIR"
		sandbox.stub(fs, "stat").rejects(error)

		const block = {
			type: "tool_use" as const,
			name: IsaacDefaultTool.FILE_NEW,
			params: {
				path: "parent-is-file/test.txt",
				content: "some content",
			},
			partial: false,
			call_id: "call-1",
		}

		const result = await handler.execute(config, block)

		assert.ok(typeof result === "string")
		assert.ok(result.includes("Cannot write to 'parent-is-file/test.txt' because one of the parent components is a file, not a directory."))
		assert.ok((config.callbacks.say as sinon.SinonStub).calledWith("error", sinon.match(/parent component is not a directory/)))
	})

	it("handles EACCES on stat (permission denied for access)", async () => {
		const { config, validator } = createConfig()
		const handler = new WriteToFileToolHandler(validator)

		const error = new Error("Permission denied") as any
		error.code = "EACCES"
		sandbox.stub(fs, "stat").rejects(error)

		const block = {
			type: "tool_use" as const,
			name: IsaacDefaultTool.FILE_NEW,
			params: {
				path: "no-access.txt",
				content: "some content",
			},
			partial: false,
			call_id: "call-2",
		}

		const result = await handler.execute(config, block)

		assert.ok(typeof result === "string")
		assert.ok(result.includes("Cannot access 'no-access.txt': Permission denied."))
		assert.ok((config.callbacks.say as sinon.SinonStub).calledWith("error", sinon.match(/permission was denied/)))
	})

	it("handles EROFS on stat (read-only file system)", async () => {
		const { config, validator } = createConfig()
		const handler = new WriteToFileToolHandler(validator)

		const error = new Error("Read-only file system") as any
		error.code = "EROFS"
		sandbox.stub(fs, "stat").rejects(error)

		const block = {
			type: "tool_use" as const,
			name: IsaacDefaultTool.FILE_NEW,
			params: {
				path: "readonly.txt",
				content: "some content",
			},
			partial: false,
			call_id: "call-3",
		}

		const result = await handler.execute(config, block)

		assert.ok(typeof result === "string")
		assert.ok(result.includes("Cannot write to 'readonly.txt': Read-only file system."))
		assert.ok((config.callbacks.say as sinon.SinonStub).calledWith("error", sinon.match(/file system is read-only/)))
	})

	it("handles EACCES on access (permission denied for write)", async () => {
		const { config, validator } = createConfig()
		const handler = new WriteToFileToolHandler(validator)

		sandbox.stub(fs, "stat").resolves({ isDirectory: () => false } as any)
		const error = new Error("Permission denied") as any
		error.code = "EACCES"
		sandbox.stub(fs, "access").rejects(error)

		const block = {
			type: "tool_use" as const,
			name: IsaacDefaultTool.FILE_NEW,
			params: {
				path: "no-write.txt",
				content: "some content",
			},
			partial: false,
			call_id: "call-4",
		}

		const result = await handler.execute(config, block)
		assert.ok(typeof result === "string")
		assert.ok(result.includes("Cannot write to 'no-write.txt': Permission denied."))
		assert.ok((config.callbacks.say as sinon.SinonStub).calledWith("error", sinon.match(/permission was denied/)))
	})

	it("handles EROFS on access (read-only file system for write)", async () => {
		const { config, validator } = createConfig()
		const handler = new WriteToFileToolHandler(validator)

		sandbox.stub(fs, "stat").resolves({ isDirectory: () => false } as any)
		const error = new Error("Read-only file system") as any
		error.code = "EROFS"
		sandbox.stub(fs, "access").rejects(error)

		const block = {
			type: "tool_use" as const,
			name: IsaacDefaultTool.FILE_NEW,
			params: {
				path: "readonly-write.txt",
				content: "some content",
			},
			partial: false,
			call_id: "call-5",
		}

		const result = await handler.execute(config, block)

		assert.ok(typeof result === "string")
		assert.ok(result.includes("Cannot write to 'readonly-write.txt': Read-only file system."))
		assert.ok((config.callbacks.say as sinon.SinonStub).calledWith("error", sinon.match(/file system is read-only/)))
	})

	it("handles target being a directory", async () => {
		const { config, validator } = createConfig()
		const handler = new WriteToFileToolHandler(validator)

		sandbox.stub(fs, "stat").resolves({ isDirectory: () => true } as any)

		const block = {
			type: "tool_use" as const,
			name: IsaacDefaultTool.FILE_NEW,
			params: {
				path: "some-dir",
				content: "some content",
			},
			partial: false,
			call_id: "call-6",
		}

		const result = await handler.execute(config, block)

		assert.ok(typeof result === "string")
		assert.ok(result.includes("Cannot write to 'some-dir' because it is a directory."))
		assert.ok((config.callbacks.say as sinon.SinonStub).calledWith("error", sinon.match(/it is a directory/)))
	})
})
