# Consolidation Reliquat — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the remaining open debt after `simplify-souverain`: harden plugin-hook execution, scrub secrets from JSONL traces (with tests), and complete LISAEL #4 (snapshot GC + `/restore` re-entry).

**Architecture:** Three independent lots, each a few atomic commits ending green. Lot 1 = security (hook spawn + trace scrub). Lot 2 = tracing tests. Lot 3 = LISAEL completion (snapshot prune + restore re-entry).

**Tech Stack:** TypeScript (strict), mocha+ts-node (root unit, co-located `__tests__/`), vitest (cli), biome. Tests run: `npx cross-env TS_NODE_PROJECT=./tsconfig.unit-test.json mocha <file>`. TABS. Pre-commit biome hook; never `--no-verify`; commit subjects ≤50 chars, no AI trailer.

**Spec:** `docs/superpowers/specs/2026-06-08-consolidation-reliquat-design.md`

> **Note (verified 2026-06-08):** Spec Lot 4 (`getDiracHomePath` rename) is ALREADY DONE — the function is `getIsaacHomePath()` (`src/core/storage/disk.ts:120`) with no Dirac naming left. Lot 4 is dropped.

---

## Task 1: Harden plugin-hook execution (no shell)

**Files:**
- Modify: `src/core/hooks/HookProcess.ts` (the Unix branch of `getHookLaunchConfig`, ~lines 68-75)
- Test: `src/core/hooks/__tests__/HookProcess.launch.test.ts` (new)

**Context:** On Unix, `getHookLaunchConfig` currently returns `{ command: escapeShellPath(scriptPath), args: [], shell: true, detached: true }` — it runs the hook script *through a shell* (for shebang support). `shell: true` + a command string is a shell-injection surface (plugin hooks come from the user-writable `~/.claude/plugins/cache/`). A POSIX kernel honors a script's shebang when the file is executable and spawned **directly**, so we can drop the shell entirely: make the script executable, then `spawn(scriptPath, [], { shell: false })`. No shell, no escaping needed.

- [ ] **Step 1: Write the failing test**

```typescript
// src/core/hooks/__tests__/HookProcess.launch.test.ts
import { strict as assert } from "node:assert"
import { afterEach, describe, it } from "mocha"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
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
```

> If `getHookLaunchConfig` is not currently exported, export it (`export async function getHookLaunchConfig`). It is a top-level function in `HookProcess.ts`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx cross-env TS_NODE_PROJECT=./tsconfig.unit-test.json mocha src/core/hooks/__tests__/HookProcess.launch.test.ts`
Expected: FAIL (`cfg.shell` is `true`, and the exec bit is not set).

- [ ] **Step 3: Implement**

In `src/core/hooks/HookProcess.ts`, replace the Unix-branch return (the block that currently reads):

```typescript
	const escapedScriptPath = escapeShellPath(scriptPath)
	return {
		command: escapedScriptPath,
		args: [],
		shell: true,
		detached: true,
	}
```

with:

```typescript
	// Make the hook script executable and run it directly. A POSIX kernel
	// honors the script's shebang on direct exec, so we avoid a shell entirely
	// (plugin hooks come from a user-writable cache — shell:true would be a
	// shell-injection surface). No shell ⇒ no path escaping needed.
	await fs.chmod(scriptPath, 0o755)
	return {
		command: scriptPath,
		args: [],
		shell: false,
		detached: true,
	}
