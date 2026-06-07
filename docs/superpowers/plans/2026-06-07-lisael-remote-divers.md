# LISAEL Remote Divers — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** Two well-scoped follow-ups on the remote stack: (A) implement `RemoteEnvironment.exec()` streaming over the existing JSON-RPC protocol; (B) GC orphan remote workspaces in `SshRemoteSession`.

**Design (inline — mechanical, no brainstorm):**
- **(A) exec over the wire.** The protocol already has `env/output {streamId,stream,chunk}`, `env/stdin`, `env/kill`, `env/abort` and client-owned `streamId`. Add an `env/exec` daemon handler (spawn child, stream stdout/stderr via `env/output`, honor stdin/kill/abort by streamId, resolve `{exitCode}`). On the client, return an `ExecHandle` whose `stdout`/`stderr` are async-iterables draining queues fed by `env/output`; `writeStdin`/`kill` send notifications; `exitCode` resolves from the response. No in-tree consumer (interface completeness); tested via in-process transport.
- **(B) workspace GC.** Add `buildGcCommand(ttlDays)` → `find ~/.isaac/workspaces -mindepth 1 -maxdepth 1 -type d -mtime +<ttl> -exec rm -rf {} +`; call it best-effort (non-blocking, catch) inside `SshRemoteSession` init before seeding.

**Branch:** `feat/lisael-remote-divers` (off `6ad3378`). **Gates:** `npm run test:unit` · `npm run check-types` · `npm run lint`. Core tests via `npx cross-env TS_NODE_PROJECT=./tsconfig.unit-test.json mocha "<glob>"`.

**Shell:** `export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 22 >/dev/null; cd /Users/claude2/isaac-cli`

---

## Task 1: Daemon `env/exec` handler (streaming)

**Files:** Modify `src/services/environment/remote/daemon.ts`.

- [ ] **Step 1: Confirm current state**

Run: `rg -n "RPC_METHODS|env/exec|NOTIFY|streamId|onNotify" src/services/environment/remote/daemon.ts src/services/environment/remote/protocol.ts`
Confirm `RPC_METHODS.exec` exists in `protocol.ts` (add `exec: "env/exec"` if missing); confirm the daemon has NO `env/exec` handler yet and how the existing `runCommand` streaming + any `env/abort` handling is wired.

- [ ] **Step 2: Add the `env/exec` handler + stdin/kill/abort notifications**

In `createDaemonServer`, add a `const execChildren = new Map<string, import("node:child_process").ChildProcess>()` and the handler:
```ts
[RPC_METHODS.exec]: (p) =>
	new Promise<{ exitCode: number }>((resolve) => {
		const streamId: string = p.streamId
		const child = spawn(p.cmd, { shell: true, cwd: p.cwd })
		execChildren.set(streamId, child)
		child.stdout.on("data", (d: Buffer) => peer.notify(NOTIFY.output, { streamId, stream: "stdout", chunk: d.toString("utf8") }))
		child.stderr.on("data", (d: Buffer) => peer.notify(NOTIFY.output, { streamId, stream: "stderr", chunk: d.toString("utf8") }))
		child.on("close", (code, signal) => { execChildren.delete(streamId); resolve({ exitCode: code ?? (signal ? 1 : 0) }) })
	}),
```
Register notification handlers (via `peer.onNotify`, after `peer` is constructed): `NOTIFY.stdin` → `execChildren.get(p.streamId)?.stdin?.write(p.data)`; `NOTIFY.kill` → `execChildren.get(p.streamId)?.kill(p.signal)`; `NOTIFY.abort` → `execChildren.get(p.streamId)?.kill()`. (If an `env/abort` handler already exists for runCommand, extend it to also check `execChildren`.) Ensure `spawn` is imported.

- [ ] **Step 3: Type-check + commit**

Run: `npm run check-types` → 0.
```bash
git add src/services/environment/remote/daemon.ts
git commit -m "feat(env): daemon env/exec streaming handler"
```

---

## Task 2: Client `RemoteEnvironment.exec` (ExecHandle reconstruction)

**Files:** Modify `src/services/environment/remote/RemoteEnvironment.ts`; add `src/services/environment/remote/asyncQueue.ts`; Test `__tests__/RemoteEnvironment.test.ts`.

- [ ] **Step 1: Failing test (in-process exec end-to-end)**

Append to `RemoteEnvironment.test.ts`:
```ts
it("exec streams stdout and resolves exitCode over the wire", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "isaac-remote-exec-"))
	const [clientT, serverT] = inProcessTransportPair()
	createDaemonServer(serverT, dir)
	const env = new RemoteEnvironment(clientT, dir)
	const h = env.exec("echo hello")
	let out = ""
	for await (const c of h.stdout) out += c
	assert.equal(await h.exitCode, 0)
	assert.match(out, /hello/)
	await env.dispose()
})
```

- [ ] **Step 2: Add a tiny `AsyncQueue`**

```ts
// src/services/environment/remote/asyncQueue.ts
export class AsyncQueue<T> implements AsyncIterable<T> {
	private items: T[] = []
	private resolvers: Array<(r: IteratorResult<T>) => void> = []
	private closed = false
	push(item: T): void {
		const r = this.resolvers.shift()
		if (r) r({ value: item, done: false })
		else this.items.push(item)
	}
	close(): void {
		this.closed = true
		for (const r of this.resolvers.splice(0)) r({ value: undefined as any, done: true })
	}
	[Symbol.asyncIterator](): AsyncIterator<T> {
		return {
			next: () =>
				new Promise<IteratorResult<T>>((resolve) => {
					if (this.items.length) resolve({ value: this.items.shift()!, done: false })
					else if (this.closed) resolve({ value: undefined as any, done: true })
					else this.resolvers.push(resolve)
				}),
		}
	}
}
```

