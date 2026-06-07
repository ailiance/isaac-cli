# LISAEL RemoteEnvironment + daemon — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add a `RemoteEnvironment` that executes tool I/O in a separate process over JSON-RPC 2.0/stdio, with a daemon that reuses `LocalEnvironment` — validated against a locally-spawned daemon, proven equivalent via the #1 conformance suite.

**Architecture:** `RemoteEnvironment implements Environment` (client) talks to a `daemon` (server) over a `Transport` (duplex message channel). The daemon dispatches each JSON-RPC request to a `LocalEnvironment`. Two transports: `inProcessTransportPair()` (in-memory, fast tests) and `subprocessTransport()` (a child's stdio). Streaming ops use `env/output` notifications. Selection via `resolveEnvironment`; default stays `LocalEnvironment` (unchanged).

**Tech Stack:** TypeScript strict, Node `child_process`/streams, JSON-RPC 2.0 (Content-Length framing), mocha + `node:assert/strict` + sinon, esbuild (daemon bundle).

**Spec:** `docs/superpowers/specs/2026-06-07-lisael-remote-environment-design.md`
**Branch:** `feat/lisael-remote` (off #1 tip `0dc7490`)

**Gate commands (repo root):** `npm run test:unit` · `npm run check-types` · `npm run lint`. Core tests: `npx cross-env TS_NODE_PROJECT=./tsconfig.unit-test.json mocha "<glob>"`.

**Shell setup:**
```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 22 >/dev/null; cd /Users/claude2/isaac-cli
```

**Reference (from #1, do not change):** `Environment` in `src/services/environment/types.ts` (methods: `readFile, writeFile, exists, stat, list, mkdir, delete, rename, exec, runCommand, listFilesNative, searchFormatted, dispose`; `EnvStat`, `DirEntry`, `ExecHandle`, `ExecOpts`, `SearchOpts`, `CommandRunner`, `EnvironmentError` with `override readonly cause`, `FileInfo` re-export). Conformance: `runEnvironmentConformance(make)` in `src/services/environment/__tests__/conformance.ts`. `LocalEnvironment` ctor: `(cwd, commandRunner?)`.

---

## File Structure

**Created** (under `src/services/environment/remote/`): `protocol.ts`, `transport.ts`, `RpcPeer.ts`, `RemoteEnvironment.ts`, `daemon.ts`, `__tests__/protocol.test.ts`, `__tests__/RemoteEnvironment.test.ts`, `__tests__/daemon.integration.test.ts`.

**Modified:** `src/services/environment/index.ts` (exports), `src/services/environment/resolveEnvironment.ts` (remote branch), `esbuild.mjs` (daemon bundle).

---

## Task 1: Protocol (types + framing codec + error mapping)

**Files:** Create `src/services/environment/remote/protocol.ts`; Test `src/services/environment/remote/__tests__/protocol.test.ts`.

- [ ] **Step 1: Failing test for the Content-Length codec**

```ts
// src/services/environment/remote/__tests__/protocol.test.ts
import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import { decodeMessages, encodeMessage } from "../protocol"

describe("protocol framing", () => {
	it("round-trips a message through Content-Length framing, buffered in chunks", () => {
		const buf = encodeMessage({ jsonrpc: "2.0", id: 1, method: "env/readFile", params: { path: "a.txt" } })
		const out: any[] = []
		const decoder = decodeMessages((m) => out.push(m))
		decoder.push(buf.subarray(0, 10))
		decoder.push(buf.subarray(10))
		assert.equal(out.length, 1)
		assert.equal(out[0].method, "env/readFile")
		assert.equal(out[0].params.path, "a.txt")
	})
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx cross-env TS_NODE_PROJECT=./tsconfig.unit-test.json mocha src/services/environment/remote/__tests__/protocol.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `protocol.ts`**

```ts
// src/services/environment/remote/protocol.ts
import { EnvironmentError } from "../types"

export const RPC_METHODS = {
	readFile: "env/readFile",
	writeFile: "env/writeFile",
	exists: "env/exists",
	stat: "env/stat",
	list: "env/list",
	mkdir: "env/mkdir",
	delete: "env/delete",
	rename: "env/rename",
	listFilesNative: "env/listFilesNative",
	searchFormatted: "env/searchFormatted",
	runCommand: "env/runCommand",
	dispose: "env/dispose",
} as const

export const NOTIFY = {
	output: "env/output", // server -> client: { streamId, stream, chunk }
	stdin: "env/stdin",
	kill: "env/kill",
	abort: "env/abort",
} as const

export interface RpcRequest { jsonrpc: "2.0"; id: number; method: string; params?: any }
export interface RpcResponse { jsonrpc: "2.0"; id: number; result?: any; error?: RpcError }
export interface RpcNotification { jsonrpc: "2.0"; method: string; params?: any }
export type RpcMessage = RpcRequest | RpcResponse | RpcNotification
export interface RpcError { code: number; message: string; data?: { op?: string; errno?: number; code?: string } }

export function encodeMessage(msg: RpcMessage): Buffer {
	const json = Buffer.from(JSON.stringify(msg), "utf8")
	const header = Buffer.from(`Content-Length: ${json.length}\r\n\r\n`, "ascii")
	return Buffer.concat([header, json])
}

/** Stateful decoder: feed chunks via push(); calls onMessage per complete frame. */
export function decodeMessages(onMessage: (m: RpcMessage) => void) {
	let buffer = Buffer.alloc(0)
	return {
		push(chunk: Buffer) {
			buffer = Buffer.concat([buffer, chunk])
			while (true) {
				const headerEnd = buffer.indexOf("\r\n\r\n")
				if (headerEnd === -1) return
				const header = buffer.subarray(0, headerEnd).toString("ascii")
				const match = header.match(/Content-Length:\s*(\d+)/i)
				if (!match) {
					buffer = buffer.subarray(headerEnd + 4)
					continue
				}
				const len = Number(match[1])
				const start = headerEnd + 4
				if (buffer.length < start + len) return
				const body = buffer.subarray(start, start + len).toString("utf8")
				buffer = buffer.subarray(start + len)
				onMessage(JSON.parse(body))
			}
		},
	}
}

export function toRpcError(e: unknown): RpcError {
	if (e instanceof EnvironmentError) {
		const cause: any = e.cause
		return { code: -32000, message: e.message, data: { op: e.op, errno: cause?.errno, code: cause?.code } }
	}
	const any: any = e
	return { code: -32000, message: String(any?.message ?? e), data: { code: any?.code } }
}

export function fromRpcError(err: RpcError): Error {
	const e: any = new EnvironmentError(err.data?.op ?? "remote", undefined, new Error(err.message))
	if (err.data?.code) {
		e.cause = { code: err.data.code, errno: err.data.errno, message: err.message }
	}
	return e
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx cross-env TS_NODE_PROJECT=./tsconfig.unit-test.json mocha src/services/environment/remote/__tests__/protocol.test.ts`
Expected: PASS (1 passing).

- [ ] **Step 5: Commit**

```bash
git add src/services/environment/remote/protocol.ts src/services/environment/remote/__tests__/protocol.test.ts
git commit -m "feat(env): remote JSON-RPC protocol + framing codec"
```

---

## Task 2: Transport (in-process pair + subprocess) + RpcPeer

**Files:** Create `src/services/environment/remote/transport.ts`, `src/services/environment/remote/RpcPeer.ts`; extend `__tests__/protocol.test.ts`.

- [ ] **Step 1: Failing test for `inProcessTransportPair` + `RpcPeer`**

Append to `protocol.test.ts`:
```ts
import { RpcPeer } from "../RpcPeer"
import { inProcessTransportPair } from "../transport"

describe("RpcPeer over in-process transport", () => {
	it("routes a request to the server handler and returns the result", async () => {
		const [clientT, serverT] = inProcessTransportPair()
		const server = new RpcPeer(serverT, { "env/echo": async (p) => ({ echoed: p.value }) })
		const client = new RpcPeer(clientT)
		assert.deepEqual(await client.request("env/echo", { value: 42 }), { echoed: 42 })
		server.dispose(); client.dispose()
	})
	it("propagates handler errors as rejections", async () => {
		const [clientT, serverT] = inProcessTransportPair()
		new RpcPeer(serverT, { "env/boom": async () => { throw new Error("nope") } })
		const client = new RpcPeer(clientT)
		await assert.rejects(() => client.request("env/boom", {}), /nope/)
	})
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx cross-env TS_NODE_PROJECT=./tsconfig.unit-test.json mocha src/services/environment/remote/__tests__/protocol.test.ts`
Expected: FAIL — `../transport` / `../RpcPeer` not found.

- [ ] **Step 3: Implement `transport.ts`**

```ts
// src/services/environment/remote/transport.ts
import type { ChildProcessWithoutNullStreams } from "node:child_process"
import { decodeMessages, encodeMessage, type RpcMessage } from "./protocol"

export interface Transport {
	send(msg: RpcMessage): void
	onMessage(cb: (m: RpcMessage) => void): void
	close(): void
}

export function inProcessTransportPair(): [Transport, Transport] {
	let aCb: ((m: RpcMessage) => void) | null = null
	let bCb: ((m: RpcMessage) => void) | null = null
	const a: Transport = {
		send: (m) => queueMicrotask(() => bCb?.(structuredClone(m))),
		onMessage: (cb) => { aCb = cb },
		close: () => { aCb = null },
	}
	const b: Transport = {
		send: (m) => queueMicrotask(() => aCb?.(structuredClone(m))),
		onMessage: (cb) => { bCb = cb },
		close: () => { bCb = null },
	}
	return [a, b]
}

export function subprocessTransport(child: ChildProcessWithoutNullStreams): Transport {
	let cb: ((m: RpcMessage) => void) | null = null
	const decoder = decodeMessages((m) => cb?.(m))
	child.stdout.on("data", (d: Buffer) => decoder.push(d))
	return {
		send: (m) => child.stdin.write(encodeMessage(m)),
		onMessage: (c) => { cb = c },
		close: () => { try { child.kill() } catch {} },
	}
}

/** Daemon side: frame over the current process's own stdio. */
export function stdioTransport(): Transport {
	let cb: ((m: RpcMessage) => void) | null = null
	const decoder = decodeMessages((m) => cb?.(m))
	process.stdin.on("data", (d: Buffer) => decoder.push(d))
	return {
		send: (m) => process.stdout.write(encodeMessage(m)),
		onMessage: (c) => { cb = c },
		close: () => {},
	}
}
```

- [ ] **Step 4: Implement `RpcPeer.ts`**

```ts
// src/services/environment/remote/RpcPeer.ts
import { fromRpcError, type RpcMessage, type RpcRequest, type RpcResponse, toRpcError } from "./protocol"
import type { Transport } from "./transport"

type Handler = (params: any) => Promise<any>
type NotifyHandler = (params: any) => void

export class RpcPeer {
	private nextId = 1
	private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>()
	private notifyHandlers = new Map<string, NotifyHandler>()

	constructor(private transport: Transport, private handlers: Record<string, Handler> = {}) {
		transport.onMessage((m) => this.onMessage(m))
	}

	request(method: string, params?: any): Promise<any> {
		const id = this.nextId++
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject })
			this.transport.send({ jsonrpc: "2.0", id, method, params } satisfies RpcRequest)
		})
	}
	notify(method: string, params?: any): void {
		this.transport.send({ jsonrpc: "2.0", method, params })
	}
	onNotify(method: string, cb: NotifyHandler): void {
		this.notifyHandlers.set(method, cb)
	}

	private onMessage(m: RpcMessage): void {
		if ("id" in m && "method" in m) {
			const req = m as RpcRequest
			const handler = this.handlers[req.method]
			if (!handler) {
				this.transport.send({ jsonrpc: "2.0", id: req.id, error: { code: -32601, message: `no handler: ${req.method}` } })
				return
			}
			handler(req.params)
				.then((result) => this.transport.send({ jsonrpc: "2.0", id: req.id, result }))
				.catch((e) => this.transport.send({ jsonrpc: "2.0", id: req.id, error: toRpcError(e) }))
		} else if ("id" in m) {
			const res = m as RpcResponse
			const p = this.pending.get(res.id)
			if (!p) return
			this.pending.delete(res.id)
			if (res.error) p.reject(fromRpcError(res.error))
			else p.resolve(res.result)
		} else if ("method" in m) {
			this.notifyHandlers.get(m.method)?.(m.params)
		}
	}

	dispose(): void {
		for (const p of this.pending.values()) p.reject(new Error("RpcPeer disposed"))
		this.pending.clear()
		this.transport.close()
	}
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx cross-env TS_NODE_PROJECT=./tsconfig.unit-test.json mocha src/services/environment/remote/__tests__/protocol.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/services/environment/remote/transport.ts src/services/environment/remote/RpcPeer.ts src/services/environment/remote/__tests__/protocol.test.ts
git commit -m "feat(env): transports (in-process/subprocess) + RpcPeer"
```

---

## Task 3: Daemon server (dispatch to LocalEnvironment)

**Files:** Create `src/services/environment/remote/daemon.ts`.

- [ ] **Step 1: Implement `createDaemonServer` + entry**

```ts
// src/services/environment/remote/daemon.ts
import { spawn } from "node:child_process"
import { LocalEnvironment } from "../LocalEnvironment"
import type { CommandRunner } from "../types"
import { NOTIFY, RPC_METHODS } from "./protocol"
import { RpcPeer } from "./RpcPeer"
import { stdioTransport, type Transport } from "./transport"

/** Daemon-side command runner: plain spawn, streams output via NOTIFY.output. */
function makeDaemonCommandRunner(getPeer: () => RpcPeer): CommandRunner {
	let counter = 0
	return (command, _timeoutSeconds, opts) =>
		new Promise((resolve) => {
			const streamId = `s${++counter}`
			const child = spawn(command, { shell: true })
			child.stdout.on("data", (d: Buffer) => {
				const chunk = d.toString("utf8")
				opts?.onOutputLine?.(chunk)
				getPeer().notify(NOTIFY.output, { streamId, stream: "stdout", chunk })
			})
			child.stderr.on("data", (d: Buffer) =>
				getPeer().notify(NOTIFY.output, { streamId, stream: "stderr", chunk: d.toString("utf8") }),
			)
			opts?.abortSignal?.addEventListener("abort", () => child.kill())
			child.on("close", () => resolve([false, ""]))
		})
}

export function createDaemonServer(transport: Transport, cwd: string): RpcPeer {
	let peer!: RpcPeer
	const env = new LocalEnvironment(cwd, makeDaemonCommandRunner(() => peer))
	const handlers: Record<string, (p: any) => Promise<any>> = {
		[RPC_METHODS.readFile]: (p) => env.readFile(p.path),
		[RPC_METHODS.writeFile]: (p) => env.writeFile(p.path, p.content).then(() => null),
		[RPC_METHODS.exists]: (p) => env.exists(p.path),
		[RPC_METHODS.stat]: (p) => env.stat(p.path),
		[RPC_METHODS.list]: (p) => env.list(p.path, p.opts),
		[RPC_METHODS.mkdir]: (p) => env.mkdir(p.path, p.opts).then(() => null),
		[RPC_METHODS.delete]: (p) => env.delete(p.path, p.opts).then(() => null),
		[RPC_METHODS.rename]: (p) => env.rename(p.from, p.to).then(() => null),
		[RPC_METHODS.listFilesNative]: (p) => env.listFilesNative(p.path, p.recursive, p.limit),
		[RPC_METHODS.searchFormatted]: (p) => env.searchFormatted(p.directoryPath, p.regex, p.opts),
		[RPC_METHODS.runCommand]: (p) => env.runCommand(p.command, p.timeoutSeconds, p.opts ?? {}),
		[RPC_METHODS.dispose]: () => env.dispose().then(() => null),
	}
	peer = new RpcPeer(transport, handlers)
	return peer
}

// Entry when spawned as `node dist/lisael-daemon.js [cwd]`
if (require.main === module) {
	createDaemonServer(stdioTransport(), process.argv[2] ?? process.cwd())
}
```

> The `getPeer: () => RpcPeer` thunk resolves the forward reference cleanly (peer is assigned before any command runs). Confirm `require.main === module` works under the cjs daemon bundle (esbuild cjs); if ESM, use an explicit `--entry` guard instead.

- [ ] **Step 2: Type-check + commit**

Run: `npm run check-types` → PASS.
```bash
git add src/services/environment/remote/daemon.ts
git commit -m "feat(env): daemon server dispatching to LocalEnvironment"
```

---

## Task 4: RemoteEnvironment client

**Files:** Create `src/services/environment/remote/RemoteEnvironment.ts`.

- [ ] **Step 1: Implement `RemoteEnvironment`**

```ts
// src/services/environment/remote/RemoteEnvironment.ts
import type {
	CommandRunner, DirEntry, Environment, EnvStat, ExecHandle, ExecOpts, FileInfo, SearchOpts,
} from "../types"
import { NOTIFY, RPC_METHODS } from "./protocol"
import { RpcPeer } from "./RpcPeer"
import type { Transport } from "./transport"

export class RemoteEnvironment implements Environment {
	readonly id: string
	private peer: RpcPeer
	private onClose?: () => void
	constructor(transport: Transport, readonly cwd: string, opts?: { id?: string; onClose?: () => void }) {
		this.id = opts?.id ?? "remote"
		this.onClose = opts?.onClose
		this.peer = new RpcPeer(transport)
	}

	readFile(p: string): Promise<string> { return this.peer.request(RPC_METHODS.readFile, { path: p }) }
	writeFile(p: string, content: string): Promise<void> { return this.peer.request(RPC_METHODS.writeFile, { path: p, content }) }
	exists(p: string): Promise<boolean> { return this.peer.request(RPC_METHODS.exists, { path: p }) }
	stat(p: string): Promise<EnvStat> { return this.peer.request(RPC_METHODS.stat, { path: p }) }
	list(p: string, o?: { recursive?: boolean }): Promise<DirEntry[]> { return this.peer.request(RPC_METHODS.list, { path: p, opts: o }) }
	mkdir(p: string, o?: { recursive?: boolean }): Promise<void> { return this.peer.request(RPC_METHODS.mkdir, { path: p, opts: o }) }
	delete(p: string, o?: { recursive?: boolean }): Promise<void> { return this.peer.request(RPC_METHODS.delete, { path: p, opts: o }) }
	rename(from: string, to: string): Promise<void> { return this.peer.request(RPC_METHODS.rename, { from, to }) }
	listFilesNative(p: string, recursive: boolean, limit: number): Promise<[FileInfo[], boolean]> {
		return this.peer.request(RPC_METHODS.listFilesNative, { path: p, recursive, limit })
	}
	searchFormatted(directoryPath: string, regex: string, opts?: SearchOpts & { taskId?: string; cwd?: string }): Promise<string> {
		// isaacIgnoreController is intentionally NOT serialized; the daemon applies ignore locally.
		const o: any = opts ?? {}
		return this.peer.request(RPC_METHODS.searchFormatted, {
			directoryPath, regex,
			opts: { filePattern: o.filePattern, glob: o.glob, contextLines: o.contextLines, excludeFilePatterns: o.excludeFilePatterns, cwd: o.cwd, taskId: o.taskId },
		})
	}

	runCommand: CommandRunner = (command, timeoutSeconds, opts) => {
		this.peer.onNotify(NOTIFY.output, (params: any) => {
			if (params?.stream === "stdout") opts?.onOutputLine?.(params.chunk)
		})
		return this.peer
			.request(RPC_METHODS.runCommand, {
				command, timeoutSeconds,
				opts: { useBackgroundExecution: opts?.useBackgroundExecution, suppressUserInteraction: opts?.suppressUserInteraction },
			})
			.then((r) => r as [boolean, any])
	}

	exec(_cmd: string, _opts?: ExecOpts): ExecHandle {
		// No in-tree consumer in #2 MVP (agent uses runCommand). Streaming exec over
		// the wire is a #2.x addition; throw rather than ship a half-streaming handle.
		throw new Error("RemoteEnvironment.exec is not implemented in #2 MVP; use runCommand")
	}

	async dispose(): Promise<void> {
		try { await this.peer.request(RPC_METHODS.dispose, {}) } catch {}
		this.peer.dispose()
		this.onClose?.()
	}
}
```

- [ ] **Step 2: Type-check + commit**

Run: `npm run check-types` → PASS.
```bash
git add src/services/environment/remote/RemoteEnvironment.ts
git commit -m "feat(env): RemoteEnvironment client over RpcPeer"
```

---

## Task 5: Conformance — RemoteEnvironment ↔ in-process daemon

**Files:** Create `src/services/environment/remote/__tests__/RemoteEnvironment.test.ts`.

- [ ] **Step 1: Wire the #1 conformance suite through the protocol**

```ts
// src/services/environment/remote/__tests__/RemoteEnvironment.test.ts
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe } from "mocha"
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
})
```

- [ ] **Step 2: Run conformance**

Run: `npx cross-env TS_NODE_PROJECT=./tsconfig.unit-test.json mocha src/services/environment/remote/__tests__/RemoteEnvironment.test.ts`
Expected: PASS — same write/read/exists/stat/delete + list + missing-read assertions, now over JSON-RPC. Debug serialization until green (core equivalence proof).

- [ ] **Step 3: Commit**

```bash
git add src/services/environment/remote/__tests__/RemoteEnvironment.test.ts
git commit -m "test(env): RemoteEnvironment passes #1 conformance"
```

---

## Task 6: Streaming + error-mapping tests

**Files:** Extend `__tests__/RemoteEnvironment.test.ts`.

- [ ] **Step 1: Add streaming + error tests**

```ts
import { strict as assert } from "node:assert"
import { it } from "mocha"

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
```

- [ ] **Step 2: Run + commit**

Run: `npx cross-env TS_NODE_PROJECT=./tsconfig.unit-test.json mocha src/services/environment/remote/__tests__/RemoteEnvironment.test.ts` → PASS.
```bash
git add src/services/environment/remote/__tests__/RemoteEnvironment.test.ts
git commit -m "test(env): RemoteEnvironment streaming + error-code mapping"
```

---

## Task 7: Daemon bundle + resolveEnvironment branch + subprocess integration

**Files:** Modify `esbuild.mjs`, `src/services/environment/resolveEnvironment.ts`, `src/services/environment/index.ts`; Create `__tests__/daemon.integration.test.ts`.

- [ ] **Step 1: Add the daemon esbuild target**

In `esbuild.mjs`, add a build config mirroring `extensionConfig` for entry `src/services/environment/remote/daemon.ts` → `${destDir}/lisael-daemon.js`, `platform: "node"`, `format: "cjs"`, `bundle: true`, `external: ["better-sqlite3", "onnxruntime-node", "web-tree-sitter"]`. Register it in the array of builds the main build runs.

- [ ] **Step 2: resolve branch + exports**

`src/services/environment/resolveEnvironment.ts`:
```ts
import { spawn } from "node:child_process"
import path from "node:path"
import { LocalEnvironment } from "./LocalEnvironment"
import { RemoteEnvironment } from "./remote/RemoteEnvironment"
import { subprocessTransport } from "./remote/transport"
import type { CommandRunner, Environment } from "./types"

