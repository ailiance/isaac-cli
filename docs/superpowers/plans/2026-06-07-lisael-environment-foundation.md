# LISAEL Environment Foundation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce an `Environment` interface that abstracts tool-handler I/O (files, shell, search) behind a single contract, with a `LocalEnvironment` that reproduces current behavior 1:1, so the agent's "hands" become environment-pluggable without changing the local brain.

**Architecture:** Remote-hands / local-brain. A new `Environment` interface lives in `src/services/environment/`. `LocalEnvironment` wraps today's `fs` / ripgrep / command-executor / glob calls verbatim. The instance is created in `TaskFactory.buildTaskManagers` via `resolveEnvironment()`, passed to `ToolExecutor`, and exposed to handlers as `config.environment` (a new field on `TaskConfig`). Handlers stop importing `node:fs` and call `config.environment.*`. Migration is incremental, one consumer group per task, with the existing suites proving behavior preservation.

**Tech Stack:** TypeScript (strict), Node `fs`/`child_process`, ripgrep (`@vscode/ripgrep`), mocha + `node:assert/strict` + sinon (core tests), vitest (cli/mcp). Build: esbuild. Lint: biome.

**Spec:** `docs/superpowers/specs/2026-06-07-lisael-environment-foundation-design.md`

**Branch:** `feat/lisael-environment`

**Scope note (refines spec §5):** This plan migrates the primary I/O handlers — **read, write, edit, list_files, execute_command, search_files** — plus tree-sitter file reads. **Deferred out of #1** (noted but not done here): `CheckpointGitOperations` (uses `simple-git`, not raw spawn — only needed for remote in #2) and the symbol/LSP-coupled handlers (`ReplaceSymbol`, `RenameSymbol`, `FindSymbolReferences`, `DiagnosticsScan`, `GenerateExplanation`). They keep their current local `fs` calls; they will be migrated when #2 needs them remote.

**Gate commands (run from repo root unless noted):**
- `npm run test:unit` (mocha core + mcp vitest)
- `cd cli && CI=1 npm test` (cli vitest) — only when cli code changes
- `npm run check-types` (covers root + webview + cli `tsc --noEmit`)
- `npm run lint` (biome + proto lint)

**Environment setup for every shell:**
```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 22 >/dev/null; cd /Users/claude2/isaac-cli
```

---

## File Structure

