// src/core/storage/snapshot/capture.ts
import { readTaskStateFile } from "../disk"
import { SNAPSHOT_FILES, SNAPSHOT_SCHEMA_VERSION, type SnapshotBundle, type SnapshotFiles, serialize } from "./SessionSnapshot"

/**
 * Read a live task's state files into a portable bundle. `idgen` returns a
 * fresh snapshot id (injected for testability). `envLabel` records provenance.
 * `now` is injectable so tests can pin createdAt.
 */
export async function captureSnapshot(
	taskId: string,
	label: string,
	envLabel: string,
	idgen: () => string,
	now: () => string = () => new Date().toISOString(),
): Promise<SnapshotBundle> {
	const files: SnapshotFiles = {}
	for (const name of SNAPSHOT_FILES) {
		const content = await readTaskStateFile(taskId, name)
		if (content !== undefined) {
			files[name] = content
		}
	}
	return serialize(
		{
			id: idgen(),
			label,
			sourceTaskId: taskId,
			createdAt: now(),
			env: envLabel,
			schemaVersion: SNAPSHOT_SCHEMA_VERSION,
		},
		files,
	)
}
