import { afterEach, beforeEach, describe, it } from "mocha"
import "should"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { Embedder } from "../Embedder"
import { ToolVectorIndex } from "../ToolVectorIndex"

function tmpFile(): string {
	return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tvi-")), "index.json")
}

describe("ToolVectorIndex", () => {
	let cachePath: string
	beforeEach(() => {
		cachePath = tmpFile()
	})
	afterEach(() => {
		fs.rmSync(path.dirname(cachePath), { recursive: true, force: true })
	})

	it("embeds each tool once and returns vectors keyed by qualifiedName", async () => {
		let embedCalls = 0
		const embedder = new Embedder(async () => async (texts: string[]) => {
			embedCalls += texts.length
			return texts.map((t) => new Float32Array([t.length]))
		})
		const idx = new ToolVectorIndex(embedder, cachePath)
		const tools = [
			{ qualifiedName: "mcp__p_s__a", text: "alpha" },
			{ qualifiedName: "mcp__p_s__b", text: "beta!" },
		]
		const vecs = await idx.build(tools)
		embedCalls.should.equal(2)
		Array.from(vecs.get("mcp__p_s__a")!).should.deepEqual([5])
	})

	it("re-uses the disk cache and only embeds new/changed tools", async () => {
		let embedCalls = 0
		const embedder = new Embedder(async () => async (texts: string[]) => {
			embedCalls += texts.length
			return texts.map((t) => new Float32Array([t.length]))
		})
		const tools = [{ qualifiedName: "mcp__p_s__a", text: "alpha" }]
		await new ToolVectorIndex(embedder, cachePath).build(tools)
		await new ToolVectorIndex(embedder, cachePath).build(tools)
		embedCalls.should.equal(1)
		await new ToolVectorIndex(embedder, cachePath).build([{ qualifiedName: "mcp__p_s__a", text: "alpha2" }])
		embedCalls.should.equal(2)
	})

	it("does not crash when the embedder returns fewer vectors than requested", async () => {
		const embedder = new Embedder(async () => async (_texts: string[]) => [] as Float32Array[])
		const idx = new ToolVectorIndex(embedder, cachePath)
		const vecs = await idx.build([{ qualifiedName: "mcp__p_s__x", text: "x" }])
		vecs.has("mcp__p_s__x").should.equal(false)
	})
})