```

Add `import * as fs from "node:fs/promises"` if not already imported. Remove the now-unused `escapeShellPath` import if nothing else in the file uses it (grep first; `shell-escape.ts` and its own test stay). The function is already `async`.

- [ ] **Step 4: Run the test + the existing hook tests**

Run: `npx cross-env TS_NODE_PROJECT=./tsconfig.unit-test.json mocha src/core/hooks/__tests__/*.ts`
Expected: PASS (new test + existing shell-escape tests still green).

- [ ] **Step 5: Commit**

```bash
git add src/core/hooks/HookProcess.ts src/core/hooks/__tests__/HookProcess.launch.test.ts
git commit -m "fix(hooks): run hook scripts without a shell"
```

---

## Task 2: Trace secret scrubber (pure module)

**Files:**
- Create: `src/core/tracing/scrub.ts`
- Test: `src/core/tracing/__tests__/scrub.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/core/tracing/__tests__/scrub.test.ts
import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import { scrubSecrets } from "../scrub"

describe("scrubSecrets", () => {
	it("redacts Bearer tokens", () => {
		assert.equal(scrubSecrets("Authorization: Bearer abc123XYZ_tok"), "Authorization: Bearer ***")
	})
	it("redacts sk- api keys", () => {
		assert.equal(scrubSecrets("key=sk-AbCd1234efgh5678"), "key=sk-***")
	})
	it("leaves ordinary text untouched", () => {
		const s = "the bearer of bad news said ok"
		assert.equal(scrubSecrets(s), s)
	})
	it("is idempotent", () => {
		const once = scrubSecrets("Bearer abc123XYZ_tok")
		assert.equal(scrubSecrets(once), once)
	})
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx cross-env TS_NODE_PROJECT=./tsconfig.unit-test.json mocha src/core/tracing/__tests__/scrub.test.ts`
Expected: FAIL (`Cannot find module '../scrub'`).

- [ ] **Step 3: Implement `src/core/tracing/scrub.ts`**

```typescript
// src/core/tracing/scrub.ts
// Redacts secrets from strings before they are written to JSONL traces.
// Patterns are conservative (low false-positive) and central so they are easy
// to extend. Redaction is idempotent: re-scrubbing an already-redacted string
// is a no-op.
const PATTERNS: Array<[RegExp, string]> = [
	// "Bearer <token>" (token = 12+ url-safe chars), but not the already-masked form.
	[/Bearer\s+(?!\*\*\*)[A-Za-z0-9._-]{12,}/g, "Bearer ***"],
	// OpenAI-style keys: sk-<8+ url-safe chars>, but not the masked form.
	[/sk-(?!\*\*\*)[A-Za-z0-9_-]{8,}/g, "sk-***"],
]

export function scrubSecrets(text: string): string {
	let out = text
	for (const [re, repl] of PATTERNS) {
		out = out.replace(re, repl)
	}
	return out
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx cross-env TS_NODE_PROJECT=./tsconfig.unit-test.json mocha src/core/tracing/__tests__/scrub.test.ts`
Expected: PASS (4 passing).

- [ ] **Step 5: Commit**

```bash
git add src/core/tracing/scrub.ts src/core/tracing/__tests__/scrub.test.ts
git commit -m "feat(tracing): secret scrubber for traces"
```

---

## Task 3: Apply scrubber in JsonlTracer

**Files:**
- Modify: `src/core/tracing/JsonlTracer.ts` (`appendTurn`, ~line 230)
- Test: `src/core/tracing/__tests__/JsonlTracer.scrub.test.ts` (new)

**Context:** `appendTurn(input)` (line 230) builds a `TraceLine` and appends it as one JSON line to `trace.jsonl` (`fs.appendFileSync`). Inject scrubbing so every string value in the serialized record is redacted. The simplest correct place: scrub the final JSON string before it is appended (covers all string fields uniformly without walking the object).

- [ ] **Step 1: Write the failing test**

```typescript
// src/core/tracing/__tests__/JsonlTracer.scrub.test.ts
import { strict as assert } from "node:assert"
import { afterEach, describe, it } from "mocha"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { JsonlTracer } from "../JsonlTracer"

describe("JsonlTracer scrubbing", () => {
	let dir = ""
	afterEach(() => {
		if (dir) fs.rmSync(dir, { recursive: true, force: true })
	})

	it("redacts Bearer tokens written to trace.jsonl", () => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "trace-"))
		const tracer = new JsonlTracer(dir, "task-test")
		tracer.recordPlannerTurn("called with Authorization: Bearer abc123XYZ_secret", 12)
		const jsonl = fs.readFileSync(path.join(dir, ".ailiance-agent/runs/task-test/trace.jsonl"), "utf8")
		assert.ok(!jsonl.includes("abc123XYZ_secret"), "secret must not be in the trace")
		assert.ok(jsonl.includes("Bearer ***"), "secret must be redacted")
	})
})
```

> Confirm `JsonlTracer`'s constructor signature and the on-disk path from `JsonlTracer.ts` (the layout comment at line 8 and `TRACING_DIR_NAME` at line 16). Adjust the constructor call and the read path in the test to match the real API before running. If `recordPlannerTurn` is not the simplest entry, use `appendTurn({ phase: <a real TracePhase>, <a string field>: "Bearer abc123XYZ_secret" })` and assert on that field.

- [ ] **Step 2: Run to verify it fails**

Run: `npx cross-env TS_NODE_PROJECT=./tsconfig.unit-test.json mocha src/core/tracing/__tests__/JsonlTracer.scrub.test.ts`
Expected: FAIL (raw secret present in the file).

- [ ] **Step 3: Implement**

In `JsonlTracer.ts`: `import { scrubSecrets } from "./scrub"`. In `appendTurn`, locate where the `TraceLine` is serialized for append (the `JSON.stringify(...)` feeding `fs.appendFileSync`). Wrap that serialized line:

```typescript
const line = scrubSecrets(JSON.stringify(record)) + "\n"
// ...existing append of `line`...
```

Use the existing serialized-string variable name; only wrap it in `scrubSecrets(...)`. Do not change the record object itself (so in-memory return values are unchanged) — scrub only the bytes written to disk.

- [ ] **Step 4: Run to verify it passes**

Run: `npx cross-env TS_NODE_PROJECT=./tsconfig.unit-test.json mocha src/core/tracing/__tests__/JsonlTracer.scrub.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/tracing/JsonlTracer.ts src/core/tracing/__tests__/JsonlTracer.scrub.test.ts
git commit -m "fix(tracing): scrub secrets before JSONL write"
```

---

## Task 4: Snapshot retention / GC

**Files:**
- Modify: `src/core/storage/snapshot/SnapshotStore.ts`
- Test: `src/core/storage/snapshot/__tests__/SnapshotStore.prune.test.ts` (new)

**Context:** `SnapshotStore` has `save(bundle)`, `list(): SnapshotMeta[]`, `load(id)`, private `dir(id)` and `env`, and stores each snapshot at `<root>/<id>/`. `SnapshotMeta` has `createdAt` (ISO string). `Environment.delete(path, { recursive })` exists. Add `prune(keep)` and call it best-effort at the end of `save`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/core/storage/snapshot/__tests__/SnapshotStore.prune.test.ts
import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import { InMemoryEnvironment } from "../../../../services/environment/InMemoryEnvironment"
import { GlobalFileNames } from "../../disk"
import { serialize, SNAPSHOT_SCHEMA_VERSION, type SnapshotMeta } from "../SessionSnapshot"
import { SnapshotStore } from "../SnapshotStore"

function bundle(id: string, createdAt: string) {
	const meta: SnapshotMeta = {
		id,
		label: id,
		sourceTaskId: "t",
		createdAt,
		env: "local",
		schemaVersion: SNAPSHOT_SCHEMA_VERSION,
	}
	return serialize(meta, { [GlobalFileNames.apiConversationHistory]: "[]" })
}

describe("SnapshotStore.prune", () => {
	it("keeps only the N most recent snapshots", async () => {
		const store = new SnapshotStore(new InMemoryEnvironment("/"), "/snapshots")
		await store.save(bundle("a", "2026-06-01T00:00:00.000Z"))
		await store.save(bundle("b", "2026-06-02T00:00:00.000Z"))
		await store.save(bundle("c", "2026-06-03T00:00:00.000Z"))
		await store.prune(2)
		const ids = (await store.list()).map((m) => m.id).sort()
		assert.deepEqual(ids, ["b", "c"], "oldest (a) is pruned")
	})
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx cross-env TS_NODE_PROJECT=./tsconfig.unit-test.json mocha src/core/storage/snapshot/__tests__/SnapshotStore.prune.test.ts`
Expected: FAIL (`store.prune is not a function`).

- [ ] **Step 3: Implement**

In `SnapshotStore.ts`, define the constant near the top:

```typescript
const SNAPSHOT_KEEP_DEFAULT = 20
```

Add the method:

```typescript
	/** Delete all but the `keep` most recent snapshots (by createdAt). */
	async prune(keep: number): Promise<void> {
		const metas = await this.list()
		const stale = metas
			.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
			.slice(keep)
		for (const m of stale) {
			try {
				await this.env.delete(this.dir(m.id), { recursive: true })
			} catch {
				// best-effort: a failed prune must never break the caller
			}
		}
	}
