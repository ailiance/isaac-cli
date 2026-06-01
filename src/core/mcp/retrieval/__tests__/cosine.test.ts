import { describe, it } from "mocha"
import "should"
import { cosineSim, selectTopK } from "../cosine"

describe("cosine retrieval", () => {
	it("computes cosine similarity of normalized-ish vectors", () => {
		cosineSim(new Float32Array([1, 0]), new Float32Array([1, 0])).should.be.approximately(1, 1e-6)
		cosineSim(new Float32Array([1, 0]), new Float32Array([0, 1])).should.be.approximately(0, 1e-6)
		cosineSim(new Float32Array([0, 0]), new Float32Array([1, 0])).should.equal(0)
	})

	it("selectTopK applies threshold then caps, sorted by score desc", () => {
		const query = new Float32Array([1, 0])
		const items = [
			{ id: "a", vec: new Float32Array([1, 0]) },
			{ id: "b", vec: new Float32Array([0.9, 0.1]) },
			{ id: "c", vec: new Float32Array([0, 1]) },
		]
		selectTopK(query, items, { k: 1, threshold: 0.3 }).should.deepEqual(["a"])
		selectTopK(query, items, { k: 5, threshold: 0.3 }).should.deepEqual(["a", "b"])
		selectTopK(query, items, { k: 5, threshold: 0.99 }).should.deepEqual(["a", "b"])
	})

	it("returns [] when nothing clears the threshold or items is empty", () => {
		const q = new Float32Array([1, 0])
		selectTopK(q, [{ id: "c", vec: new Float32Array([0, 1]) }], { k: 5, threshold: 0.3 }).should.deepEqual([])
		selectTopK(q, [], { k: 5, threshold: 0.3 }).should.deepEqual([])
	})
})
