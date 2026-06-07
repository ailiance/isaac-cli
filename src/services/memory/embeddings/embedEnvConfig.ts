// src/services/memory/embeddings/embedEnvConfig.ts
import type { EmbedConfig } from "./embedClient"

/** Returns an EmbedConfig from env, or null when embeddings are disabled or unconfigured.
 *  Gated: only active when ISAAC_MEM_EMBEDDINGS === "1". Default OFF ⇒ null ⇒ callers no-op. */
export function embedConfigFromEnv(env: NodeJS.ProcessEnv = process.env): EmbedConfig | null {
	if (env.ISAAC_MEM_EMBEDDINGS !== "1") {
		return null
	}
	const baseUrl = env.ISAAC_EMBEDDINGS_BASE_URL
	const apiKey = env.ISAAC_EMBEDDINGS_API_KEY
	if (!baseUrl || !apiKey) {
		return null
	}
	const model = env.ISAAC_EMBEDDINGS_MODEL || "text-embedding-3-small"
	return { baseUrl, apiKey, model }
}
