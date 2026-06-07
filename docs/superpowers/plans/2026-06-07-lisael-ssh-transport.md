# LISAEL SSH transport + workspace sync — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Run the agent's tool I/O on MacStudio over SSH by reusing #2's `RemoteEnvironment` over an `ssh`-spawned transport, with rsync workspace sync (seed push → live work → pull-back) and per-session daemon bootstrap.

**Architecture:** A thin layer over #2. `sshTransport` = `subprocessTransport(spawn("ssh", [host,"node",daemon,cwd]))`. `SshRemoteSession` wraps a `RemoteEnvironment`, lazily running bootstrap+seed on first op (keeps `resolveEnvironment` synchronous) and pull-back+cleanup on `dispose()`. Sync via pure rsync arg-builders + an executor. Opt-in `ISAAC_ENV=ssh:<host>`; default `LocalEnvironment` unchanged.

**Tech Stack:** TypeScript strict, Node `child_process` (ssh/rsync), mocha + `node:assert/strict`, the #2 protocol/transport/RemoteEnvironment.

**Spec:** `docs/superpowers/specs/2026-06-07-lisael-ssh-transport-design.md`
**Branch:** `feat/lisael-ssh` (off #2 tip `f7b0598`)

**Gates:** `npm run test:unit` · `npm run check-types` · `npm run lint`. Core tests: `npx cross-env TS_NODE_PROJECT=./tsconfig.unit-test.json mocha "<glob>"`.

**Shell setup:**
```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 22 >/dev/null; cd /Users/claude2/isaac-cli
```

**Reference (from #2, do not change):** `subprocessTransport(child: ChildProcessWithoutNullStreams): Transport` and `RemoteEnvironment(transport, cwd, opts?: { id?; onClose? })` in `src/services/environment/remote/`; `Environment` interface in `src/services/environment/types.ts`.

---

## File Structure

**Created** (under `src/services/environment/remote/ssh/`): `sync.ts`, `sshTransport.ts`, `SshRemoteSession.ts`, `__tests__/sync.test.ts`, `__tests__/SshRemoteSession.test.ts`, `__tests__/ssh.integration.test.ts`.
**Modified:** `src/services/environment/resolveEnvironment.ts` (ssh branch), `src/services/environment/index.ts` (exports).

---

## Task 1: rsync/ssh arg-builders + executor (`sync.ts`)

**Files:** Create `src/services/environment/remote/ssh/sync.ts`; Test `src/services/environment/remote/ssh/__tests__/sync.test.ts`.

- [ ] **Step 1: Failing tests for the arg-builders**

```ts
// src/services/environment/remote/ssh/__tests__/sync.test.ts
import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import { buildBootstrap, buildRsyncPull, buildRsyncPush, DEFAULT_EXCLUDES } from "../sync"

describe("ssh sync arg builders", () => {
	it("push: rsync -az --delete -e ssh with excludes and trailing slashes", () => {
		const args = buildRsyncPush("studio", "/local/wd", "~/.isaac/workspaces/w1", DEFAULT_EXCLUDES)
		assert.ok(args.includes("-az") && args.includes("--delete"))
		assert.equal(args[args.indexOf("-e") + 1], "ssh")
		assert.ok(args.some((a) => a === "--exclude=.git"))
		assert.equal(args.at(-2), "/local/wd/")
		assert.equal(args.at(-1), "studio:~/.isaac/workspaces/w1/")
	})
	it("pull: remote -> local (no --delete by default)", () => {
		const args = buildRsyncPull("studio", "~/.isaac/workspaces/w1", "/local/wd", DEFAULT_EXCLUDES)
		assert.equal(args.at(-2), "studio:~/.isaac/workspaces/w1/")
		assert.equal(args.at(-1), "/local/wd/")
		assert.ok(!args.includes("--delete"))
	})
	it("bootstrap: copies a single file to the remote path", () => {
		const args = buildBootstrap("studio", "/repo/dist/lisael-daemon.js", "~/.isaac/lisael-daemon.js")
		assert.equal(args.at(-2), "/repo/dist/lisael-daemon.js")
		assert.equal(args.at(-1), "studio:~/.isaac/lisael-daemon.js")
	})
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx cross-env TS_NODE_PROJECT=./tsconfig.unit-test.json mocha src/services/environment/remote/ssh/__tests__/sync.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `sync.ts`**

```ts
// src/services/environment/remote/ssh/sync.ts
import { spawn } from "node:child_process"

export const DEFAULT_EXCLUDES = [".git", "node_modules", "dist", "build", ".isaac", ".ailiance-agent", "*.vsix"]

function excludeArgs(excludes: string[]): string[] {
	return excludes.map((e) => `--exclude=${e}`)
}

/** rsync local dir -> remote dir (seed). Trailing slashes sync contents. */
export function buildRsyncPush(host: string, localDir: string, remoteDir: string, excludes: string[]): string[] {
	return ["-az", "--delete", "-e", "ssh", ...excludeArgs(excludes), `${localDir}/`, `${host}:${remoteDir}/`]
}

/** rsync remote dir -> local dir (pull back). No --delete (remote authoritative for content, not deletions). */
export function buildRsyncPull(host: string, remoteDir: string, localDir: string, excludes: string[]): string[] {
	return ["-az", "-e", "ssh", ...excludeArgs(excludes), `${host}:${remoteDir}/`, `${localDir}/`]
}

/** rsync a single file (the daemon bundle) to a remote path. */
export function buildBootstrap(host: string, localFile: string, remotePath: string): string[] {
	return ["-az", "-e", "ssh", localFile, `${host}:${remotePath}`]
}

export function runRsync(args: string[]): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn("rsync", args)
		let stderr = ""
		child.stderr.on("data", (d: Buffer) => { stderr += d.toString("utf8") })
		child.on("error", reject)
		child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`rsync exited ${code}: ${stderr}`))))
	})
}

