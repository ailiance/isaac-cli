// src/core/storage/snapshot/SessionSnapshot.ts
import { GlobalFileNames } from "../disk"

/** Bump on any change to SnapshotBundle shape. */
export const SNAPSHOT_SCHEMA_VERSION = 1

/** Canonical state files captured in a snapshot, in stable order. */
export const SNAPSHOT_FILES: readonly string[] = [
	GlobalFileNames.apiConversationHistory,
	GlobalFileNames.contextHistory,
	GlobalFileNames.uiMessages,
	GlobalFileNames.taskMetadata,
]

export interface SnapshotMeta {
	id: string
	label: string
	sourceTaskId: string
	createdAt: string
	env: string
	schemaVersion: number
}

/** Canonical filename → raw JSON file contents. */
export type SnapshotFiles = Record<string, string>

export interface SnapshotBundle {
	meta: SnapshotMeta
	files: SnapshotFiles
}

/** Typed error so callers can distinguish snapshot failures from generic I/O. */
export class SnapshotError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "SnapshotError"
	}
}

export function serialize(meta: SnapshotMeta, files: SnapshotFiles): SnapshotBundle {
	return { meta: { ...meta }, files: { ...files } }
}

export function deserialize(raw: unknown): SnapshotBundle {
	if (typeof raw !== "object" || raw === null) {
		throw new SnapshotError("snapshot is not an object")
	}
	const obj = raw as Record<string, unknown>
	const meta = obj.meta as SnapshotMeta | undefined
	const files = obj.files as SnapshotFiles | undefined
	if (!meta || typeof meta !== "object") {
		throw new SnapshotError("snapshot is missing the meta block")
	}
	if (!files || typeof files !== "object") {
		throw new SnapshotError("snapshot is missing the files block")
	}
	if (meta.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
		throw new SnapshotError(`unsupported snapshot schemaVersion ${meta.schemaVersion} (expected ${SNAPSHOT_SCHEMA_VERSION})`)
	}
	return { meta, files }
}
