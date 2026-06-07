import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import { InMemoryEnvironment } from "../InMemoryEnvironment"
import { runEnvironmentConformance } from "./conformance"

describe("InMemoryEnvironment", () => {
	it("writes, reads, stats, lists, deletes", async () => {
		const env = new InMemoryEnvironment("/work")
		await env.writeFile("a/b.txt", "hello")
		assert.equal(await env.readFile("a/b.txt"), "hello")
		assert.equal(await env.exists("a/b.txt"), true)
		assert.equal((await env.stat("a/b.txt")).size, 5)
		assert.deepEqual(
			(await env.list("a")).map((e) => e.name),
			["b.txt"],
		)
		await env.delete("a/b.txt")
		assert.equal(await env.exists("a/b.txt"), false)
	})

	it("throws EnvironmentError on missing read", async () => {
		const env = new InMemoryEnvironment("/work")
		await assert.rejects(() => env.readFile("nope.txt"), /environment readFile failed/)
	})

	describe("conformance", () => {
		runEnvironmentConformance(async () => new InMemoryEnvironment("/work"))
	})
})