```

At the end of `save(bundle)`, after the files are written, add:

```typescript
		await this.prune(SNAPSHOT_KEEP_DEFAULT)
```

> The just-saved snapshot is always the newest (`createdAt` desc), so it is never pruned by its own save. Confirm `Environment.delete` signature in `src/services/environment/types.ts`.

- [ ] **Step 4: Run to verify it passes**

Run: `npx cross-env TS_NODE_PROJECT=./tsconfig.unit-test.json mocha src/core/storage/snapshot/__tests__/SnapshotStore.prune.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/storage/snapshot/SnapshotStore.ts src/core/storage/snapshot/__tests__/SnapshotStore.prune.test.ts
git commit -m "feat(snapshot): retention/GC on save"
```

---

## Task 5: `/restore` live session re-entry

**Files:**
- Investigate first: `src/core/task/index.ts`, `src/core/task/AgentLoopRunner.ts`, `src/core/task/TaskState.ts`, `src/core/controller/index.ts` (`reinitExistingTaskFromId`)
- Modify: `src/core/storage/snapshot/snapshotCommands.ts`, `src/core/task/ContextLoader.ts`, the task-loop consumption point, `src/core/task/TaskState.ts`
- Test: extend `src/core/storage/snapshot/__tests__/snapshotCommands.test.ts`

**Context (and explicit risk):** `runRestore` rehydrates the snapshot into a new task id and persists a `HistoryItem`, then returns a message. It currently does NOT re-enter the session because calling `controller.reinitExistingTaskFromId()` from inside `enterRestored` would run during `ContextLoader` (mid-turn) and `initTask()`'s first line is `await this.clearTask()` — tearing down the in-flight task. This task adds a SAFE re-entry via a deferred flag.

- [ ] **Step 1: Investigate the safe consumption point**

Read `AgentLoopRunner.ts` and `index.ts` for where a turn cleanly ends (after the assistant turn completes, before the next user request). Confirm `TaskState` can hold a transient field and that the controller's reinit is reachable from there. Write down the chosen consumption point. **If no clean point exists without deep surgery, STOP and report — ship Tasks 1-4 and leave this as a documented deferral (per spec §5).**

- [ ] **Step 2: Add the pending flag (TaskState)**

Add `pendingRestoreTaskId?: string` to `TaskState` (`src/core/task/TaskState.ts`). One line.

- [ ] **Step 3: Set the flag in restore**

In `snapshotCommands.ts`, `SnapshotCommandDeps` gains `requestRestoreReentry: (taskId: string) => void`. `runRestore` calls it after `enterRestored`, and the message becomes: `Restored snapshot <id> — switching to the restored session…`. In `ContextLoader`'s `runDirectCommand` wiring, implement `requestRestoreReentry` as `(id) => { this.dependencies.taskState.pendingRestoreTaskId = id }`.

- [ ] **Step 4: Consume the flag at the safe point**

At the consumption point found in Step 1, after the turn completes:

```typescript
const pending = this.taskState.pendingRestoreTaskId
if (pending) {
	this.taskState.pendingRestoreTaskId = undefined
	await this.controller.reinitExistingTaskFromId(pending)
	return
}
```

(Adapt `this.taskState` / `this.controller` to the actual accessors at that site.)

- [ ] **Step 5: Test (unit, behaviour at the command layer)**

Extend `snapshotCommands.test.ts`: a stub `requestRestoreReentry` is called with the new task id when `runRestore` succeeds; the returned message mentions switching. Update `makeDeps` to include a no-op `requestRestoreReentry`.

```typescript
	it("requests re-entry into the restored session", async () => {
		const store = new SnapshotStore(new InMemoryEnvironment("/"), "/snapshots")
		const deps = makeDeps(store)
		let reentered = ""
		deps.requestRestoreReentry = (id: string) => { reentered = id }
		await runSnapshot(deps, "x")
		const id = (await store.list())[0].id
		const out = await runRestore(deps, id)
		assert.equal(reentered, "task-restored")
		assert.match(out, /switching/i)
	})
