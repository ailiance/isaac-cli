// src/services/memory/embeddings/__tests__/embedClient.test.ts
import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import { Logger } from "../../../../shared/services/Logger"
import { embedText } from "../embedClient"

describe("embedText", () => {
	it("posts to <base>/embeddings and returns the vector", async () => {
		let url = ""
		const fakeFetch = async (u: string, init: any) => {
			url = u
			assert.equal(JSON.parse(init.body).input, "hello")
			return { ok: true, json: async () => ({ data: [{ embedding: [0.1, 0.2] }] }) } as any
		}
		const v = await embedText("hello", { baseUrl: "https://gw/v1", apiKey: "k", model: "emb" }, fakeFetch as any)
		assert.deepEqual(v, [0.1, 0.2])
		assert.match(url, /\/embeddings$/)
	})
	it("returns null on non-ok / error (caller falls back)", async () => {
		const bad = async () => ({ ok: false, status: 500, json: async () => ({}) }) as any
		assert.equal(await embedText("x", { baseUrl: "https://gw/v1", apiKey: "k", model: "emb" }, bad as any), null)
	})
	it("warns instead of failing silently when the endpoint is unavailable", async () => {
		const msgs: string[] = []
		Logger.subscribe((m) => msgs.push(m))
		const notFound = async () => ({ ok: false, status: 404, json: async () => ({}) }) as any
		await embedText("x", { baseUrl: "https://gw/v1", apiKey: "k", model: "emb" }, notFound as any)
		assert.ok(
			msgs.some((m) => /embed/i.test(m) && /404/.test(m)),
			"expected a warning mentioning the embeddings failure and status",
		)
	})
})
