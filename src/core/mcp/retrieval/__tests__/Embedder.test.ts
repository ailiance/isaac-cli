import { describe, it } from "mocha"
import "should"
import { Embedder } from "../Embedder"

describe("Embedder", () => {
	it("embeds via the injected pipeline and returns Float32Array[]", async () => {
		const fakePipeline = async (texts: string[]) => texts.map((t) => new Float32Array([t.length, 0, 0]))
		const e = new Embedder(async () => fakePipeline)
		const [v] = await e.embed(["abc"])
		Array.from(v).should.deepEqual([3, 0, 0])
	})

	it("loads the pipeline only once (lazy, memoized)", async () => {
		let loads = 0
		const e = new Embedder(async () => {
			loads++
			return async (texts: string[]) => texts.map(() => new Float32Array([1]))
		})
		await e.embed(["a"])
		await e.embed(["b"])
		loads.should.equal(1)
	})

	it("propagates load failure (caller degrades)", async () => {
		const e = new Embedder(async () => {
			throw new Error("model load failed")
		})
		let threw = false
		try {
			await e.embed(["a"])
		} catch {
			threw = true
		}
		threw.should.equal(true)
	})
})
