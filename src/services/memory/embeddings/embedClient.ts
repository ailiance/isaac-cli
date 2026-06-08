// src/services/memory/embeddings/embedClient.ts
import { Logger } from "../../../shared/services/Logger"

export interface EmbedConfig {
	baseUrl: string
	apiKey: string
	model: string
}
type FetchLike = typeof fetch

/** Calls an OpenAI-compatible /embeddings endpoint. Returns null on any failure (caller falls back).
 *  Failures are logged (not silent): embeddings are an opt-in feature, so a misconfigured or
 *  missing endpoint should be visible rather than degrading quietly to token-overlap ranking. */
export async function embedText(text: string, cfg: EmbedConfig, fetchImpl: FetchLike = fetch): Promise<number[] | null> {
	try {
		const res = await fetchImpl(`${cfg.baseUrl.replace(/\/$/, "")}/embeddings`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
			body: JSON.stringify({ model: cfg.model, input: text }),
		})
		if (!res.ok) {
			Logger.warn(`embedText: embeddings endpoint returned ${res.status}; falling back to token overlap`)
			return null
		}
		const json: any = await res.json()
		const vec = json?.data?.[0]?.embedding
		if (!Array.isArray(vec)) {
			Logger.warn("embedText: embeddings response had no vector; falling back to token overlap")
			return null
		}
		return vec
	} catch (err) {
		Logger.warn(
			`embedText: embeddings request failed (${err instanceof Error ? err.message : String(err)}); falling back to token overlap`,
		)
		return null
	}
}
