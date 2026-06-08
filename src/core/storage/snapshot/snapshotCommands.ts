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
	/** Ask the agent loop to re-enter the restored session at the next safe point. */
	requestRestoreReentry: (taskId: string) => void
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
	// Persist the restored task into history, then ask the agent loop to switch
	// into it. The actual reinit runs at a safe turn boundary (not here, during
	// request-prep) so it cannot tear down the live loadContext.
	await deps.enterRestored(target, bundle)
	deps.requestRestoreReentry(target)
	return `Restored snapshot ${id} — switching to the restored session (${target})…`
}