export interface ResolveEnvironmentOptions { cwd: string; commandRunner?: CommandRunner }

export function resolveEnvironment(opts: ResolveEnvironmentOptions): Environment {
	if (process.env.ISAAC_ENV === "remote-local") {
		const daemonPath = path.join(__dirname, "lisael-daemon.js")
		const child = spawn("node", [daemonPath, opts.cwd]) as any
		return new RemoteEnvironment(subprocessTransport(child), opts.cwd, { onClose: () => child.kill() })
	}
	return new LocalEnvironment(opts.cwd, opts.commandRunner)
}
```
`src/services/environment/index.ts`: add `export { RemoteEnvironment } from "./remote/RemoteEnvironment"` and `export { inProcessTransportPair, subprocessTransport } from "./remote/transport"`.

> Confirm `__dirname` resolves to the bundle dir (esbuild cjs). If the packaged daemon path differs, compute it relative to the dist root used by the `.wasm` copy logic already in `esbuild.mjs`.

- [ ] **Step 3: Subprocess integration test (smoke, env-gated)**

```ts
// src/services/environment/remote/__tests__/daemon.integration.test.ts
import { spawn } from "node:child_process"
import { strict as assert } from "node:assert"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, it } from "mocha"
import { RemoteEnvironment } from "../RemoteEnvironment"
import { subprocessTransport } from "../transport"

