export function cosineSim(a: Float32Array, b: Float32Array): number {
	let dot = 0
	let na = 0
	let nb = 0
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i]
		na += a[i] * a[i]
		nb += b[i] * b[i]
	}
	if (na === 0 || nb === 0) {
		return 0
	}
	return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

export interface ScoredItem {
	id: string
	vec: Float32Array
}

export interface SelectOptions {
	k: number
	threshold: number
}

export function selectTopK(query: Float32Array, items: ScoredItem[], opts: SelectOptions): string[] {
	return items
		.map((it) => ({ id: it.id, score: cosineSim(query, it.vec) }))
		.filter((s) => s.score >= opts.threshold)
		.sort((a, b) => b.score - a.score)
		.slice(0, Math.max(0, opts.k))
		.map((s) => s.id)
}
