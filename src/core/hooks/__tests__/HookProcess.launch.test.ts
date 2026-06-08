import { strict as assert } from "node:assert"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, it } from "mocha"
import { getHookLaunchConfig } from "../HookProcess"

describe("getHookLaunchConfig (unix)", () => {
	let scriptPath = ""
	afterEach(async () => {
		if (scriptPath) await fs.rm(scriptPath, { force: true })
	})

	it("runs the script directly without a shell and makes it executable", async function () {
		if (process.platform === "win32") {
			this.skip()
		}
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hook-"))
		scriptPath = path.join(dir, "hook with spaces.sh")
		await fs.writeFile(scriptPath, "#!/usr/bin/env bash\necho hi\n")

		const cfg = await getHookLaunchConfig(scriptPath)

		assert.equal(cfg.shell, false, "must not use a shell")
		assert.equal(cfg.command, scriptPath, "command is the raw path (no shell escaping)")
		assert.deepEqual(cfg.args, [])
		const mode = (await fs.stat(scriptPath)).mode
		assert.ok(mode & 0o100, "owner-execute bit must be set")
	})
})
