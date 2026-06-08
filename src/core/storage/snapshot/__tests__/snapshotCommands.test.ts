import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import { InMemoryEnvironment } from "../../../../services/environment/InMemoryEnvironment"
import { GlobalFileNames } from "../../disk"
import { SNAPSHOT_SCHEMA_VERSION, type SnapshotBundle, serialize } from "../SessionSnapshot"
import { SnapshotStore } from "../SnapshotStore"
import { runRestore, runSessions, runSnapshot, type SnapshotCommandDeps } from "../snapshotCommands"

function makeDeps(store: SnapshotStore, entered?: Array<{ taskId: string; bundle: SnapshotBundle }>): SnapshotCommandDeps {
	let n = 0
	return {
		store,
		taskId: "task-1",
		envLabel: "local",
		newId: () => `snap_id${n++}`,
		capture: async (taskId, label, envLabel, idgen) =>
			serialize(
				{
					id: idgen(),
					label,
					sourceTaskId: taskId,
					createdAt: "2026-06-08T10:00:00.000Z",
					env: envLabel,
					schemaVersion: SNAPSHOT_SCHEMA_VERSION,
				},
				{ [GlobalFileNames.apiConversationHistory]: "[]" },
			),
		rehydrate: async (_b: SnapshotBundle, target: string) => target,
		newTaskId: () => "task-restored",
		enterRestored: async (taskId: string, bundle: SnapshotBundle) => {
			entered?.push({ taskId, bundle })
		},
	}
}

describe("snapshotCommands", () => {
	it("runSnapshot saves a bundle and reports its id", async () => {
		const store = new SnapshotStore(new InMemoryEnvironment("/"), "/snapshots")
		const out = await runSnapshot(makeDeps(store), "before refactor")
		assert.match(out, /snap_id0/)
		const metas = await store.list()
		assert.equal(metas.length, 1)
		assert.equal(metas[0].label, "before refactor")
	})
	it("runSessions lists saved snapshots", async () => {
		const store = new SnapshotStore(new InMemoryEnvironment("/"), "/snapshots")
		const deps = makeDeps(store)
		await runSnapshot(deps, "first")
		assert.match(await runSessions(deps), /first/)
	})
	it("runRestore on a missing id reports a friendly error, not a throw", async () => {
		const store = new SnapshotStore(new InMemoryEnvironment("/"), "/snapshots")
		assert.match(await runRestore(makeDeps(store), "missing"), /not found/i)
	})
	it("runRestore rehydrates and registers the restored task via enterRestored", async () => {
		const store = new SnapshotStore(new InMemoryEnvironment("/"), "/snapshots")
		const entered: Array<{ taskId: string; bundle: SnapshotBundle }> = []
		const deps = makeDeps(store, entered)
		await runSnapshot(deps, "before refactor")
		const out = await runRestore(deps, "snap_id0")
		assert.match(out, /task-restored/)
		assert.match(out, /task history/i)
		assert.equal(entered.length, 1)
		assert.equal(entered[0].taskId, "task-restored")
		assert.equal(entered[0].bundle.meta.id, "snap_id0")
	})
})