const RUN = process.env.ISAAC_E2E_DAEMON === "1"
;(RUN ? describe : describe.skip)("daemon subprocess integration", () => {
	it("runs file ops against a spawned daemon", async function () {
		this.timeout(30_000)
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "isaac-daemon-int-"))
		const child = spawn("npx", ["tsx", path.resolve("src/services/environment/remote/daemon.ts"), dir]) as any
		const env = new RemoteEnvironment(subprocessTransport(child), dir)
		await env.writeFile("hi.txt", "REMOTE_OK")
		assert.equal(await env.readFile("hi.txt"), "REMOTE_OK")
		await env.dispose()
	})
})
```
> Default-skipped (opt-in via `ISAAC_E2E_DAEMON=1`) so the unit gate stays fast/hermetic; in-process conformance is the protocol proof.

- [ ] **Step 4: Run gates + commit**

```bash
npm run check-types && npm run lint
npx cross-env TS_NODE_PROJECT=./tsconfig.unit-test.json mocha "src/services/environment/remote/__tests__/*.test.ts"
```
Expected: PASS.
```bash
git add esbuild.mjs src/services/environment/resolveEnvironment.ts src/services/environment/index.ts src/services/environment/remote/__tests__/daemon.integration.test.ts
git commit -m "feat(env): daemon bundle + resolveEnvironment remote branch"
```

---

## Task 8: Final verification + PR

- [ ] **Step 1: Full gate matrix**

```bash
npm run test:unit
npm run check-types
npm run lint
```
Expected: all PASS; existing suites unchanged (default `LocalEnvironment`), new remote tests green.

- [ ] **Step 2: Confirm remote is opt-in only**

Run: `rg -n "ISAAC_ENV" src/services/environment/resolveEnvironment.ts` — without `ISAAC_ENV=remote-local`, `LocalEnvironment` is returned.

- [ ] **Step 3: Push + PR**

```bash
git push -u origin feat/lisael-remote
```
Open PR `feat/lisael-remote → master`, title `feat: LISAEL RemoteEnvironment + daemon (#2)`. (If pushing via Gitea HTTPS token, scrub it from `.git/config` after.)

---

## Self-Review

- **Spec coverage:** protocol+framing+errors (T1) ✓; transports + RpcPeer (T2) ✓; daemon→LocalEnvironment (T3) ✓; RemoteEnvironment client (T4) ✓; conformance equivalence (T5) ✓; streaming + error mapping (T6) ✓; bundle + resolve branch + subprocess integration (T7) ✓; opt-in/default-preserved (T8) ✓. **Deferred per spec §2/§8:** SSH/container/cloud, security, portable sessions, and `exec()` streaming (runCommand is the MVP path; `exec()` throws clearly).
- **Placeholder scan:** the daemon entry guard (T3) and bundle path (T7) carry explicit "confirm" notes naming the exact thing to verify — not vague TODOs. Every code step has real code.
- **Type consistency:** `RemoteEnvironment` implements every `Environment` method from #1 `types.ts`; `runCommand` matches `CommandRunner`; `searchFormatted` opts mirror #1 (drops non-serializable `isaacIgnoreController`); `RpcPeer.request/notify/onNotify` consistent client↔daemon; `toRpcError`/`fromRpcError` preserve `cause.code` (WriteToFile's unwrap path).
