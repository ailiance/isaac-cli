import { strict as assert } from "node:assert"
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, it } from "mocha"
import { RemoteEnvironment } from "../RemoteEnvironment"
import { subprocessTransport } from "../transport"

// Default-skipped: opt-in via ISAAC_E2E_DAEMON=1 so the unit gate stays fast and
// hermetic. The in-process conformance suite is the protocol equivalence proof.
const RUN = process.env.ISAAC_E2E_DAEMON === "1"

;(RUN ? describe : describe.skip)("daemon subprocess integration", () => {
	it("runs file ops against a spawned daemon", async function () {
		this.timeout(30_000)
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "isaac-daemon-int-"))
		const child = spawn("npx", [
			"tsx",
			path.resolve("src/services/environment/remote/daemon.ts"),
			dir,
		]) as ChildProcessWithoutNullStreams
		const env = new RemoteEnvironment(subprocessTransport(child), dir)
		await env.writeFile("hi.txt", "REMOTE_OK")
		assert.equal(await env.readFile("hi.txt"), "REMOTE_OK")
		await env.dispose()
	})
})
