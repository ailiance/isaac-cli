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

/**
 * Production factory: all-MiniLM-L6-v2 ONNX via transformers.js, mean-pooled +
 * normalized 384-d. Imported lazily so `--no-mcp` never pays the import cost.
 */
export function createDefaultEmbedder(): Embedder {
	return new Embedder(async () => {
		const { pipeline } = await import("@huggingface/transformers")
		const extractor = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2")
		return async (texts: string[]) => {
			const out = await (extractor as any)(texts, { pooling: "mean", normalize: true })
			return (out as { tolist(): number[][] }).tolist().map((row) => Float32Array.from(row))
		}
	})
}
