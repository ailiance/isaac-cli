import { describe, it } from "mocha"
import "should"
import { ActiveMcpToolSet } from "../ActiveMcpToolSet"
import { Embedder } from "../Embedder"

function makeEmbedder(map: Record<string, number[]>) {
	return new Embedder(async () => async (texts: string[]) => texts.map((t) => Float32Array.from(map[t] ?? [0, 0])))
}

describe("ActiveMcpToolSet", () => {
	const vectors = new Map<string, Float32Array>([
		["mcp__git__issues", Float32Array.from([1, 0])],
		["mcp__fs__read", Float32Array.from([0, 1])],
	])

	it("seeds the base set from the prompt (cap + threshold)", async () => {
		const embedder = makeEmbedder({ "find github issues": [1, 0] })
		const set = new ActiveMcpToolSet(embedder, vectors, { baseK: 8, findK: 5, threshold: 0.3 })
		await set.seed("find github issues")
		set.snapshot().has("mcp__git__issues").should.equal(true)
		set.snapshot().has("mcp__fs__read").should.equal(false)
	})

	it("expand() adds matching tools and is idempotent", async () => {
		const embedder = makeEmbedder({ "read a file": [0, 1], seed: [1, 0] })
		const set = new ActiveMcpToolSet(embedder, vectors, { baseK: 8, findK: 5, threshold: 0.3 })
		await set.seed("seed")
		const added = await set.expand("read a file")
		added.should.deepEqual(["mcp__fs__read"])
		set.snapshot().has("mcp__fs__read").should.equal(true)
		;(await set.expand("read a file")).should.deepEqual([])
	})

	it("degrades to empty set + available()=false when embedder throws", async () => {
		const embedder = new Embedder(async () => {
			throw new Error("no model")
		})
		const set = new ActiveMcpToolSet(embedder, vectors, { baseK: 8, findK: 5, threshold: 0.3 })
		await set.seed("anything")
		set.snapshot().size.should.equal(0)
		set.available().should.equal(false)
	})
})
