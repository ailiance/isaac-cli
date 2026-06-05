import { IsaacSayTool } from "@shared/ExtensionMessage"
import { strict as assert } from "assert"
import { describe, it } from "mocha"
import { notifyAsyncTool } from "../AsyncToolNotifier"
import { PendingToolRegistry } from "../PendingToolRegistry"
import type { TaskMessenger } from "../TaskMessenger"

interface CapturedSay {
	type: string
	text: string | undefined
	partial: boolean | undefined
}

/**
 * Minimal TaskMessenger stub: captures every say(...) call in-order so tests
 * can assert the running → terminal sequence without spinning up the full
 * MessageStateHandler / webview plumbing.
 */
function makeMessengerStub(): { messenger: TaskMessenger; sayCalls: CapturedSay[] } {
	const sayCalls: CapturedSay[] = []
	const messenger = {
		async say(type: string, text?: string, _images?: unknown, _files?: unknown, partial?: boolean) {
			sayCalls.push({ type, text, partial })
			return Date.now()
		},
	} as unknown as TaskMessenger
	return { messenger, sayCalls }
}

const initialPayload: IsaacSayTool = {
	tool: "execute_command",
	command: "sleep 1",
}

describe("AsyncToolNotifier", () => {
	it("emits a running say with partial:true on registration", async () => {
		const reg = new PendingToolRegistry()
		const { messenger, sayCalls } = makeMessengerStub()
		const entry = reg.register({ toolName: "execute_command" })

		await notifyAsyncTool({ messenger, registry: reg, entry, initialPayload })

		assert.equal(sayCalls.length, 1)
		assert.equal(sayCalls[0].type, "tool")
		assert.equal(sayCalls[0].partial, true)
		const parsed = JSON.parse(sayCalls[0].text!) as IsaacSayTool
		assert.equal(parsed.tool, "execute_command")
		assert.equal(parsed.asyncStatus, "running")
		assert.equal(parsed.asyncTaskId, entry.taskId)
		assert.ok(parsed.asyncStartedAt && parsed.asyncStartedAt > 0)
	})

	it("emits a completed say with partial:false on registry.complete()", async () => {
		const reg = new PendingToolRegistry()
		const { messenger, sayCalls } = makeMessengerStub()
		const entry = reg.register({ toolName: "execute_command" })

		await notifyAsyncTool({ messenger, registry: reg, entry, initialPayload })
		reg.complete(entry.taskId, "ok")

		// Allow the void-promise inside the listener to resolve.
		await new Promise((r) => setImmediate(r))

		assert.equal(sayCalls.length, 2)
		assert.equal(sayCalls[1].partial, false)
		const parsed = JSON.parse(sayCalls[1].text!) as IsaacSayTool
		assert.equal(parsed.asyncStatus, "completed")
		assert.equal(parsed.asyncResult, "ok")
		assert.ok(parsed.asyncFinishedAt && parsed.asyncFinishedAt >= parsed.asyncStartedAt!)
		assert.ok(parsed.asyncDurationMs !== undefined && parsed.asyncDurationMs >= 0)
	})

	it("emits a cancelled say on registry.cancel()", async () => {
		const reg = new PendingToolRegistry()
		const { messenger, sayCalls } = makeMessengerStub()
		const entry = reg.register({ toolName: "execute_command" })

		await notifyAsyncTool({ messenger, registry: reg, entry, initialPayload })
		reg.cancel(entry.taskId)

		await new Promise((r) => setImmediate(r))

		assert.equal(sayCalls.length, 2)
		const parsed = JSON.parse(sayCalls[1].text!) as IsaacSayTool
		assert.equal(parsed.asyncStatus, "cancelled")
	})

	it("emits a failed say with asyncError on registry.fail()", async () => {
		const reg = new PendingToolRegistry()
		const { messenger, sayCalls } = makeMessengerStub()
		const entry = reg.register({ toolName: "execute_command" })

		await notifyAsyncTool({ messenger, registry: reg, entry, initialPayload })
		reg.fail(entry.taskId, "boom")

		await new Promise((r) => setImmediate(r))

		const parsed = JSON.parse(sayCalls[1].text!) as IsaacSayTool
		assert.equal(parsed.asyncStatus, "failed")
		assert.equal(parsed.asyncError, "boom")
	})

	it("removes its registry listener after the terminal transition", async () => {
		const reg = new PendingToolRegistry()
		const { messenger, sayCalls } = makeMessengerStub()
		const entry = reg.register({ toolName: "execute_command" })

		await notifyAsyncTool({ messenger, registry: reg, entry, initialPayload })
		assert.equal(reg.events.listenerCount("updated"), 1)

		reg.complete(entry.taskId, "done")
		await new Promise((r) => setImmediate(r))
		assert.equal(reg.events.listenerCount("updated"), 0)

		// Subsequent emits (e.g. another tool's transitions) must not produce more says.
		const before = sayCalls.length
		const other = reg.register({ toolName: "read_file" })
		reg.complete(other.taskId, "x")
		await new Promise((r) => setImmediate(r))
		assert.equal(sayCalls.length, before)
	})

	it("dispose() detaches the listener early", async () => {
		const reg = new PendingToolRegistry()
		const { messenger, sayCalls } = makeMessengerStub()
		const entry = reg.register({ toolName: "execute_command" })

		const handle = await notifyAsyncTool({ messenger, registry: reg, entry, initialPayload })
		handle.dispose()
		assert.equal(reg.events.listenerCount("updated"), 0)

		reg.complete(entry.taskId, "done")
		await new Promise((r) => setImmediate(r))

		// Only the initial running say should have been emitted.
		assert.equal(sayCalls.length, 1)
	})
})
