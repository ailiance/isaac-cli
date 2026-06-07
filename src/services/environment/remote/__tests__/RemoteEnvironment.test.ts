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

	// C1: the resolved result must carry the captured output (not [false, ""]),
	// mirroring the local executeCommandTool contract [userRejected, outputString].
	it("runCommand resolves with the captured output string", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "isaac-remote-result-"))
		const [clientT, serverT] = inProcessTransportPair()
		createDaemonServer(serverT, dir)
		const env = new RemoteEnvironment(clientT, dir)
		const [rejected, result] = await env.runCommand("echo hello", 30, {})
		assert.equal(rejected, false)
		assert.match(String(result), /hello/)
		await env.dispose()
	})

	// I1: concurrent runCommand calls must not cross-route their output. Each
	// callback only sees its own stream's chunks (per-call streamId multiplexing).
	it("routes concurrent runCommand output to the correct callback", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "isaac-remote-conc-"))
		const [clientT, serverT] = inProcessTransportPair()
		createDaemonServer(serverT, dir)
		const env = new RemoteEnvironment(clientT, dir)
		const a: string[] = []
		const b: string[] = []
		const [ra, rb] = await Promise.all([
			env.runCommand("echo AAA", 30, { onOutputLine: (l) => a.push(l) }),
			env.runCommand("echo BBB", 30, { onOutputLine: (l) => b.push(l) }),
		])
		assert.match(a.join(""), /AAA/)
		assert.doesNotMatch(a.join(""), /BBB/)
		assert.match(b.join(""), /BBB/)
		assert.doesNotMatch(b.join(""), /AAA/)
		assert.match(String(ra[1]), /AAA/)
		assert.match(String(rb[1]), /BBB/)
		await env.dispose()
	})

	// I2: an aborted runCommand kills the remote child and still resolves.
	it("aborts a running command via abortSignal", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "isaac-remote-abort-"))
		const [clientT, serverT] = inProcessTransportPair()
		createDaemonServer(serverT, dir)
		const env = new RemoteEnvironment(clientT, dir)
		const ac = new AbortController()
		const p = env.runCommand("sleep 10", 30, { abortSignal: ac.signal })
		setTimeout(() => ac.abort(), 50)
		const [rejected] = await p
		assert.equal(rejected, false)
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
