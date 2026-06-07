// src/services/memory/embeddings/embedClient.ts
export interface EmbedConfig {
	baseUrl: string
	apiKey: string
	model: string
}
type FetchLike = typeof fetch

/** Calls an OpenAI-compatible /embeddings endpoint. Returns null on any failure (caller falls back). */
export async function embedText(text: string, cfg: EmbedConfig, fetchImpl: FetchLike = fetch): Promise<number[] | null> {
	try {
		const res = await fetchImpl(`${cfg.baseUrl.replace(/\/$/, "")}/embeddings`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
			body: JSON.stringify({ model: cfg.model, input: text }),
		})
		if (!res.ok) {
			return null
		}
		const json: any = await res.json()
		const vec = json?.data?.[0]?.embedding
		return Array.isArray(vec) ? vec : null
	} catch {
		return null
	}
}
