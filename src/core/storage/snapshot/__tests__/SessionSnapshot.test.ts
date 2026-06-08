import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import { GlobalFileNames } from "../../disk"
import { deserialize, SNAPSHOT_SCHEMA_VERSION, SnapshotError, type SnapshotMeta, serialize } from "../SessionSnapshot"

const META: SnapshotMeta = {
	id: "snap_abc12345",
	label: "before refactor",
	sourceTaskId: "task-1",
	createdAt: "2026-06-08T10:00:00.000Z",
	env: "local",
	schemaVersion: SNAPSHOT_SCHEMA_VERSION,
}

const FILES = {
	[GlobalFileNames.apiConversationHistory]: "[]",
	[GlobalFileNames.contextHistory]: "{}",
	[GlobalFileNames.uiMessages]: "[]",
	[GlobalFileNames.taskMetadata]: '{"files_in_context":[]}',
}

describe("SessionSnapshot", () => {
	it("round-trips serialize → deserialize to an identical bundle", () => {
		const bundle = serialize(META, FILES)
		const raw = JSON.parse(JSON.stringify(bundle)) // simulate disk round-trip
		const back = deserialize(raw)
		assert.deepEqual(back.meta, META)
		assert.deepEqual(back.files, FILES)
	})

	it("rejects an unknown schemaVersion", () => {
		const bundle = serialize({ ...META, schemaVersion: 999 }, FILES)
		const raw = JSON.parse(JSON.stringify(bundle))
		assert.throws(() => deserialize(raw), SnapshotError)
	})

	it("rejects a bundle missing the meta block", () => {
		assert.throws(() => deserialize({ files: FILES }), SnapshotError)
	})
})
