// src/core/storage/snapshot/restore.ts
import { writeTaskStateFile } from "../disk"
import type { SnapshotBundle } from "./SessionSnapshot"

/**
 * Write a bundle's captured state files into `targetTaskId`'s directory,
 * atomically per file, and return that taskId for the resume path to consume.
 * The caller chooses a fresh taskId (rollback → new task).
 */
export async function rehydrate(bundle: SnapshotBundle, targetTaskId: string): Promise<string> {
	for (const [name, content] of Object.entries(bundle.files)) {
		await writeTaskStateFile(targetTaskId, name, content)
	}
	return targetTaskId
}
