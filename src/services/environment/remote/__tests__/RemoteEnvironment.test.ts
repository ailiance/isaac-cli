import { strict as assert } from "node:assert"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, it } from "mocha"
import { runEnvironmentConformance } from "../../__tests__/conformance"
import { createDaemonServer } from "../daemon"
import { RemoteEnvironment } from "../RemoteEnvironment"
import { inProcessTransportPair } from "../transport"

describe("RemoteEnvironment (in-process daemon)", () => {
	runEnvironmentConformance(async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "isaac-remote-"))
		const [clientT, serverT] = inProcessTransportPair()
		createDaemonServer(serverT, dir)
		return new RemoteEnvironment(clientT, dir)
	})

	it("runCommand streams output via notifications and resolves", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "isaac-remote-cmd-"))
		const [clientT, serverT] = inProcessTransportPair()
		createDaemonServer(serverT, dir)
		const env = new RemoteEnvironment(clientT, dir)
		const lines: string[] = []
		const [rejected] = await env.runCommand("echo hello", 30, { onOutputLine: (l) => lines.push(l) })
		assert.equal(rejected, false)
		assert.match(lines.join(""), /hello/)
		await env.dispose()
	})

	it("preserves ENOENT error code across the wire", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "isaac-remote-err-"))
		const [clientT, serverT] = inProcessTransportPair()
		createDaemonServer(serverT, dir)
		const env = new RemoteEnvironment(clientT, dir)
		await assert.rejects(
			() => env.readFile("missing.txt"),
			(e: any) => e?.cause?.code === "ENOENT" || /ENOENT/.test(String(e?.message)),
		)
		await env.dispose()
	})
})
