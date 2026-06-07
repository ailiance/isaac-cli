// src/services/memory/embeddings/__tests__/embedEnvConfig.test.ts
import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import { embedConfigFromEnv } from "../embedEnvConfig"

describe("embedConfigFromEnv", () => {
	it("returns null when ISAAC_MEM_EMBEDDINGS is absent (default OFF)", () => {
		assert.equal(embedConfigFromEnv({}), null)
	})
	it("returns null when ISAAC_MEM_EMBEDDINGS !== '1'", () => {
		assert.equal(
			embedConfigFromEnv({
				ISAAC_MEM_EMBEDDINGS: "true",
				ISAAC_EMBEDDINGS_BASE_URL: "http://x",
				ISAAC_EMBEDDINGS_API_KEY: "k",
			}),
			null,
		)
	})
	it("returns null when enabled but baseUrl missing", () => {
		assert.equal(embedConfigFromEnv({ ISAAC_MEM_EMBEDDINGS: "1", ISAAC_EMBEDDINGS_API_KEY: "k" }), null)
	})
	it("returns null when enabled but apiKey missing", () => {
		assert.equal(embedConfigFromEnv({ ISAAC_MEM_EMBEDDINGS: "1", ISAAC_EMBEDDINGS_BASE_URL: "http://x" }), null)
	})
	it("returns a config with default model when enabled + configured", () => {
		assert.deepEqual(
			embedConfigFromEnv({
				ISAAC_MEM_EMBEDDINGS: "1",
				ISAAC_EMBEDDINGS_BASE_URL: "http://x",
				ISAAC_EMBEDDINGS_API_KEY: "k",
			}),
			{ baseUrl: "http://x", apiKey: "k", model: "text-embedding-3-small" },
		)
	})
	it("respects a custom model", () => {
		assert.deepEqual(
			embedConfigFromEnv({
				ISAAC_MEM_EMBEDDINGS: "1",
				ISAAC_EMBEDDINGS_BASE_URL: "http://x",
				ISAAC_EMBEDDINGS_API_KEY: "k",
				ISAAC_EMBEDDINGS_MODEL: "my-model",
			}),
			{ baseUrl: "http://x", apiKey: "k", model: "my-model" },
		)
	})
})
