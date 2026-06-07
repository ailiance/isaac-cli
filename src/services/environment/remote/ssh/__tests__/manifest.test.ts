import { strict as assert } from "node:assert"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, it } from "mocha"
import { buildManifest, locallyChanged } from "../manifest"

describe("workspace manifest", () => {
	let dir: string
	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "manifest-"))
	})
	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true })
	})

	it("detects modified + new files vs the seed manifest", async () => {
		await fs.writeFile(path.join(dir, "a.txt"), "A")
		await fs.writeFile(path.join(dir, "b.txt"), "B")
		const seed = await buildManifest(dir, [])
		await fs.writeFile(path.join(dir, "a.txt"), "A2")
		await fs.writeFile(path.join(dir, "c.txt"), "C")
		const changed = (await locallyChanged(dir, seed, [])).sort()
		assert.deepEqual(changed, ["a.txt", "c.txt"])
	})
	it("respects excludes", async () => {
		await fs.mkdir(path.join(dir, "node_modules"))
		await fs.writeFile(path.join(dir, "node_modules", "x.js"), "x")
		const m = await buildManifest(dir, ["node_modules"])
		assert.equal(
			Object.keys(m).some((k) => k.startsWith("node_modules/")),
			false,
		)
	})
})
