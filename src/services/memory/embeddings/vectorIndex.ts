// src/services/memory/embeddings/vectorIndex.ts
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

/** Canonical sidecar vector-index path, alongside the memory store. */
export const EMBEDDINGS_INDEX_FILE = path.join(os.homedir(), ".ailiance-agent", "memory", ".embeddings-index.json")

export interface IndexEntry {
	vector: number[]
	scope: string
}
export type VectorIndex = Record<string, IndexEntry>

export function cosine(a: number[], b: number[]): number {
	let dot = 0
	let na = 0
	let nb = 0
	const n = Math.min(a.length, b.length)
	for (let i = 0; i < n; i++) {
		dot += a[i] * b[i]
		na += a[i] * a[i]
		nb += b[i] * b[i]
	}
	if (na === 0 || nb === 0) {
		return 0
	}
	return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

export async function loadIndex(file: string): Promise<VectorIndex> {
	try {
		const parsed = JSON.parse(await fs.readFile(file, "utf8"))
		return parsed && typeof parsed === "object" ? parsed : {}
	} catch {
		return {}
	}
}

export async function saveIndex(file: string, index: VectorIndex): Promise<void> {
	await fs.mkdir(path.dirname(file), { recursive: true })
	const tmp = `${file}.tmp`
	await fs.writeFile(tmp, JSON.stringify(index), "utf8")
	await fs.rename(tmp, file)
}

export function rankByCosine(index: VectorIndex, query: number[]): Array<{ name: string; score: number }> {
	return Object.entries(index)
		.map(([name, e]) => ({ name, score: cosine(e.vector, query) }))
		.sort((x, y) => y.score - x.score)
}
