import type { captureSnapshot } from "./capture"
import type { rehydrate } from "./restore"
import { type SnapshotBundle, SnapshotError } from "./SessionSnapshot"
import type { SnapshotStore } from "./SnapshotStore"

export interface SnapshotCommandDeps {
	store: SnapshotStore
	taskId: string
	envLabel: string
	newId: () => string
	capture: typeof captureSnapshot
	rehydrate: typeof rehydrate
	newTaskId: () => string
	/**
	 * Register the rehydrated task so it isn't an orphan: persists a HistoryItem
	 * for `taskId` so the restored session appears in task history and can be
	 * opened later. The controller-touching work lives in the callback so this
	 * module stays pure.
	 */
	enterRestored: (taskId: string, bundle: SnapshotBundle) => Promise<void>
}

export async function runSnapshot(deps: SnapshotCommandDeps, label: string): Promise<string> {
	const bundle = await deps.capture(deps.taskId, label || "(unlabeled)", deps.envLabel, deps.newId)
	await deps.store.save(bundle)
	return `Snapshot ${bundle.meta.id} saved${label ? ` ("${label}")` : ""}.`
}

export async function runSessions(deps: SnapshotCommandDeps): Promise<string> {
	const metas = await deps.store.list()
	if (metas.length === 0) {
		return "No snapshots yet. Use /snapshot [label] to create one."
	}
	const rows = metas
		.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
		.map((m) => `  ${m.id}  ${m.label}  ${m.createdAt}  ${m.env}`)
		.join("\n")
	return `Snapshots:\n${rows}`
}

export async function runRestore(deps: SnapshotCommandDeps, id: string): Promise<string> {
	if (!id) {
		return "Usage: /restore <snapshot-id>"
	}
	let bundle: SnapshotBundle
	try {
		bundle = await deps.store.load(id)
	} catch (error) {
		if (error instanceof SnapshotError) {
			return `Cannot restore: ${error.message}`
		}
		throw error
	}
	const target = deps.newTaskId()
	await deps.rehydrate(bundle, target)
	// Deferral: we persist the restored task into history (via enterRestored) but
	// do NOT reinit/resume it here — runRestore executes inside the current task's
	// API-request preparation, where re-entering the controller (clearTask) would
	// clobber the live task loop. The user resumes it from task history instead.
	await deps.enterRestored(target, bundle)
	return `Restored snapshot ${id} to a new session ${target}. Open it from task history to continue.`
}
