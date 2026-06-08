import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import { InMemoryEnvironment } from "../../../../services/environment/InMemoryEnvironment"
import { GlobalFileNames } from "../../disk"
import { SNAPSHOT_SCHEMA_VERSION, SnapshotError, type SnapshotMeta, serialize } from "../SessionSnapshot"
import { SnapshotStore } from "../SnapshotStore"

function bundle(id: string, label: string) {
	const meta: SnapshotMeta = {
		id,
		label,
		sourceTaskId: "task-1",
		createdAt: "2026-06-08T10:00:00.000Z",
		env: "local",
		schemaVersion: SNAPSHOT_SCHEMA_VERSION,
	}
	return serialize(meta, {
		[GlobalFileNames.apiConversationHistory]: "[]",
		[GlobalFileNames.contextHistory]: "{}",
		[GlobalFileNames.uiMessages]: "[]",
		[GlobalFileNames.taskMetadata]: "{}",
	})
}

describe("SnapshotStore", () => {
	it("saves then loads an identical bundle", async () => {
		const env = new InMemoryEnvironment("/")
		const store = new SnapshotStore(env, "/snapshots")
		await store.save(bundle("snap_a", "first"))
		const loaded = await store.load("snap_a")
		assert.equal(loaded.meta.label, "first")
		assert.equal(loaded.files[GlobalFileNames.apiConversationHistory], "[]")
	})

	it("lists saved snapshots' metas", async () => {
		const env = new InMemoryEnvironment("/")
		const store = new SnapshotStore(env, "/snapshots")
		await store.save(bundle("snap_a", "first"))
		await store.save(bundle("snap_b", "second"))
		const metas = await store.list()
		const labels = metas.map((m: SnapshotMeta) => m.label).sort()
		assert.deepEqual(labels, ["first", "second"])
	})

	it("throws SnapshotError loading a missing id", async () => {
		const env = new InMemoryEnvironment("/")
		const store = new SnapshotStore(env, "/snapshots")
		await assert.rejects(() => store.load("nope"), SnapshotError)
	})
})