export function runSsh(host: string, command: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn("ssh", [host, command])
		child.on("error", reject)
		child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ssh ${host} exited ${code}`))))
	})
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx cross-env TS_NODE_PROJECT=./tsconfig.unit-test.json mocha src/services/environment/remote/ssh/__tests__/sync.test.ts`
Expected: PASS (3 passing).

- [ ] **Step 5: Commit**

```bash
git add src/services/environment/remote/ssh/sync.ts src/services/environment/remote/ssh/__tests__/sync.test.ts
git commit -m "feat(env): ssh rsync arg-builders + executor"
```

---

## Task 2: `sshTransport`

**Files:** Create `src/services/environment/remote/ssh/sshTransport.ts`.

- [ ] **Step 1: Implement (reuses #2's subprocessTransport)**

```ts
// src/services/environment/remote/ssh/sshTransport.ts
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process"
import { subprocessTransport, type Transport } from "../transport"

/** Spawns `ssh <host> node <remoteDaemonPath> <remoteCwd>` and frames JSON-RPC over its stdio. */
export function sshTransport(host: string, remoteDaemonPath: string, remoteCwd: string): Transport {
	const child = spawn("ssh", [host, "node", remoteDaemonPath, remoteCwd]) as ChildProcessWithoutNullStreams
	return subprocessTransport(child)
}
```

- [ ] **Step 2: Type-check + commit**

Run: `npm run check-types` → PASS.
```bash
git add src/services/environment/remote/ssh/sshTransport.ts
git commit -m "feat(env): sshTransport over subprocessTransport"
```

---

## Task 3: `SshRemoteSession` (lazy bootstrap+seed, pull-back on dispose)

**Files:** Create `src/services/environment/remote/ssh/SshRemoteSession.ts`; Test `src/services/environment/remote/ssh/__tests__/SshRemoteSession.test.ts`.

`SshRemoteSession.create()` returns synchronously (keeps `resolveEnvironment` sync). It kicks off `ready` (bootstrap+seed+transport+RemoteEnvironment) in the constructor; every op awaits `ready` then delegates. `dispose()` awaits `ready`, disposes the inner env, then pulls back + cleans up. Injectable hooks make it unit-testable without real ssh/rsync.

- [ ] **Step 1: Failing test (lazy init order, injected hooks)**

```ts
// src/services/environment/remote/ssh/__tests__/SshRemoteSession.test.ts
import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import { SshRemoteSession } from "../SshRemoteSession"

describe("SshRemoteSession", () => {
	it("bootstraps + seeds before the first op, pulls + cleans on dispose", async () => {
		const calls: string[] = []
		const env = SshRemoteSession.create("studio", "/local/wd", {
			bootstrap: async () => { calls.push("bootstrap") },
			push: async () => { calls.push("push") },
			pull: async () => { calls.push("pull") },
			cleanup: async () => { calls.push("cleanup") },
			makeEnv: () => ({
				id: "remote", cwd: "/remote/wd",
				readFile: async () => { calls.push("readFile"); return "data" },
				dispose: async () => { calls.push("env.dispose") },
			}) as any,
		})
		const data = await env.readFile("a.txt")
		assert.equal(data, "data")
		assert.deepEqual(calls, ["bootstrap", "push", "readFile"])
		await env.dispose()
		assert.deepEqual(calls.slice(-3), ["env.dispose", "pull", "cleanup"])
	})
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx cross-env TS_NODE_PROJECT=./tsconfig.unit-test.json mocha src/services/environment/remote/ssh/__tests__/SshRemoteSession.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `SshRemoteSession.ts`**

```ts
// src/services/environment/remote/ssh/SshRemoteSession.ts
import path from "node:path"
import type { DirEntry, Environment, EnvStat, ExecHandle, ExecOpts, FileInfo, SearchOpts } from "../../types"
import { RemoteEnvironment } from "../RemoteEnvironment"
import { buildBootstrap, buildRsyncPull, buildRsyncPush, DEFAULT_EXCLUDES, runRsync, runSsh } from "./sync"
import { sshTransport } from "./sshTransport"

const REMOTE_DAEMON = "~/.isaac/lisael-daemon.js"

export interface SshRemoteHooks {
	bootstrap: () => Promise<void>
	push: () => Promise<void>
	pull: () => Promise<void>
	cleanup: () => Promise<void>
	makeEnv: () => Environment
}

export class SshRemoteSession implements Environment {
	readonly id: string
	readonly cwd: string
	private env?: Environment
	private ready: Promise<void>
	private disposed = false

	private constructor(remoteCwd: string, private hooks: SshRemoteHooks) {
		this.id = "ssh"
		this.cwd = remoteCwd
		this.ready = this.init()
	}

	/** Synchronous factory: keeps resolveEnvironment sync; init runs lazily on first op. */
	static create(host: string, localCwd: string, hooksOverride?: Partial<SshRemoteHooks>): SshRemoteSession {
		const sessionId = `${process.pid}-${localCwd.replace(/[^a-zA-Z0-9]/g, "_")}`
		const remoteCwd = `~/.isaac/workspaces/${sessionId}`
		const localBundle = path.join(__dirname, "..", "..", "..", "..", "..", "dist", "lisael-daemon.js")
		const hooks: SshRemoteHooks = {
			bootstrap: () => runRsync(buildBootstrap(host, localBundle, REMOTE_DAEMON)),
			push: () => runRsync(buildRsyncPush(host, localCwd, remoteCwd, DEFAULT_EXCLUDES)),
			pull: () => runRsync(buildRsyncPull(host, remoteCwd, localCwd, DEFAULT_EXCLUDES)),
			cleanup: () => runSsh(host, `rm -rf ${remoteCwd}`),
			makeEnv: () => new RemoteEnvironment(sshTransport(host, REMOTE_DAEMON, remoteCwd), remoteCwd, { id: `ssh:${host}` }),
			...hooksOverride,
		}
		return new SshRemoteSession(remoteCwd, hooks)
	}

	private async init(): Promise<void> {
		await this.hooks.bootstrap()
		await this.hooks.push()
		this.env = this.hooks.makeEnv()
	}

	private async use(): Promise<Environment> {
		await this.ready
		if (!this.env) throw new Error("ssh session not initialized")
		return this.env
	}

	async readFile(p: string): Promise<string> { return (await this.use()).readFile(p) }
	async writeFile(p: string, c: string): Promise<void> { return (await this.use()).writeFile(p, c) }
	async exists(p: string): Promise<boolean> { return (await this.use()).exists(p) }
	async stat(p: string): Promise<EnvStat> { return (await this.use()).stat(p) }
	async list(p: string, o?: { recursive?: boolean }): Promise<DirEntry[]> { return (await this.use()).list(p, o) }
	async mkdir(p: string, o?: { recursive?: boolean }): Promise<void> { return (await this.use()).mkdir(p, o) }
	async delete(p: string, o?: { recursive?: boolean }): Promise<void> { return (await this.use()).delete(p, o) }
	async rename(a: string, b: string): Promise<void> { return (await this.use()).rename(a, b) }
	async listFilesNative(p: string, r: boolean, l: number, s?: AbortSignal): Promise<[FileInfo[], boolean]> { return (await this.use()).listFilesNative(p, r, l, s) }
	async searchFormatted(d: string, re: string, o?: SearchOpts & { taskId?: string; cwd?: string }): Promise<string> { return (await this.use()).searchFormatted(d, re, o) }
	runCommand: Environment["runCommand"] = async (command, timeoutSeconds, opts) => (await this.use()).runCommand(command, timeoutSeconds, opts)
	exec(_cmd: string, _opts?: ExecOpts): ExecHandle { throw new Error("SshRemoteSession.exec not supported; use runCommand") }

	async dispose(): Promise<void> {
		if (this.disposed) return
		this.disposed = true
		try { await this.ready } catch {}
		try { await this.env?.dispose() } catch {}
		try { await this.hooks.pull() } catch {}
		try { await this.hooks.cleanup() } catch {}
	}
}
```

> `exec()` throws (mirrors #2 MVP); `runCommand` is the agent path. The unit test injects `makeEnv`/hooks, so it does not depend on the real `localBundle` path — confirm that path against the bundled/ts-node layout when wiring the real run (Task 4 integration).

- [ ] **Step 4: Run to verify it passes**

Run: `npx cross-env TS_NODE_PROJECT=./tsconfig.unit-test.json mocha src/services/environment/remote/ssh/__tests__/SshRemoteSession.test.ts`
Expected: PASS — init order `["bootstrap","push","readFile"]`; dispose tail `["env.dispose","pull","cleanup"]`.

- [ ] **Step 5: Commit**

```bash
git add src/services/environment/remote/ssh/SshRemoteSession.ts src/services/environment/remote/ssh/__tests__/SshRemoteSession.test.ts
git commit -m "feat(env): SshRemoteSession lazy seed + pull on dispose"
```

---

## Task 4: resolveEnvironment ssh branch + exports + env-gated integration

**Files:** Modify `src/services/environment/resolveEnvironment.ts`, `src/services/environment/index.ts`; Create `src/services/environment/remote/ssh/__tests__/ssh.integration.test.ts`.

- [ ] **Step 1: Add the `ssh:<host>` branch**

In `resolveEnvironment.ts`, add (before the existing `remote-local` branch):
```ts
import { SshRemoteSession } from "./remote/ssh/SshRemoteSession"
// ... inside resolveEnvironment, after reading process.env.ISAAC_ENV:
	const isaacEnv = process.env.ISAAC_ENV
	if (isaacEnv?.startsWith("ssh:")) {
		return SshRemoteSession.create(isaacEnv.slice("ssh:".length), opts.cwd)
	}
```
Keep the `remote-local` branch and the default `LocalEnvironment` return unchanged.

- [ ] **Step 2: Exports**

`src/services/environment/index.ts`: add `export { SshRemoteSession } from "./remote/ssh/SshRemoteSession"` and `export { sshTransport } from "./remote/ssh/sshTransport"`.

- [ ] **Step 3: Env-gated SSH integration test**

```ts
// src/services/environment/remote/ssh/__tests__/ssh.integration.test.ts
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
```
> Default-skipped; opt-in via `ISAAC_E2E_SSH=studio` on a machine with working `ssh studio` + the daemon built (`node esbuild.mjs`). Requires `rsync` + `ssh` on PATH.

- [ ] **Step 4: Gates + commit**

```bash
npm run check-types && npm run lint
npx cross-env TS_NODE_PROJECT=./tsconfig.unit-test.json mocha "src/services/environment/remote/ssh/__tests__/*.test.ts"
npm run test:unit
```
Expected: PASS (unit + arg-builders + SshRemoteSession; integration skipped; default path unchanged).
```bash
git add src/services/environment/resolveEnvironment.ts src/services/environment/index.ts src/services/environment/remote/ssh/__tests__/ssh.integration.test.ts
git commit -m "feat(env): resolveEnvironment ssh branch + exports"
```

---

## Task 5: Final verification + PR

- [ ] **Step 1: Full gate matrix**

```bash
npm run test:unit
npm run check-types
npm run lint
node esbuild.mjs   # daemon bundle still builds (used by ssh bootstrap)
```
Expected: all PASS; default `LocalEnvironment` unchanged.

- [ ] **Step 2: Confirm opt-in only**

Run: `rg -n "ISAAC_ENV" src/services/environment/resolveEnvironment.ts` — `ssh:`/`remote-local` opt-in; default returns `LocalEnvironment`.

- [ ] **Step 3: Push + PR**

```bash
git push -u origin feat/lisael-ssh
```
Open PR `feat/lisael-ssh → master`, title `feat: LISAEL SSH transport + sync (#2.x)`. (Scrub token from `.git/config` after a tokened HTTPS push.)

---

## Self-Review

- **Spec coverage:** arg-builders + executor (T1) ✓; sshTransport reusing #2 (T2) ✓; SshRemoteSession lazy-init + pull-on-dispose (T3) ✓; resolveEnvironment ssh branch + exports + gated integration (T4) ✓; final gates + PR (T5) ✓. **Deferred per spec §2/§8:** conflict resolution, watch-sync, generic hosts, `.gitignore`-aware excludes, `exec()` streaming.
- **Placeholder scan:** `localBundle` path (T3) and remote `node` PATH carry explicit confirm notes; unit tests inject hooks so they don't depend on the real path/SSH. No vague TODOs.
- **Type consistency:** `SshRemoteSession implements Environment` (every method delegates via `use()`); `runCommand` matches `Environment["runCommand"]`; reuses `subprocessTransport`/`RemoteEnvironment` from #2; `resolveEnvironment` stays synchronous (lazy init resolves the spec's async-seam open question).
