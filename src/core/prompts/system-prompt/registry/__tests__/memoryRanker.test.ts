// src/core/prompts/system-prompt/registry/__tests__/memoryRanker.test.ts
import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import { selectMemoryRanker } from "../memoryRanker"

describe("selectMemoryRanker (gated)", () => {
	it("default OFF: returns undefined (token-overlap path unchanged)", () => {
		assert.equal(selectMemoryRanker({}), undefined)
	})
	it("ON but unconfigured: returns undefined", () => {
		assert.equal(selectMemoryRanker({ ISAAC_MEM_EMBEDDINGS: "1" }), undefined)
	})
	it("ON + configured: returns a ranker with a rank() method", () => {
		const ranker = selectMemoryRanker({
			ISAAC_MEM_EMBEDDINGS: "1",
			ISAAC_EMBEDDINGS_BASE_URL: "http://x",
			ISAAC_EMBEDDINGS_API_KEY: "k",
		})
		assert.ok(ranker, "ranker must be defined when enabled + configured")
		assert.equal(typeof ranker?.rank, "function")
	})
})
