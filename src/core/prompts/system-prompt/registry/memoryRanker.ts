// src/core/prompts/system-prompt/registry/memoryRanker.ts
import { embedConfigFromEnv } from "@/services/memory/embeddings/embedEnvConfig"
import { makeSemanticRanker } from "@/services/memory/embeddings/semanticRanker"
import { EMBEDDINGS_INDEX_FILE } from "@/services/memory/embeddings/vectorIndex"
import type { SemanticRanker } from "@/utils/ailiance-memory"

/**
 * Select the semantic memory ranker for the system-prompt memory section.
 *
 * Gated behind ISAAC_MEM_EMBEDDINGS via embedConfigFromEnv: when embeddings
 * are disabled or unconfigured (the default), returns undefined so
 * loadRelevantMemories runs its unchanged token-overlap path — byte-identical
 * to today. When enabled + configured, returns a ranker backed by the sidecar
 * vector index.
 */
export function selectMemoryRanker(env: NodeJS.ProcessEnv = process.env): SemanticRanker | undefined {
	const cfg = embedConfigFromEnv(env)
	if (!cfg) {
		return undefined
	}
	return makeSemanticRanker(EMBEDDINGS_INDEX_FILE, cfg)
}
