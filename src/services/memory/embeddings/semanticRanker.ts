// src/services/memory/embeddings/semanticRanker.ts
import type { SemanticRanker } from "@/utils/ailiance-memory"
import { type EmbedConfig, embedText } from "./embedClient"
import { cosine, loadIndex } from "./vectorIndex"

/**
 * Build a SemanticRanker backed by the sidecar vector index + a gateway
 * embedding of the query. Returns `null` from `rank()` on any condition
 * that should make `loadRelevantMemories` fall back to token-overlap:
 *   - empty / missing index
 *   - embed failure (offline, non-ok response)
 *   - no candidate name present in the index
 */
export function makeSemanticRanker(indexFile: string, cfg: EmbedConfig, embed = embedText): SemanticRanker {
	return {
		async rank(query, names) {
			const index = await loadIndex(indexFile)
			if (!Object.keys(index).length) {
				return null
			}
			const q = await embed(query, cfg)
			if (!q) {
				return null
			}
			const m = new Map<string, number>()
			for (const n of names) {
				const e = index[n]
				if (e) {
					m.set(n, cosine(e.vector, q))
				}
			}
			return m.size ? m : null
		},
	}
}
