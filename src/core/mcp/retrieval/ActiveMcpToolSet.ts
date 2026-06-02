import { Logger } from "@/shared/services/Logger"
import type { RetrievalConfig } from "./config"
import { type ScoredItem, selectTopK } from "./cosine"
import type { Embedder } from "./Embedder"

export class ActiveMcpToolSet {
	private readonly active = new Set<string>()
	private readonly items: ScoredItem[]
	private embedderOk = true

	constructor(
		private readonly embedder: Embedder,
		vectors: Map<string, Float32Array>,
		private readonly config: RetrievalConfig,
	) {
		this.items = Array.from(vectors.entries()).map(([id, vec]) => ({ id, vec }))
	}

	available(): boolean {
		return this.embedderOk
	}

	snapshot(): ReadonlySet<string> {
		return this.active
	}

	private async select(text: string, k: number): Promise<string[]> {
		const [q] = await this.embedder.embed([text])
		return selectTopK(q, this.items, { k, threshold: this.config.threshold })
	}

	async seed(prompt: string): Promise<void> {
		try {
			for (const id of await this.select(prompt, this.config.baseK)) {
				this.active.add(id)
			}
			Logger.debug(`[mcp-retrieval] seed selected ${this.active.size} tool(s): ${Array.from(this.active).join(", ")}`)
		} catch {
			this.embedderOk = false
		}
	}

	async expand(query: string): Promise<string[]> {
		try {
			const added: string[] = []
			for (const id of await this.select(query, this.config.findK)) {
				if (!this.active.has(id)) {
					this.active.add(id)
					added.push(id)
				}
			}
			Logger.debug(`[mcp-retrieval] find_tools added ${added.length} tool(s): ${added.join(", ")}`)
			return added
		} catch {
			this.embedderOk = false
			return []
		}
	}
}
