import { strict as assert } from "node:assert"
import { it } from "mocha"
import type { Environment } from "../types"

/** Shared behavior every Environment implementation must satisfy. */
export function runEnvironmentConformance(make: () => Promise<Environment>) {
	it("conformance: write -> read -> exists -> stat -> delete", async () => {
		const env = await make()
		await env.writeFile("f/g.txt", "abc")
		assert.equal(await env.readFile("f/g.txt"), "abc")
		assert.equal(await env.exists("f/g.txt"), true)
		assert.equal((await env.stat("f/g.txt")).size, 3)
		await env.delete("f/g.txt")
		assert.equal(await env.exists("f/g.txt"), false)
		await env.dispose()
	})

	it("conformance: list returns written entries", async () => {
		const env = await make()
		await env.writeFile("d/x.txt", "1")
		await env.writeFile("d/y.txt", "2")
		const names = (await env.list("d")).map((e) => e.name).sort()
		assert.deepEqual(names, ["x.txt", "y.txt"])
		await env.dispose()
	})

	it("conformance: missing read rejects", async () => {
		const env = await make()
		await assert.rejects(() => env.readFile("absent.txt"))
		await env.dispose()
	})
}
