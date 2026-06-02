export type EmbedFn = (texts: string[]) => Promise<Float32Array[]>
export type PipelineFactory = () => Promise<EmbedFn>

/**
 * Lazy local text embedder. The pipeline factory is injected so tests run
 * without loading the real ONNX model. Production wires the transformers.js
 * factory in `createDefaultEmbedder`.
 */
export class Embedder {
	private pipelinePromise: Promise<EmbedFn> | undefined

	constructor(private readonly factory: PipelineFactory) {}

	async embed(texts: string[]): Promise<Float32Array[]> {
		if (!this.pipelinePromise) {
			this.pipelinePromise = this.factory()
		}
		const fn = await this.pipelinePromise
		return fn(texts)
	}
}

/** Upstream public model id. Supply-chain policy: production should mirror the
 * weights into the `ailiance` org and point `AILIANCE_EMBED_MODEL` at the
 * vendored repo/path (loaded offline) rather than the public HF CDN. */
const DEFAULT_EMBED_MODEL = "Xenova/all-MiniLM-L6-v2"

/**
 * Production factory: all-MiniLM-L6-v2 ONNX via transformers.js, mean-pooled +
 * normalized 384-d. Imported lazily so `--no-mcp` never pays the import cost.
 * The model id is overridable via `AILIANCE_EMBED_MODEL` (point it at the
 * mirrored/vendored weights); `AILIANCE_EMBED_OFFLINE=1` forbids any network
 * fetch (transformers.js loads only from the local cache).
 */
export function createDefaultEmbedder(): Embedder {
	const modelId = process.env.AILIANCE_EMBED_MODEL || DEFAULT_EMBED_MODEL
	return new Embedder(async () => {
		const transformers = await import("@huggingface/transformers")
		const { pipeline } = transformers
		if (process.env.AILIANCE_EMBED_OFFLINE === "1" && transformers.env) {
			transformers.env.allowRemoteModels = false
		}
		const extractor = await pipeline("feature-extraction", modelId)
		return async (texts: string[]) => {
			const out = await (extractor as any)(texts, { pooling: "mean", normalize: true })
			return (out as { tolist(): number[][] }).tolist().map((row) => Float32Array.from(row))
		}
	})
}
