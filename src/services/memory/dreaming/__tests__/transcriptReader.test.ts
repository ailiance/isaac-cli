// src/services/memory/dreaming/__tests__/transcriptReader.test.ts
import { strict as assert } from "node:assert"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, it } from "mocha"
import { condenseRun } from "../transcriptReader"

describe("transcriptReader.condenseRun", () => {
	let dir: string
	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "dream-run-"))
	})
	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true })
	})

	it("condenses trace + meta, skipping corrupt lines", async () => {
		await fs.writeFile(
			path.join(dir, "meta.json"),
			JSON.stringify({ task: "add feature X", cwd: "/repo", exit_reason: "completed" }),
		)
		await fs.writeFile(
			path.join(dir, "trace.jsonl"),
			`{"turn":1,"phase":"execute","tool_execution":{"tool_name":"write_to_file","success":true}}\nNOT_JSON\n{"turn":2,"phase":"execute","errors":["boom"]}\n`,
		)
		const text = await condenseRun(dir)
		assert.match(text, /add feature X/)
		assert.match(text, /write_to_file/)
		assert.match(text, /boom/)
	})
})
