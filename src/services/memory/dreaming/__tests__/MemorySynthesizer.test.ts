// src/services/memory/dreaming/__tests__/MemorySynthesizer.test.ts
import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import { synthesizeMemories } from "../MemorySynthesizer"

async function* fakeStream(text: string) {
	yield { type: "text", text } as any
}

describe("synthesizeMemories", () => {
	it("parses candidates and dedups vs existing by name", async () => {
		const modelJson = JSON.stringify([
			{
				scope: "project:repo",
				type: "project",
				name: "uses-vitest",
				description: "tests via vitest",
				body: "The repo uses vitest.",
			},
			{ scope: "global", type: "user", name: "prefers-fr", description: "FR", body: "User converses in French." },
		])
		const { created, reobserved } = await synthesizeMemories("transcript", [{ name: "uses-vitest" }], {
			createMessage: () => fakeStream(modelJson),
		})
		assert.deepEqual(
			created.map((c) => c.name),
			["prefers-fr"],
		)
		// The name matching an existing memory is surfaced as re-observed, not dropped.
		assert.deepEqual(reobserved, ["uses-vitest"])
	})
	it("returns empty result on unparseable output", async () => {
		assert.deepEqual(await synthesizeMemories("x", [], { createMessage: () => fakeStream("not json") }), {
			created: [],
			reobserved: [],
		})
	})
	it("dedups re-observed names", async () => {
		const modelJson = JSON.stringify([
			{ scope: "global", type: "user", name: "uses-vitest", description: "d", body: "b" },
			{ scope: "global", type: "user", name: "uses-vitest", description: "d2", body: "b2" },
		])
		const { created, reobserved } = await synthesizeMemories("t", [{ name: "uses-vitest" }], {
			createMessage: () => fakeStream(modelJson),
		})
		assert.deepEqual(created, [])
		assert.deepEqual(reobserved, ["uses-vitest"])
	})
	it("slugifies odd names so saveMemory never rejects them (poison-loop guard)", async () => {
		const modelJson = JSON.stringify([
			{ scope: "global", type: "user", name: "prefers Français!", description: "d", body: "b" },
		])
		const { created } = await synthesizeMemories("t", [], { createMessage: () => fakeStream(modelJson) })
		const [c] = created
		assert.match(c.name, /^[a-z0-9][a-z0-9_-]*$/)
		assert.equal(c.name, "prefers-francais")
	})
})