```

- [ ] **Step 6: Run + gates**

Run: `npx cross-env TS_NODE_PROJECT=./tsconfig.unit-test.json mocha src/core/storage/snapshot/__tests__/*.ts` then `npm run check-types`.
Expected: PASS / exit 0.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(snapshot): /restore re-enters session"
```

---

## Task 6: Full gates + PR

- [ ] **Step 1: Lint** — `npm run lint` — clean.
- [ ] **Step 2: Types** — `npm run check-types` — exit 0.
- [ ] **Step 3: Root unit** — `npx cross-env TS_NODE_PROJECT=./tsconfig.unit-test.json mocha` — 0 failing.
- [ ] **Step 4: CLI** — `cd cli && CI=1 npx vitest run` — 0 failing.
- [ ] **Step 5: Push** — `git push <gitea> feat/consolidation-reliquat`
- [ ] **Step 6: PR** — Gitea API `POST .../pulls`, base `master`, title `feat: consolidation reliquat`, body = lots summary + gate results + spec/plan links.

---

## Self-Review

**Spec coverage:** Lot 1 → Task 1 (hook) + Tasks 2-3 (scrub). Lot 2 → Tasks 2-3 tests + Task 3 tracer test. Lot 3 → Task 4 (GC) + Task 5 (re-entry). Lot 4 → dropped (already done, verified). All spec §3 items mapped.

**Placeholder scan:** No TBD/TODO. The "investigate/confirm" notes (Task 5 Step 1 consumption point; Task 3 constructor signature) are genuine verify-before-edit instructions with explicit fallbacks (Task 5 has a documented deferral per spec §5), not logic gaps.

**Type consistency:** `scrubSecrets(string): string` defined Task 2, used Task 3. `SnapshotStore.prune(keep)` + `SNAPSHOT_KEEP_DEFAULT` defined/used Task 4. `pendingRestoreTaskId` (TaskState) + `requestRestoreReentry` (SnapshotCommandDeps) defined Task 5 Steps 2-3, consumed Step 4, tested Step 5. `getHookLaunchConfig` exported, returns `{command,args,shell,detached}`, consistent in Task 1.
