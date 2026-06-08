import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import { InMemoryEnvironment } from "../../../../services/environment/InMemoryEnvironment"
import { GlobalFileNames } from "../../disk"
import { SNAPSHOT_SCHEMA_VERSION, type SnapshotMeta, serialize } from "../SessionSnapshot"
import { SnapshotStore } from "../SnapshotStore"

function bundle(id: string, createdAt: string) {
	const meta: SnapshotMeta = {
		id,
		label: id,
		sourceTaskId: "t",
		createdAt,
		env: "local",
		schemaVersion: SNAPSHOT_SCHEMA_VERSION,
	}
	return serialize(meta, { [GlobalFileNames.apiConversationHistory]: "[]" })
}

describe("SnapshotStore.prune", () => {
	it("keeps only the N most recent snapshots", async () => {
		const store = new SnapshotStore(new InMemoryEnvironment("/"), "/snapshots")
		await store.save(bundle("a", "2026-06-01T00:00:00.000Z"))
		await store.save(bundle("b", "2026-06-02T00:00:00.000Z"))
		await store.save(bundle("c", "2026-06-03T00:00:00.000Z"))
		await store.prune(2)
		const ids = (await store.list()).map((m) => m.id).sort()
		assert.deepEqual(ids, ["b", "c"], "oldest (a) is pruned")
	})
})
