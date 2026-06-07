import { strict as assert } from "node:assert"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, it } from "mocha"
import { SshRemoteSession } from "../SshRemoteSession"

const HOST = process.env.ISAAC_E2E_SSH // e.g. "studio"
;(HOST ? describe : describe.skip)("ssh integration (real remote)", () => {
	it("seeds, writes remotely via the agent path, pulls back", async function () {
		this.timeout(120_000)
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "isaac-ssh-"))
		await fs.writeFile(path.join(dir, "seed.txt"), "SEED")
		const env = SshRemoteSession.create(HOST!, dir)
		await env.writeFile("remote-made.txt", "FROM_REMOTE")
		await env.dispose() // triggers pull-back
		assert.equal(await fs.readFile(path.join(dir, "remote-made.txt"), "utf8"), "FROM_REMOTE")
	})
})
