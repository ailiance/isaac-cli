// src/services/memory/embeddings/__tests__/semanticRanker.test.ts
import { strict as assert } from "node:assert"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, it } from "mocha"
import { makeSemanticRanker } from "../semanticRanker"
import { saveIndex } from "../vectorIndex"

const cfg = { baseUrl: "https://gw/v1", apiKey: "k", model: "emb" }

describe("makeSemanticRanker", () => {
	let file: string
	beforeEach(async () => {
		file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "sr-")), "idx.json")
	})
	afterEach(async () => {
		await fs.rm(path.dirname(file), { recursive: true, force: true })
	})

	it("ranks candidate names by cosine against the embedded query", async () => {
		await saveIndex(file, {
			a: { vector: [1, 0], scope: "global" },
			b: { vector: [0, 1], scope: "global" },
		})
		const embed = async () => [0.9, 0.1]
		const ranker = makeSemanticRanker(file, cfg, embed as any)
		const scores = await ranker.rank("q", ["a", "b"])
		assert.ok(scores)
		assert.ok((scores!.get("a") ?? 0) > (scores!.get("b") ?? 0))
	})

	it("returns null when embed fails", async () => {
		await saveIndex(file, { a: { vector: [1, 0], scope: "global" } })
		const embed = async () => null
		const ranker = makeSemanticRanker(file, cfg, embed as any)
		assert.equal(await ranker.rank("q", ["a"]), null)
	})

	it("returns null when the index is empty/missing", async () => {
		const embed = async () => [1, 0]
		const ranker = makeSemanticRanker(path.join(file, "nope.json"), cfg, embed as any)
		assert.equal(await ranker.rank("q", ["a"]), null)
	})

	it("returns null when no candidate name is in the index", async () => {
		await saveIndex(file, { a: { vector: [1, 0], scope: "global" } })
		const embed = async () => [1, 0]
		const ranker = makeSemanticRanker(file, cfg, embed as any)
		assert.equal(await ranker.rank("q", ["zzz"]), null)
	})
})
