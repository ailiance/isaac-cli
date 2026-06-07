// src/services/memory/dreaming/__tests__/wireIndexOnSave.test.ts
//
// T5: the embeddings index-on-save path in buildDreamDeps().save is gated
// behind ISAAC_MEM_EMBEDDINGS. These tests inject fake embed/index hooks so
// no network or real index file is touched. The candidate is saved to the
// real memory store (saveMemory is not injectable) then cleaned up.
import { strict as assert } from "node:assert"
import { afterEach, describe, it } from "mocha"
import { deleteMemory } from "@/utils/ailiance-memory"
import type { VectorIndex } from "../../embeddings/vectorIndex"
import type { MemoryCandidate } from "../types"
import { buildDreamDeps, type EmbedHooks } from "../wire"

const NAME = "t5-wire-test-mem"
const candidate: MemoryCandidate = {
	scope: "global",
	type: "user",
	name: NAME,
	description: "throwaway test memory",
	body: "some body text",
}

function makeHooks(over: Partial<EmbedHooks>): {
	hooks: EmbedHooks
	calls: { embed: number; load: number; save: VectorIndex[] }
} {
	const calls = { embed: 0, load: 0, save: [] as VectorIndex[] }
	const hooks: EmbedHooks = {
		embed: async () => {
			calls.embed++
			return [1, 0, 0]
		},
		loadIndex: async () => {
			calls.load++
			return {}
		},
		saveIndex: async (_file, idx) => {
			calls.save.push(idx)
		},
		indexFile: "/tmp/should-not-be-written.json",
		env: {},
		...over,
	}
	return { hooks, calls }
}

describe("buildDreamDeps save: embeddings index-on-save (gated)", () => {
	afterEach(async () => {
		await deleteMemory(NAME)
	})

	const noopApi = () => ({}) as any
	const mode = () => "act" as any

	it("A (default OFF): never embeds or writes the index", async () => {
		// env without ISAAC_MEM_EMBEDDINGS=1 ⇒ embedConfigFromEnv() === null.
		const { hooks, calls } = makeHooks({ env: {} })
		const deps = buildDreamDeps(noopApi, mode, [], hooks)
		await deps.save(candidate)
		assert.equal(calls.embed, 0, "embed must not be called when OFF")
		assert.equal(calls.save.length, 0, "saveIndex must not be called when OFF")
	})

	it("B (ON): embeds and merges the entry into the index", async () => {
		const { hooks, calls } = makeHooks({
			env: { ISAAC_MEM_EMBEDDINGS: "1", ISAAC_EMBEDDINGS_BASE_URL: "http://x", ISAAC_EMBEDDINGS_API_KEY: "k" },
			loadIndex: async () => ({ existing: { vector: [9], scope: "global" } }),
		})
		const deps = buildDreamDeps(noopApi, mode, [], hooks)
		await deps.save(candidate)
		assert.equal(calls.embed, 1)
		assert.equal(calls.save.length, 1)
		const written = calls.save[0]
		assert.deepEqual(written[NAME], { vector: [1, 0, 0], scope: "global" })
		assert.ok(written.existing, "existing entries must be merged, not dropped")
	})

	it("C (ON but embed returns null): saveMemory still succeeds, no index write", async () => {
		const { hooks, calls } = makeHooks({
			env: { ISAAC_MEM_EMBEDDINGS: "1", ISAAC_EMBEDDINGS_BASE_URL: "http://x", ISAAC_EMBEDDINGS_API_KEY: "k" },
			embed: async () => {
				calls.embed++
				return null
			},
		})
		const deps = buildDreamDeps(noopApi, mode, [], hooks)
		await deps.save(candidate) // must not throw
		assert.equal(calls.embed, 1)
		assert.equal(calls.save.length, 0, "no index write when embed is null")
	})
})