**Created:**
- `src/services/environment/types.ts` — the `Environment` interface + supporting types (`EnvStat`, `DirEntry`, `Match`, `SearchOpts`, `ExecOpts`, `ExecHandle`, `EnvironmentError`).
- `src/services/environment/LocalEnvironment.ts` — local impl (fs / glob / ripgrep / command-executor backed).
- `src/services/environment/InMemoryEnvironment.ts` — test impl (in-memory FS; `exec`/`search` minimal).
- `src/services/environment/resolveEnvironment.ts` — selection seam (returns `LocalEnvironment` for #1).
- `src/services/environment/index.ts` — barrel re-export.
- `src/services/environment/__tests__/conformance.ts` — shared conformance assertions (a function, not a test file).
- `src/services/environment/__tests__/LocalEnvironment.test.ts`
- `src/services/environment/__tests__/InMemoryEnvironment.test.ts`

**Modified:**
- `src/core/task/tools/types/TaskConfig.ts` — add `environment: Environment` field.
- `src/core/task/ToolExecutor.ts` — new constructor param `environment`; set `config.environment` in `asToolConfig()`.
- `src/core/task/TaskFactory.ts` — `resolveEnvironment()` call; pass to `new ToolExecutor(...)`.
- `src/core/task/tools/handlers/ReadFileToolHandler.ts` — `fs.stat` → `config.environment.stat`.
- `src/core/task/tools/handlers/WriteToFileToolHandler.ts` — `fs.stat`/`fs.access` → `config.environment.*`.
- `src/core/task/tools/handlers/edit-file/BatchProcessor.ts` — `fs.readFile` → `config.environment.readFile`.
- `src/core/task/tools/handlers/ListFilesToolHandler.ts` — `listFiles(...)` → `config.environment.listFilesNative(...)`.
- `src/core/task/tools/handlers/SearchFilesToolHandler.ts` — `regexSearchFiles(...)` → `config.environment.searchFormatted(...)`.
- `src/core/task/tools/handlers/ExecuteCommandToolHandler.ts` — route through `config.environment.runCommand` (wrapping the existing `executeCommandTool` callback).
- `src/services/tree-sitter/index.ts` — `parseFile` accepts an optional injected `readFile`.
- `cli/tests/e2e/write-file.e2e.test.ts` — smoke that the default `LocalEnvironment` path still works end-to-end.

---

## Task 1: `Environment` interface + types

**Files:**
- Create: `src/services/environment/types.ts`
- Test: (none — type-only; verified by `check-types` in later tasks)

- [ ] **Step 1: Write the types module**

```ts
// src/services/environment/types.ts

export interface EnvStat {
	isDir: boolean
	size: number
	mtimeMs: number
}

export interface DirEntry {
	/** Path relative to the listed directory. */
	name: string
	isDir: boolean
}

export interface Match {
	/** Absolute path within the environment. */
	file: string
	line: number
	column: number
	text: string
}

export interface SearchOpts {
	/** Directory to search, relative to cwd (defaults to cwd). */
	path?: string
	/** ripgrep --glob filter, e.g. "*.ts". */
	glob?: string
	contextLines?: number
	abortSignal?: AbortSignal
}

export interface ExecOpts {
	/** Working directory relative to cwd (defaults to cwd). */
	cwd?: string
	timeoutSeconds?: number
	abortSignal?: AbortSignal
	env?: Record<string, string>
}

export interface ExecHandle {
	readonly stdout: AsyncIterable<string>
	readonly stderr: AsyncIterable<string>
	writeStdin(data: string): void
	kill(signal?: NodeJS.Signals): void
	readonly exitCode: Promise<number>
}

export class EnvironmentError extends Error {
	constructor(
		readonly op: string,
		readonly targetPath: string | undefined,
		readonly cause: unknown,
	) {
		super(`environment ${op} failed${targetPath ? ` for ${targetPath}` : ""}: ${String(cause)}`)
		this.name = "EnvironmentError"
	}
}

export interface Environment {
	readonly id: string
	readonly cwd: string

	readFile(path: string): Promise<string>
	writeFile(path: string, content: string): Promise<void>
	exists(path: string): Promise<boolean>
	stat(path: string): Promise<EnvStat>
	list(path: string, opts?: { recursive?: boolean }): Promise<DirEntry[]>
	mkdir(path: string, opts?: { recursive?: boolean }): Promise<void>
	delete(path: string, opts?: { recursive?: boolean }): Promise<void>
	rename(from: string, to: string): Promise<void>

	search(pattern: string, opts?: SearchOpts): Promise<Match[]>

	exec(cmd: string, opts?: ExecOpts): ExecHandle

	dispose(): Promise<void>
}
```

- [ ] **Step 2: Verify it type-checks**

Run: `npm run check-types`
Expected: PASS (no references yet; module compiles).

- [ ] **Step 3: Commit**

```bash
git add src/services/environment/types.ts
git commit -m "feat(env): add Environment interface and types"
```

---

## Task 2: `LocalEnvironment` implementation

**Files:**
- Create: `src/services/environment/LocalEnvironment.ts`
- Test: `src/services/environment/__tests__/LocalEnvironment.test.ts`

`LocalEnvironment` reproduces current local behavior. File/stat/list ops use `node:fs/promises`; `search` delegates to the existing `regexSearchFiles` (`@services/ripgrep`) and parses its output; `exec` wraps `node:child_process.spawn` with a streaming `ExecHandle` mirroring `StandaloneTerminalProcess` semantics (line events, SIGTERM kill, stdin).

- [ ] **Step 1: Write the failing test (files + cwd + exec)**

```ts
// src/services/environment/__tests__/LocalEnvironment.test.ts
import { strict as assert } from "node:assert"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, it } from "mocha"
import { LocalEnvironment } from "@services/environment/LocalEnvironment"

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
		for await (const chunk of h.stdout) out += chunk
		assert.equal(await h.exitCode, 0)
		assert.match(out, /hello/)
	})
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx cross-env TS_NODE_PROJECT=./tsconfig.unit-test.json mocha src/services/environment/__tests__/LocalEnvironment.test.ts`
Expected: FAIL — `Cannot find module '@services/environment/LocalEnvironment'`.

- [ ] **Step 3: Implement `LocalEnvironment`**

```ts
// src/services/environment/LocalEnvironment.ts
import { type ChildProcess, spawn } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"
import { regexSearchFiles } from "@services/ripgrep"
import {
	type DirEntry,
	type Environment,
	EnvironmentError,
	type EnvStat,
	type ExecHandle,
	type ExecOpts,
	type Match,
	type SearchOpts,
} from "./types"

export class LocalEnvironment implements Environment {
	readonly id = "local"
	constructor(readonly cwd: string) {}

	private abs(p: string): string {
		return path.isAbsolute(p) ? p : path.resolve(this.cwd, p)
	}

	async readFile(p: string): Promise<string> {
		try {
			return await fs.readFile(this.abs(p), "utf8")
		} catch (e) {
			throw new EnvironmentError("readFile", p, e)
		}
	}

	async writeFile(p: string, content: string): Promise<void> {
		try {
			await fs.mkdir(path.dirname(this.abs(p)), { recursive: true })
			await fs.writeFile(this.abs(p), content, "utf8")
		} catch (e) {
			throw new EnvironmentError("writeFile", p, e)
		}
	}

	async exists(p: string): Promise<boolean> {
		try {
			await fs.access(this.abs(p))
			return true
		} catch {
			return false
		}
	}

	async stat(p: string): Promise<EnvStat> {
		try {
			const s = await fs.stat(this.abs(p))
			return { isDir: s.isDirectory(), size: s.size, mtimeMs: s.mtimeMs }
		} catch (e) {
			throw new EnvironmentError("stat", p, e)
		}
	}

	async list(p: string, opts?: { recursive?: boolean }): Promise<DirEntry[]> {
		try {
			const ents = await fs.readdir(this.abs(p), {
				withFileTypes: true,
				recursive: opts?.recursive ?? false,
			})
			return ents.map((e) => ({ name: e.name, isDir: e.isDirectory() }))
		} catch (e) {
			throw new EnvironmentError("list", p, e)
		}
	}

	async mkdir(p: string, opts?: { recursive?: boolean }): Promise<void> {
		try {
			await fs.mkdir(this.abs(p), { recursive: opts?.recursive ?? true })
		} catch (e) {
			throw new EnvironmentError("mkdir", p, e)
		}
	}

	async delete(p: string, opts?: { recursive?: boolean }): Promise<void> {
		try {
			await fs.rm(this.abs(p), { recursive: opts?.recursive ?? false, force: true })
		} catch (e) {
			throw new EnvironmentError("delete", p, e)
		}
	}

	async rename(from: string, to: string): Promise<void> {
		try {
			await fs.rename(this.abs(from), this.abs(to))
		} catch (e) {
			throw new EnvironmentError("rename", from, e)
		}
	}

	async search(pattern: string, opts?: SearchOpts): Promise<Match[]> {
		const dir = this.abs(opts?.path ?? ".")
		const raw = await regexSearchFiles(
			this.cwd,
			dir,
			pattern,
			opts?.glob,
			undefined,
			undefined,
			opts?.contextLines,
			undefined,
			opts?.abortSignal,
		)
		return parseRipgrepOutput(raw)
	}

	exec(cmd: string, opts?: ExecOpts): ExecHandle {
		const cwd = opts?.cwd ? this.abs(opts.cwd) : this.cwd
		const child = spawn(cmd, {
			cwd,
			shell: true,
			env: { ...process.env, ...(opts?.env ?? {}) },
		})
		return new LocalExecHandle(child, opts)
	}

	async dispose(): Promise<void> {}
}

/** Best-effort parse of "path:line:col:text" lines into structured matches. */
export function parseRipgrepOutput(raw: string): Match[] {
	const matches: Match[] = []
	for (const line of raw.split("\n")) {
		const m = line.match(/^(.+?):(\d+):(\d+):(.*)$/)
		if (m) {
			matches.push({ file: m[1], line: Number(m[2]), column: Number(m[3]), text: m[4] })
		}
	}
	return matches
}

class LocalExecHandle implements ExecHandle {
	readonly stdout: AsyncIterable<string>
	readonly stderr: AsyncIterable<string>
	readonly exitCode: Promise<number>
	constructor(
		private child: ChildProcess,
		opts?: ExecOpts,
	) {
		this.stdout = streamFrom(child, "stdout")
		this.stderr = streamFrom(child, "stderr")
		this.exitCode = new Promise<number>((resolve) => {
			child.on("close", (code) => resolve(code ?? 0))
		})
		if (opts?.abortSignal) {
			opts.abortSignal.addEventListener("abort", () => this.kill(), { once: true })
		}
		if (opts?.timeoutSeconds) {
			const t = setTimeout(() => this.kill(), opts.timeoutSeconds * 1000)
			void this.exitCode.finally(() => clearTimeout(t))
		}
	}
	writeStdin(data: string): void {
		this.child.stdin?.write(data)
	}
	kill(signal: NodeJS.Signals = "SIGTERM"): void {
		this.child.kill(signal)
	}
}

async function* streamFrom(child: ChildProcess, which: "stdout" | "stderr"): AsyncIterable<string> {
	const stream = child[which]
	if (!stream) return
	for await (const chunk of stream) {
		yield chunk.toString("utf8")
	}
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx cross-env TS_NODE_PROJECT=./tsconfig.unit-test.json mocha src/services/environment/__tests__/LocalEnvironment.test.ts`
Expected: PASS (4 passing).

- [ ] **Step 5: Commit**

```bash
git add src/services/environment/LocalEnvironment.ts src/services/environment/__tests__/LocalEnvironment.test.ts
git commit -m "feat(env): add LocalEnvironment (fs/ripgrep/spawn backed)"
```

---

## Task 3: `InMemoryEnvironment` (test impl)

**Files:**
- Create: `src/services/environment/InMemoryEnvironment.ts`
- Test: `src/services/environment/__tests__/InMemoryEnvironment.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/services/environment/__tests__/InMemoryEnvironment.test.ts
import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import { InMemoryEnvironment } from "@services/environment/InMemoryEnvironment"

describe("InMemoryEnvironment", () => {
	it("writes, reads, stats, lists, deletes", async () => {
		const env = new InMemoryEnvironment("/work")
		await env.writeFile("a/b.txt", "hello")
		assert.equal(await env.readFile("a/b.txt"), "hello")
		assert.equal(await env.exists("a/b.txt"), true)
		assert.equal((await env.stat("a/b.txt")).size, 5)
		assert.deepEqual((await env.list("a")).map((e) => e.name), ["b.txt"])
		await env.delete("a/b.txt")
		assert.equal(await env.exists("a/b.txt"), false)
	})

	it("throws EnvironmentError on missing read", async () => {
		const env = new InMemoryEnvironment("/work")
		await assert.rejects(() => env.readFile("nope.txt"), /environment readFile failed/)
	})
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx cross-env TS_NODE_PROJECT=./tsconfig.unit-test.json mocha src/services/environment/__tests__/InMemoryEnvironment.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `InMemoryEnvironment`**

```ts
// src/services/environment/InMemoryEnvironment.ts
import path from "node:path"
import {
	type DirEntry,
	type Environment,
	EnvironmentError,
	type EnvStat,
	type ExecHandle,
	type Match,
} from "./types"

export class InMemoryEnvironment implements Environment {
	readonly id = "memory"
	private files = new Map<string, string>()
	constructor(readonly cwd: string = "/") {}

	private key(p: string): string {
		return path.posix.normalize(path.isAbsolute(p) ? p : path.posix.join(this.cwd, p))
	}

	async readFile(p: string): Promise<string> {
		const v = this.files.get(this.key(p))
		if (v === undefined) throw new EnvironmentError("readFile", p, new Error("ENOENT"))
		return v
	}
	async writeFile(p: string, content: string): Promise<void> {
		this.files.set(this.key(p), content)
	}
	async exists(p: string): Promise<boolean> {
		const k = this.key(p)
		return this.files.has(k) || [...this.files.keys()].some((f) => f.startsWith(`${k}/`))
	}
	async stat(p: string): Promise<EnvStat> {
		const k = this.key(p)
		if (this.files.has(k)) {
			return { isDir: false, size: Buffer.byteLength(this.files.get(k)!), mtimeMs: 0 }
		}
		if (await this.exists(p)) return { isDir: true, size: 0, mtimeMs: 0 }
		throw new EnvironmentError("stat", p, new Error("ENOENT"))
	}
	async list(p: string, opts?: { recursive?: boolean }): Promise<DirEntry[]> {
		const prefix = `${this.key(p)}/`
		const seen = new Map<string, boolean>()
		for (const f of this.files.keys()) {
			if (!f.startsWith(prefix)) continue
			const rest = f.slice(prefix.length)
			if (opts?.recursive) {
				seen.set(rest, false)
			} else {
				const head = rest.split("/")[0]
				seen.set(head, rest.includes("/"))
			}
		}
		return [...seen.entries()].map(([name, isDir]) => ({ name, isDir }))
	}
	async mkdir(): Promise<void> {}
	async delete(p: string, opts?: { recursive?: boolean }): Promise<void> {
		const k = this.key(p)
		this.files.delete(k)
		if (opts?.recursive) {
			for (const f of [...this.files.keys()]) if (f.startsWith(`${k}/`)) this.files.delete(f)
		}
	}
	async rename(from: string, to: string): Promise<void> {
		const v = await this.readFile(from)
		await this.writeFile(to, v)
		await this.delete(from)
	}
	async search(): Promise<Match[]> {
		return []
	}
	exec(): ExecHandle {
		const empty = (async function* () {})()
		return {
			stdout: empty,
			stderr: empty,
			writeStdin: () => {},
			kill: () => {},
			exitCode: Promise.resolve(0),
		}
	}
	async dispose(): Promise<void> {
		this.files.clear()
	}
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx cross-env TS_NODE_PROJECT=./tsconfig.unit-test.json mocha src/services/environment/__tests__/InMemoryEnvironment.test.ts`
Expected: PASS (2 passing).

- [ ] **Step 5: Commit**

```bash
git add src/services/environment/InMemoryEnvironment.ts src/services/environment/__tests__/InMemoryEnvironment.test.ts
git commit -m "test(env): add InMemoryEnvironment for handler tests"
```

---

## Task 4: Conformance suite + barrel + `resolveEnvironment`

**Files:**
- Create: `src/services/environment/__tests__/conformance.ts`
- Create: `src/services/environment/resolveEnvironment.ts`
- Create: `src/services/environment/index.ts`
- Modify: `src/services/environment/__tests__/LocalEnvironment.test.ts` (call conformance)
- Modify: `src/services/environment/__tests__/InMemoryEnvironment.test.ts` (call conformance)

- [ ] **Step 1: Write the conformance helper**

```ts
// src/services/environment/__tests__/conformance.ts
import { strict as assert } from "node:assert"
import { it } from "mocha"
import type { Environment } from "@services/environment/types"

/** Shared behavior every Environment implementation must satisfy. */
export function runEnvironmentConformance(make: () => Promise<Environment>) {
	it("conformance: write -> read -> exists -> stat -> delete", async () => {
		const env = await make()
		await env.writeFile("f/g.txt", "abc")
		assert.equal(await env.readFile("f/g.txt"), "abc")
		assert.equal(await env.exists("f/g.txt"), true)
		assert.equal((await env.stat("f/g.txt")).size, 3)
		await env.delete("f/g.txt")
		assert.equal(await env.exists("f/g.txt"), false)
		await env.dispose()
	})

	it("conformance: list returns written entries", async () => {
		const env = await make()
		await env.writeFile("d/x.txt", "1")
		await env.writeFile("d/y.txt", "2")
		const names = (await env.list("d")).map((e) => e.name).sort()
		assert.deepEqual(names, ["x.txt", "y.txt"])
		await env.dispose()
	})

	it("conformance: missing read rejects", async () => {
		const env = await make()
		await assert.rejects(() => env.readFile("absent.txt"))
		await env.dispose()
	})
}
```

- [ ] **Step 2: Wire conformance into both impl tests**

In `src/services/environment/__tests__/LocalEnvironment.test.ts`, add import `import { runEnvironmentConformance } from "./conformance"` and, inside the top-level `describe` after the existing `it`s:
```ts
	describe("conformance", () => {
		runEnvironmentConformance(async () => new LocalEnvironment(await fs.mkdtemp(path.join(os.tmpdir(), "isaac-env-conf-"))))
	})
```

In `src/services/environment/__tests__/InMemoryEnvironment.test.ts`, add import `import { runEnvironmentConformance } from "./conformance"` and:
```ts
	describe("conformance", () => {
		runEnvironmentConformance(async () => new InMemoryEnvironment("/work"))
	})
```

- [ ] **Step 3: Write `resolveEnvironment` + barrel**

```ts
// src/services/environment/resolveEnvironment.ts
import { LocalEnvironment } from "./LocalEnvironment"
import type { Environment } from "./types"

export interface ResolveEnvironmentOptions {
	cwd: string
	/** Local command runner (the existing executeCommandTool callback). */
	commandRunner?: import("./LocalEnvironment").CommandRunner
}

/**
 * Selection seam for the agent's execution environment.
 * #1: always Local. #2 will branch on a flag/config to return a RemoteEnvironment.
 */
export function resolveEnvironment(opts: ResolveEnvironmentOptions): Environment {
	return new LocalEnvironment(opts.cwd, opts.commandRunner)
}
```

```ts
// src/services/environment/index.ts
export * from "./types"
export { LocalEnvironment } from "./LocalEnvironment"
export { InMemoryEnvironment } from "./InMemoryEnvironment"
export { resolveEnvironment } from "./resolveEnvironment"
```

> `CommandRunner` is defined in Task 11 Step 1. Until Task 11, omit the `commandRunner` field and the second `LocalEnvironment` arg, then add them in Task 11.

- [ ] **Step 4: Run both test files**

Run: `npx cross-env TS_NODE_PROJECT=./tsconfig.unit-test.json mocha "src/services/environment/__tests__/*.test.ts"`
Expected: PASS (all conformance + impl tests green).

- [ ] **Step 5: Commit**

```bash
git add src/services/environment/
git commit -m "test(env): add conformance suite + resolveEnvironment + barrel"
```

---

## Task 5: Wire `Environment` into `TaskConfig` -> `ToolExecutor` -> `TaskFactory`

**Files:**
- Modify: `src/core/task/tools/types/TaskConfig.ts` (interface ~L29-65)
- Modify: `src/core/task/ToolExecutor.ts` (constructor ~L65-133; `asToolConfig()` ~L228-292)
- Modify: `src/core/task/TaskFactory.ts` (`buildTaskManagers` ~L366; `new ToolExecutor(...)` ~L414-447)

> `config.environment` is a **top-level** field (not under `services`) so we do NOT touch `TASK_SERVICES_KEYS` / `validateTaskConfig` iteration. Add it to the interface only.

- [ ] **Step 1: Add `environment` to `TaskConfig`**

In `src/core/task/tools/types/TaskConfig.ts`, add import:
```ts
import type { Environment } from "@services/environment"
```
Inside the `TaskConfig` interface (next to `cwd: string`):
```ts
	/** Execution environment for tool I/O (files/shell/search). Local by default. */
	environment: Environment
```

- [ ] **Step 2: Add constructor param + populate in `asToolConfig`**

In `src/core/task/ToolExecutor.ts`:
- Add import: `import type { Environment } from "@services/environment"`.
- Add a constructor parameter `private readonly environment: Environment` as the **last** positional param.
- In `asToolConfig()` returned object (near `cwd: this.cwd`):
```ts
			environment: this.environment,
```

- [ ] **Step 3: Construct + pass it in `TaskFactory`**

In `src/core/task/TaskFactory.ts`:
- Add import: `import { resolveEnvironment } from "@services/environment"`.
- Inside `buildTaskManagers`, before `new ToolExecutor(...)`:
```ts
	const environment = resolveEnvironment({ cwd })
```
- Append `environment` as the **last** argument to `new ToolExecutor(...)`.

- [ ] **Step 4: Verify types compile**

Run: `npm run check-types`
Expected: PASS. (A `validateTaskConfig` complaint about a missing key means `environment` was wrongly nested under `services` — keep it top-level.)

- [ ] **Step 5: Run the unit suite (no behavior change yet)**

Run: `npm run test:unit`
Expected: PASS — same baseline counts. Existing handler tests build a mock `TaskConfig`; they still pass because nothing reads `config.environment` yet.

- [ ] **Step 6: Commit**

```bash
git add src/core/task/tools/types/TaskConfig.ts src/core/task/ToolExecutor.ts src/core/task/TaskFactory.ts
git commit -m "feat(env): inject Environment into TaskConfig via TaskFactory"
```

---

## Task 6: Migrate ReadFile handler (exemplar)

**Files:**
- Modify: `src/core/task/tools/handlers/ReadFileToolHandler.ts` (`fs.stat` ~L253; import L1)
- Test: `src/core/task/tools/handlers/__tests__/ReadFileToolHandler.fileNotFound.test.ts` (mock at ~L56-108)

- [ ] **Step 1: Add `config.environment` to the existing test mock**

Add import at top: `import { LocalEnvironment } from "@services/environment"`.
In `beforeEach`, after `config.cwd = tmpDir`:
```ts
config.environment = new LocalEnvironment(tmpDir)
```

- [ ] **Step 2: Run it to confirm the test still passes (pre-change)**

Run: `npx cross-env TS_NODE_PROJECT=./tsconfig.unit-test.json mocha src/core/task/tools/handlers/__tests__/ReadFileToolHandler.fileNotFound.test.ts`
Expected: PASS (field set, unused yet).

- [ ] **Step 3: Replace direct `fs.stat` with `config.environment.stat`**

At ~L253 replace:
```ts
const stats = await fs.stat(absolutePath)
```
with:
```ts
const stats = await config.environment.stat(absolutePath)
```
`stats.size` keeps working (`EnvStat.size`). Remove `import fs from "node:fs/promises"` (L1) only if no other `fs.` usage remains — check first:
```bash
rg "fs\." src/core/task/tools/handlers/ReadFileToolHandler.ts
```

- [ ] **Step 4: Run the handler test + the unit suite**

Run: `npx cross-env TS_NODE_PROJECT=./tsconfig.unit-test.json mocha src/core/task/tools/handlers/__tests__/ReadFileToolHandler.fileNotFound.test.ts`
Then: `npm run test:unit`
Expected: PASS, baseline counts.

- [ ] **Step 5: Commit**

```bash
git add src/core/task/tools/handlers/ReadFileToolHandler.ts src/core/task/tools/handlers/__tests__/ReadFileToolHandler.fileNotFound.test.ts
git commit -m "refactor(env): ReadFile uses config.environment.stat"
```

---

## Task 7: Migrate WriteToFile handler

**Files:**
- Modify: `src/core/task/tools/handlers/WriteToFileToolHandler.ts` (`fs.stat` ~L521, `fs.access` ~L530 in `validateFileAccess`; import L1)
- Test: existing write handler tests under `src/core/task/tools/handlers/__tests__/`

- [ ] **Step 1: Add `config.environment` to the write handler test mock(s)** — mirror Task 6 Step 1 (import `LocalEnvironment`; set `config.environment = new LocalEnvironment(tmpDir)` in setup).

- [ ] **Step 2: Replace fs calls**

At ~L521 replace `await fs.stat(absolutePath)` → `await config.environment.stat(absolutePath)`.
At ~L530 replace the access check:
```ts
await fs.access(absolutePath, fs.constants.W_OK)
```
with an existence check (write permission is implied locally; `EnvStat` has no mode, and #1 keeps local semantics):
```ts
if (!(await config.environment.exists(absolutePath))) {
	throw new Error(`File does not exist: ${absolutePath}`)
}
```
Keep the surrounding try/catch and the original error-message shape from `validateFileAccess`. Remove the `fs` import only if no other `fs.` remains (grep first).

> The real write stays via `config.services.diffViewProvider` (unchanged host write path).

- [ ] **Step 3: Run write handler tests + unit suite**

Run: `npm run test:unit`
Expected: PASS, baseline counts.

- [ ] **Step 4: Commit**

```bash
git add src/core/task/tools/handlers/WriteToFileToolHandler.ts src/core/task/tools/handlers/__tests__/
git commit -m "refactor(env): WriteToFile uses config.environment for stat/exists"
```

---

## Task 8: Migrate EditFile (BatchProcessor) read

**Files:**
- Modify: `src/core/task/tools/handlers/edit-file/BatchProcessor.ts` (`fs.readFile` ~L715 in `prepareEdits`; import L10)

`prepareEdits` already has `config` (it calls `resolvePath(config, relPath)` at L39).

- [ ] **Step 1: Add `config.environment` to an EditFile handler test mock** — e.g. `src/core/task/tools/handlers/__tests__/EditFileToolHandler.partialSuccess.test.ts`: import `LocalEnvironment`, set `config.environment = new LocalEnvironment(tmpDir)` (mirror Task 6 Step 1).

- [ ] **Step 2: Replace the read**

At ~L715 replace:
```ts
const content = await fs.readFile(absolutePath, "utf8")
```
with:
```ts
const content = await config.environment.readFile(absolutePath)
```
Keep the preceding `HostProvider.workspace.saveOpenDocumentIfDirty(...)` (L714) unchanged. Remove `import * as fs from "fs/promises"` (L10) only if no other `fs.` remains (grep first).

- [ ] **Step 3: Run EditFile tests + unit suite**

Run: `npm run test:unit`
Expected: PASS, baseline counts.

- [ ] **Step 4: Commit**

```bash
git add src/core/task/tools/handlers/edit-file/BatchProcessor.ts src/core/task/tools/handlers/__tests__/
git commit -m "refactor(env): EditFile BatchProcessor reads via config.environment"
```

---

## Task 9: Migrate ListFiles handler

**Files:**
- Modify: `src/services/environment/types.ts`, `LocalEnvironment.ts`, `InMemoryEnvironment.ts`
- Modify: `src/core/task/tools/handlers/ListFilesToolHandler.ts` (`listFiles(...)` ~L131; import L7)

The handler needs the glob service's native shape (paths + didHitLimit), richer than `DirEntry`. Add a passthrough.

> Before implementing, confirm the exact return type of `listFiles` in `@services/glob/list-files` and mirror it. This plan assumes `Promise<[string[], boolean]>` (paths, didHitLimit). If it differs, use the actual tuple/shape verbatim.

- [ ] **Step 1: Add `listFilesNative` to the interface + impls**

In `types.ts` `Environment`:
```ts
	/** Native directory walk preserving the glob service's shape + limit flag. */
	listFilesNative(path: string, recursive: boolean, limit: number, abortSignal?: AbortSignal): Promise<[string[], boolean]>
```
In `LocalEnvironment.ts`:
```ts
	async listFilesNative(p: string, recursive: boolean, limit: number, abortSignal?: AbortSignal): Promise<[string[], boolean]> {
		const { listFiles } = await import("@services/glob/list-files")
		return listFiles(this.abs(p), recursive, limit, abortSignal)
	}
```
In `InMemoryEnvironment.ts`:
```ts
	async listFilesNative(p: string, recursive: boolean, limit: number): Promise<[string[], boolean]> {
		const entries = await this.list(p, { recursive })
		const paths = entries.map((e) => `${this.key(p)}/${e.name}`)
		return [paths.slice(0, limit), paths.length > limit]
	}
```

- [ ] **Step 2: Switch the handler**

At ~L131 replace `listFiles(absolutePath, recursive, MAX_FILES_LIMIT, abortSignal)` with:
```ts
const [files, didHitLimit] = await config.environment.listFilesNative(absolutePath, recursive, MAX_FILES_LIMIT, abortSignal)
```
Match the destructuring to the handler's existing variable names. Remove `import { type FileInfo, listFiles } from "@services/glob/list-files"` (L7) if unused; keep `FileInfo` import if still referenced as a type.

- [ ] **Step 3: Run + commit**

Run: `npm run test:unit` → PASS.
```bash
git add src/services/environment/ src/core/task/tools/handlers/ListFilesToolHandler.ts
git commit -m "refactor(env): ListFiles walks via config.environment.listFilesNative"
```

---

## Task 10: Migrate search_files handler

**Files:**
- Modify: `src/services/environment/types.ts`, `LocalEnvironment.ts`, `InMemoryEnvironment.ts`
- Modify: `src/core/task/tools/handlers/SearchFilesToolHandler.ts` (`regexSearchFiles(...)` ~L110; import L3)

The handler consumes the **formatted string** from `regexSearchFiles`. Add a string-returning search to preserve behavior 1:1 (the structured `search()` from Task 1 stays for #2 consumers).

> Confirm the handler's current call arguments at `SearchFilesToolHandler.ts:110` and the `regexSearchFiles` signature at `src/services/ripgrep/index.ts:152` (`cwd, directoryPath, regex, filePattern?, isaacIgnoreController?, taskId?, contextLines?, excludeFilePatterns?, abortSignal?`). Thread whatever the handler passes today (e.g. `isaacIgnoreController`, `taskId`) through extra `SearchOpts` fields so behavior is identical.

- [ ] **Step 1: Add `searchFormatted` to the interface + impls**

In `types.ts` add to `SearchOpts`:
```ts
	filePattern?: string
	excludeFilePatterns?: string[]
```
and to `Environment`:
```ts
	/** Formatted ripgrep output, exactly as the search handler renders today. */
	searchFormatted(directoryPath: string, regex: string, opts?: SearchOpts & { isaacIgnoreController?: unknown; taskId?: string }): Promise<string>
```
In `LocalEnvironment.ts`:
```ts
	async searchFormatted(
		directoryPath: string,
		regex: string,
		opts?: SearchOpts & { isaacIgnoreController?: any; taskId?: string },
	): Promise<string> {
		return regexSearchFiles(
			this.cwd,
			this.abs(directoryPath),
			regex,
			opts?.filePattern ?? opts?.glob,
			opts?.isaacIgnoreController,
			opts?.taskId,
			opts?.contextLines,
			opts?.excludeFilePatterns,
			opts?.abortSignal,
		)
	}
```
In `InMemoryEnvironment.ts`:
```ts
	async searchFormatted(): Promise<string> {
		return ""
	}
```

- [ ] **Step 2: Switch the handler**

At ~L110 replace `regexSearchFiles(cwd, directoryPath, regex, filePattern, isaacIgnoreController, taskId, contextLines, excludeFilePatterns, abortSignal)` with:
```ts
await config.environment.searchFormatted(directoryPath, regex, {
	filePattern,
	isaacIgnoreController,
	taskId,
	contextLines,
	excludeFilePatterns,
	abortSignal,
})
```
(Use the handler's actual local variable names.) Remove `import { regexSearchFiles } from "@services/ripgrep"` (L3) if unused.

- [ ] **Step 3: Run + commit**

Run: `npm run test:unit` → PASS.
```bash
git add src/services/environment/ src/core/task/tools/handlers/SearchFilesToolHandler.ts
git commit -m "refactor(env): search_files goes through config.environment.searchFormatted"
```

---

## Task 11: Route execute_command through the Environment

**Files:**
- Modify: `src/services/environment/types.ts`, `LocalEnvironment.ts`, `InMemoryEnvironment.ts`, `resolveEnvironment.ts`
- Modify: `src/core/task/TaskFactory.ts` (pass `commandRunner`)
- Modify: `src/core/task/tools/handlers/ExecuteCommandToolHandler.ts` (callback ~L569-574)

Keep the existing terminal callback chain (it carries UI integration) but expose it through the Environment so #2 can swap it. `LocalEnvironment` calls the identical callback → behavior unchanged.

- [ ] **Step 1: Add `CommandRunner` + `runCommand` to the interface + impls**

In `types.ts`:
```ts
export type CommandRunner = (
	command: string,
	timeoutSeconds: number,
	opts: {
		onOutputLine?: (line: string) => void
		abortSignal?: AbortSignal
		useBackgroundExecution?: boolean
		suppressUserInteraction?: boolean
	},
) => Promise<[boolean, string]>
```
Add to `Environment`:
```ts
	runCommand: CommandRunner
```
In `LocalEnvironment.ts`, add the runner dependency + method:
```ts
	constructor(
		readonly cwd: string,
		private readonly commandRunner?: import("./types").CommandRunner,
	) {}

	runCommand: import("./types").CommandRunner = (command, timeoutSeconds, opts) => {
		if (!this.commandRunner) {
			throw new EnvironmentError("runCommand", undefined, new Error("no command runner configured"))
		}
		return this.commandRunner(command, timeoutSeconds, opts)
	}
```
In `InMemoryEnvironment.ts`:
```ts
	runCommand: import("./types").CommandRunner = async () => [false, ""]
```

- [ ] **Step 2: Thread the runner through `resolveEnvironment` + TaskFactory**

`resolveEnvironment.ts` already has `commandRunner?` (Task 4 Step 3). Confirm it passes it: `new LocalEnvironment(opts.cwd, opts.commandRunner)`.
In `TaskFactory.buildTaskManagers`, where `executeCommandTool` is in scope (it is passed to `new ToolExecutor(...)`), update the resolve call:
```ts
	const environment = resolveEnvironment({ cwd, commandRunner: executeCommandTool })
```

- [ ] **Step 3: Switch the handler**

At ~L569-574 in `ExecuteCommandToolHandler.ts`, replace:
```ts
config.callbacks.executeCommandTool(finalCommand, timeoutSeconds, { ... })
```
with:
```ts
config.environment.runCommand(finalCommand, timeoutSeconds, { ... })
```
Keep the identical options object and all surrounding async/throttle/registry logic.

- [ ] **Step 4: Update command handler tests + run unit suite**

In `src/core/task/tools/handlers/__tests__/ExecuteCommandToolHandler.test.ts` (and `.timeout.test.ts`), set the runner on the env in the mock config:
```ts
import { LocalEnvironment } from "@services/environment"
// ...
config.environment = new LocalEnvironment(tmpDir, sinon.stub().resolves([false, "ok"]))
```
(Replace the previous `config.callbacks.executeCommandTool` stub.)
Run: `npm run test:unit`
Expected: PASS, baseline counts.

- [ ] **Step 5: Commit**

```bash
git add src/services/environment/ src/core/task/tools/handlers/ExecuteCommandToolHandler.ts src/core/task/TaskFactory.ts src/core/task/tools/handlers/__tests__/
git commit -m "refactor(env): execute_command goes through config.environment.runCommand"
```

---

## Task 12: tree-sitter reads via Environment (optional content injection)

**Files:**
- Modify: `src/services/tree-sitter/index.ts` (`parseFile` ~L16; `fs.readFile` ~L25)
- Modify: the tree-sitter handler(s) `GetFileSkeletonToolHandler.ts` / `GetFunctionToolHandler.ts`

- [ ] **Step 1: Add optional content reader to `parseFile`**

Change the signature to add an options arg:
```ts
export async function parseFile(
	filePath: string,
	languageParsers: LanguageParser,
	isaacIgnoreController?: IsaacIgnoreController,
	options?: { readFile?: (p: string) => Promise<string> },
): Promise<...> {
```
At ~L25 replace:
```ts
const fileContent = await fs.readFile(filePath, "utf8")
```
with:
```ts
const fileContent = options?.readFile ? await options.readFile(filePath) : await fs.readFile(filePath, "utf8")
```
(Keep the `fs` import — the default branch still uses it.)

- [ ] **Step 2: Pass `config.environment.readFile` from the handler(s)**

Where the handler calls `parseFile(...)`, add the options arg:
```ts
parseFile(absolutePath, languageParsers, config.services.isaacIgnoreController, {
	readFile: (p) => config.environment.readFile(p),
})
```
(Use the handler's actual argument names; only add the trailing options object.)

- [ ] **Step 3: Run + commit**

Run: `npm run test:unit`
Expected: PASS (the "Big Four" tree-sitter `find_symbol_references` tests stay green; re-run once if the known sqlite-flaky skip triggers).
```bash
git add src/services/tree-sitter/index.ts src/core/task/tools/handlers/GetFileSkeletonToolHandler.ts src/core/task/tools/handlers/GetFunctionToolHandler.ts
git commit -m "refactor(env): tree-sitter parseFile accepts injected readFile"
```

---

## Task 13: E2E smoke + final full-gate verification

**Files:**
- Modify: `cli/tests/e2e/write-file.e2e.test.ts` (optional comment; the headless run already exercises `LocalEnvironment` via the default `resolveEnvironment`)

- [ ] **Step 1: Run the CLI E2E (default path now flows through LocalEnvironment)**

Run: `cd cli && npm run test:e2e`
Expected: PASS (1/1) — the spawned binary's tool I/O now goes through `LocalEnvironment`.

- [ ] **Step 2: Run the full gate matrix**

```bash
npm run test:unit
cd cli && CI=1 npm test && cd ..
npm run check-types
npm run lint
```
Expected: all PASS; root mocha + mcp at baseline counts, cli 554, typechecks + lint clean.

- [ ] **Step 3: Confirm migrated handlers no longer import raw fs**

```bash
rg -n "from \"node:fs|from \"fs/promises|from \"fs\"" src/core/task/tools/handlers/ReadFileToolHandler.ts src/core/task/tools/handlers/WriteToFileToolHandler.ts src/core/task/tools/handlers/edit-file/BatchProcessor.ts
```
Expected: no matches for these three files. (Symbol/diagnostics handlers are out of #1 scope and may still import fs.)

- [ ] **Step 4: Push branch + open PR**

```bash
git push -u origin feat/lisael-environment
```
Open PR `feat/lisael-environment -> master`, title `feat: LISAEL environment foundation (#1)`. (If pushing via Gitea HTTPS token, remove the token from `.git/config` afterward.)

---

## Self-Review

- **Spec coverage:** interface (Task 1) ✓; LocalEnvironment 1:1 (Task 2) ✓; InMemory + conformance (Tasks 3-4) ✓; wiring via TaskFactory/TaskConfig (Task 5) ✓; handler migration files/list/search/shell (Tasks 6-11) ✓; tree-sitter local read (Task 12) ✓; E2E dimension + behavior-preservation gates (Task 13) ✓. **Deferred from spec §5 with rationale:** checkpoints (`simple-git`) + symbol/diagnostics handlers — documented in the Scope note.
- **Placeholder scan:** no TBD/TODO; every code step has concrete code. Two spots require confirming an exact upstream shape before locking (the `listFiles` tuple in Task 9; the `regexSearchFiles` arg order/handler args in Task 10) — both cite the exact source location to mirror, not a vague instruction.
- **Type consistency:** handler-used methods (`stat`, `readFile`, `exists`, `listFilesNative`, `searchFormatted`, `runCommand`) are declared in Task 1 or added in Tasks 9-11; `CommandRunner` (Task 11) is referenced by `resolveEnvironment` (Task 4) with an explicit forward-note; `EnvStat.size` (Task 6) matches Task 1; `config.environment` (Task 5) matches all handler usages.
