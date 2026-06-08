import { strict as assert } from "node:assert"
import * as os from "node:os"
import * as path from "node:path"
import { before, describe, it } from "mocha"
import { setVscodeHostProviderMock } from "../../../../test/host-provider-test-utils"
import { GlobalFileNames, readTaskStateFile, writeTaskStateFile } from "../../disk"
import { captureSnapshot } from "../capture"
import { rehydrate } from "../restore"

describe("capture + rehydrate", () => {
	before(() => {
		setVscodeHostProviderMock({ globalStorageFsPath: path.join(os.tmpdir(), `isaac-snap-test-${process.pid}`) })
	})

	it("captures a task's state and rehydrates it into a new task id", async () => {
		const sourceTaskId = "cap-src-portable-test"
		await writeTaskStateFile(sourceTaskId, GlobalFileNames.apiConversationHistory, '[{"role":"user","content":"hello"}]')

		let counter = 0
		const bundle = await captureSnapshot(sourceTaskId, "lbl", "local", () => `snap_test${counter++}`)
		assert.equal(bundle.meta.sourceTaskId, sourceTaskId)
		assert.equal(bundle.meta.label, "lbl")
		assert.ok(bundle.files[GlobalFileNames.apiConversationHistory].includes("hello"))

		const newTaskId = "cap-dst-portable-test"
		const returned = await rehydrate(bundle, newTaskId)
		assert.equal(returned, newTaskId)
		const restored = await readTaskStateFile(newTaskId, GlobalFileNames.apiConversationHistory)
		assert.ok(restored?.includes("hello"))
	})
})