- [ ] **Step 3: Adjust `outputSinks` signature + implement `exec`**

Change `outputSinks` to `Map<string, (chunk: string, stream: string) => void>`; the constructor's `NOTIFY.output` handler calls `sink(params.chunk, params.stream)`. `runCommand`'s sink becomes `(chunk, stream) => { if (stream === "stdout") opts?.onOutputLine?.(chunk) }`. Replace the throwing `exec()`:
```ts
exec(cmd: string, opts?: ExecOpts): ExecHandle {
	const streamId = `e${++this.streamCounter}`
	const stdoutQ = new AsyncQueue<string>()
	const stderrQ = new AsyncQueue<string>()
	this.outputSinks.set(streamId, (chunk, stream) => (stream === "stderr" ? stderrQ : stdoutQ).push(chunk))
	if (opts?.abortSignal) opts.abortSignal.addEventListener("abort", () => this.peer.notify(NOTIFY.abort, { streamId }), { once: true })
	const exitCode = this.peer
		.request(RPC_METHODS.exec, { cmd, cwd: opts?.cwd, streamId })
		.then((r: any) => r.exitCode as number)
		.finally(() => { this.outputSinks.delete(streamId); stdoutQ.close(); stderrQ.close() })
	return {
		stdout: stdoutQ,
		stderr: stderrQ,
		writeStdin: (d: string) => this.peer.notify(NOTIFY.stdin, { streamId, data: d }),
		kill: (signal?: NodeJS.Signals) => this.peer.notify(NOTIFY.kill, { streamId, signal }),
		exitCode,
	}
}
```
Ensure `streamCounter` exists (it does, from runCommand). Import `AsyncQueue` + `ExecHandle`/`ExecOpts`.

- [ ] **Step 4: Run + commit**

Run: `npx cross-env TS_NODE_PROJECT=./tsconfig.unit-test.json mocha "src/services/environment/remote/__tests__/*.test.ts"` → PASS (conformance + runCommand + exec; runCommand still streams correctly after the sink-signature change).
```bash
git add src/services/environment/remote/RemoteEnvironment.ts src/services/environment/remote/asyncQueue.ts src/services/environment/remote/__tests__/RemoteEnvironment.test.ts
git commit -m "feat(env): RemoteEnvironment.exec over the wire"
```

---

## Task 3: Orphan workspace GC in `SshRemoteSession`

**Files:** Modify `src/services/environment/remote/ssh/sync.ts`, `SshRemoteSession.ts`; Test `ssh/__tests__/sync.test.ts` + `SshRemoteSession.test.ts`.

- [ ] **Step 1: Failing test for `buildGcCommand`**

In `ssh/__tests__/sync.test.ts`:
```ts
import { buildGcCommand } from "../sync"
it("buildGcCommand removes workspace dirs older than ttl", () => {
	const cmd = buildGcCommand(7)
	assert.match(cmd, /find ~\/\.isaac\/workspaces/)
	assert.match(cmd, /-mtime \+7/)
	assert.match(cmd, /rm -rf/)
})
```

- [ ] **Step 2: Implement `buildGcCommand` + call best-effort in init**

In `sync.ts`:
```ts
export function buildGcCommand(ttlDays: number): string {
	return `find ~/.isaac/workspaces -mindepth 1 -maxdepth 1 -type d -mtime +${ttlDays} -exec rm -rf {} +`
}
```
In `SshRemoteSession`: add `gc` to `SshRemoteHooks` (default `() => runSsh(host, buildGcCommand(7))`), and in `init()` call it **before** `bootstrap()`/`push()` wrapped in try/catch (`try { await this.hooks.gc() } catch {}`) so GC never blocks the session.

- [ ] **Step 3: Update the injected-hooks test**

In `SshRemoteSession.test.ts`, add `gc: async () => { calls.push("gc") }` to the hooks and assert init order begins `["gc","bootstrap","push", ...]`.

- [ ] **Step 4: Run + commit**

Run: `npx cross-env TS_NODE_PROJECT=./tsconfig.unit-test.json mocha "src/services/environment/remote/ssh/__tests__/*.test.ts"` → PASS.
```bash
git add src/services/environment/remote/ssh/sync.ts src/services/environment/remote/ssh/SshRemoteSession.ts src/services/environment/remote/ssh/__tests__/
git commit -m "feat(env): GC orphan remote workspaces"
```

---

## Task 4: Final gates + PR

- [ ] **Step 1: Full gates**

```bash
npm run test:unit
npm run check-types
npm run lint
node esbuild.mjs
```
Expected: all PASS; default path unchanged; `dist/lisael-daemon.js` rebuilds.

- [ ] **Step 2: Push + PR**

```bash
git push -u origin feat/lisael-remote-divers
```
Open PR `feat/lisael-remote-divers → master`, title `feat: LISAEL remote exec + workspace GC`. (Scrub token after a tokened HTTPS push.)

---

## Self-Review

- **Coverage:** daemon env/exec (T1) ✓; client ExecHandle + AsyncQueue (T2) ✓; workspace GC (T3) ✓; gates+PR (T4) ✓.
- **Placeholder scan:** T1 has a "confirm current state" step (RPC_METHODS.exec presence, existing abort wiring) — named, not vague. `AsyncQueue` is fully specified.
- **Type consistency:** `exec` returns `ExecHandle` from `types.ts`; `outputSinks` signature change kept compatible with `runCommand` (sink now `(chunk, stream)`); `buildGcCommand`/`gc` typed into `SshRemoteHooks`.
- **Risk:** `exec` has no in-tree consumer — implemented for completeness + tested in-process; the `outputSinks` signature change must keep `runCommand` green (covered by existing streaming test). GC is best-effort (try/catch, never blocks).
