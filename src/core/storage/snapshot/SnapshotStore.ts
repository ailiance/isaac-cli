// src/core/storage/snapshot/SnapshotStore.ts
import type { Environment } from "@services/environment/types"
import { deserialize, type SnapshotBundle, SnapshotError, type SnapshotMeta, serialize } from "./SessionSnapshot"

const META_FILE = "meta.json"
const SNAPSHOT_KEEP_DEFAULT = 20

export class SnapshotStore {
	constructor(
		private readonly env: Environment,
		private readonly root: string,
	) {}

	private dir(id: string): string {
		return `${this.root}/${id}`
	}

	async save(bundle: SnapshotBundle): Promise<void> {
		const dir = this.dir(bundle.meta.id)
		await this.env.mkdir(dir, { recursive: true })
		await this.env.writeFile(`${dir}/${META_FILE}`, JSON.stringify(bundle.meta, null, 2))
		for (const [name, content] of Object.entries(bundle.files)) {
			await this.env.writeFile(`${dir}/${name}`, content)
		}
		await this.prune(SNAPSHOT_KEEP_DEFAULT)
	}

	async list(): Promise<SnapshotMeta[]> {
		if (!(await this.env.exists(this.root))) {
			return []
		}
		const entries = await this.env.list(this.root)
		const metas: SnapshotMeta[] = []
		for (const entry of entries) {
			const metaPath = `${this.dir(entry.name)}/${META_FILE}`
			if (await this.env.exists(metaPath)) {
				metas.push(JSON.parse(await this.env.readFile(metaPath)) as SnapshotMeta)
			}
		}
		return metas
	}

	async load(id: string): Promise<SnapshotBundle> {
		const dir = this.dir(id)
		const metaPath = `${dir}/${META_FILE}`
		if (!(await this.env.exists(metaPath))) {
			throw new SnapshotError(`snapshot ${id} not found`)
		}
		const meta = JSON.parse(await this.env.readFile(metaPath)) as SnapshotMeta
		const files: Record<string, string> = {}
		const entries = await this.env.list(dir)
		for (const entry of entries) {
			if (entry.name === META_FILE) {
				continue
			}
			files[entry.name] = await this.env.readFile(`${dir}/${entry.name}`)
		}
		// Re-validate via deserialize so schemaVersion is enforced on read.
		return deserialize(serialize(meta, files))
	}

	/** Delete all but the `keep` most recent snapshots (by createdAt). Best-effort. */
	async prune(keep: number): Promise<void> {
		const metas = await this.list()
		const stale = metas.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(keep)
		for (const m of stale) {
			try {
				await this.env.delete(this.dir(m.id), { recursive: true })
			} catch {
				// best-effort: a failed prune must never break the caller
			}
		}
	}
}
