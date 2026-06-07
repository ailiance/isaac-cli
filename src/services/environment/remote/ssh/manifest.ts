import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"

export type Manifest = Record<string, string>

function isExcluded(rel: string, excludes: string[]): boolean {
	const top = rel.split("/")[0]
	return excludes.some((e) => e === top || e === rel || rel.startsWith(`${e}/`))
}

export async function buildManifest(dir: string, excludes: string[]): Promise<Manifest> {
	const out: Manifest = {}
	async function walk(rel: string): Promise<void> {
		let entries: import("node:fs").Dirent[]
		try {
			entries = await fs.readdir(path.join(dir, rel), { withFileTypes: true })
		} catch {
			return
		}
		for (const e of entries) {
			const childRel = rel ? `${rel}/${e.name}` : e.name
			if (isExcluded(childRel, excludes)) {
				continue
			}
			if (e.isDirectory()) {
				await walk(childRel)
			} else if (e.isFile()) {
				try {
					const buf = await fs.readFile(path.join(dir, childRel))
					out[childRel] = createHash("sha256").update(buf).digest("hex")
				} catch {
					// unreadable -> skip
				}
			}
		}
	}
	await walk("")
	return out
}

export async function locallyChanged(dir: string, seed: Manifest, excludes: string[]): Promise<string[]> {
	const current = await buildManifest(dir, excludes)
	const changed: string[] = []
	for (const [rel, hash] of Object.entries(current)) {
		if (seed[rel] !== hash) {
			changed.push(rel)
		}
	}
	return changed
}
