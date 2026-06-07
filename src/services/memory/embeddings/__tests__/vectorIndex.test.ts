// src/services/memory/embeddings/__tests__/vectorIndex.test.ts
import { strict as assert } from "node:assert"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, it } from "mocha"
import { cosine, loadIndex, rankByCosine, saveIndex } from "../vectorIndex"

describe("vectorIndex", () => {
	let file: string
	beforeEach(async () => {
		file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "vi-")), "idx.json")
	})
	afterEach(async () => {
		await fs.rm(path.dirname(file), { recursive: true, force: true })
	})

	it("cosine: identical=1, orthogonal=0", () => {
		assert.ok(Math.abs(cosine([1, 0], [1, 0]) - 1) < 1e-9)
		assert.ok(Math.abs(cosine([1, 0], [0, 1])) < 1e-9)
	})
	it("round-trips index + ranks by cosine to the query", async () => {
		await saveIndex(file, { a: { vector: [1, 0], scope: "global" }, b: { vector: [0, 1], scope: "global" } })
		const idx = await loadIndex(file)
		const ranked = rankByCosine(idx, [0.9, 0.1]).map((r) => r.name)
		assert.deepEqual(ranked, ["a", "b"])
	})
	it("missing index -> {}", async () => {
		assert.deepEqual(await loadIndex(path.join(file, "nope.json")), {})
	})
})
