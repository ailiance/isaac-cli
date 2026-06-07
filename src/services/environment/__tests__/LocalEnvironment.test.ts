import { strict as assert } from "node:assert"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, it } from "mocha"
import { LocalEnvironment } from "../LocalEnvironment"
import { runEnvironmentConformance } from "./conformance"

describe("LocalEnvironment", () => {
	let dir: string
	let env: LocalEnvironment

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "isaac-env-"))
		env = new LocalEnvironment(dir)
	})
	afterEach(async () => {
		await env.dispose()
		await fs.rm(dir, { recursive: true, force: true })
	})

	it("writes and reads a file (cwd-relative)", async () => {
		await env.writeFile("a/b.txt", "hello")
		assert.equal(await env.readFile("a/b.txt"), "hello")
		assert.equal(await env.exists("a/b.txt"), true)
		assert.equal(await env.exists("missing.txt"), false)
	})

	it("stats a file", async () => {
		await env.writeFile("c.txt", "xyz")
		const st = await env.stat("c.txt")
		assert.equal(st.isDir, false)
		assert.equal(st.size, 3)
	})

	it("lists a directory", async () => {
		await env.writeFile("d/one.txt", "1")
		await env.writeFile("d/two.txt", "2")
		const entries = await env.list("d")
		assert.deepEqual(entries.map((e) => e.name).sort(), ["one.txt", "two.txt"])
	})

	it("execs a command and streams stdout + exit code", async () => {
		const h = env.exec("echo hello")
		let out = ""
		for await (const chunk of h.stdout) {
			out += chunk
		}
		assert.equal(await h.exitCode, 0)
		assert.match(out, /hello/)
	})

	describe("conformance", () => {
		runEnvironmentConformance(async () => new LocalEnvironment(await fs.mkdtemp(path.join(os.tmpdir(), "isaac-env-conf-"))))
	})
})
