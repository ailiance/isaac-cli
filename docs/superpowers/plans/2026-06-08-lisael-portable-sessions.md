# LISAEL #4 — Portable Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a snapshot/restore primitive for agent session state, exposed via `/snapshot`, `/restore`, `/sessions`, serving both temporal rollback and cross-machine migration.

**Architecture:** A snapshot is a copy of a task's four on-disk state JSON files plus a `meta.json`, addressed by a short id. A pure `SessionSnapshot` module serializes/validates the bundle; a `SnapshotStore` performs all I/O through the `Environment` interface (so the same code reaches local or remote targets); `capture`/`rehydrate` adapt between a live task directory and a bundle. Slash commands are thin wiring that call these and return a direct response.

**Tech Stack:** TypeScript (strict), mocha + ts-node (root unit tests, co-located `__tests__/`), biome, the existing `Environment` abstraction (`src/services/environment/`) and storage helpers (`src/core/storage/disk.ts`).

**Spec:** `docs/superpowers/specs/2026-06-08-lisael-portable-sessions-design.md`

---

## File Structure

| File | Responsibility |
|------|----------------|
| `src/core/storage/snapshot/SessionSnapshot.ts` | Bundle types, `SNAPSHOT_SCHEMA_VERSION`, `SNAPSHOT_FILES`, `SnapshotError`, pure `serialize` / `deserialize` (validation). No I/O. |
| `src/core/storage/snapshot/SnapshotStore.ts` | `SnapshotStore` class: `save` / `list` / `load`, all I/O via an injected `Environment`. |
| `src/core/storage/snapshot/capture.ts` | `captureSnapshot`: read a live task dir's state files (local fs) → `SnapshotBundle`. |
| `src/core/storage/snapshot/restore.ts` | `rehydrate`: write a bundle's files into a (new) task dir atomically → returns taskId. |
| `src/core/storage/disk.ts` | Add exported helpers `writeTaskStateFile` / `readTaskStateFile` / `ensureSnapshotsDirectoryExists` (atomic raw I/O + snapshots root). |
| `src/core/storage/snapshot/snapshotCommands.ts` | Pure command logic: `runSnapshot` / `runSessions` / `runRestore` returning the direct-response string. |
| `src/core/slash-commands/index.ts` | Register `snapshot` / `restore` / `sessions` as direct-response commands. |
| `__tests__/` (co-located) | One test file per module above. |

Each module has a single responsibility and a narrow interface. `SessionSnapshot` is pure data; `SnapshotStore` is the only `Environment` I/O; `capture`/`restore` are the only task-dir adapters; `snapshotCommands` is pure orchestration over injected deps; the slash-commands change is wiring only.

---

## Task 1: `SessionSnapshot` — pure serialize/deserialize

**Files:**
- Create: `src/core/storage/snapshot/SessionSnapshot.ts`
- Test: `src/core/storage/snapshot/__tests__/SessionSnapshot.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import { GlobalFileNames } from "../../disk"
import {
	deserialize,
	serialize,
	SNAPSHOT_SCHEMA_VERSION,
	SnapshotError,
	type SnapshotMeta,
} from "../SessionSnapshot"

const META: SnapshotMeta = {
	id: "snap_abc12345",
	label: "before refactor",
	sourceTaskId: "task-1",
	createdAt: "2026-06-08T10:00:00.000Z",
	env: "local",
	schemaVersion: SNAPSHOT_SCHEMA_VERSION,
}

const FILES = {
	[GlobalFileNames.apiConversationHistory]: "[]",
	[GlobalFileNames.contextHistory]: "{}",
	[GlobalFileNames.uiMessages]: "[]",
	[GlobalFileNames.taskMetadata]: '{"files_in_context":[]}',
}

describe("SessionSnapshot", () => {
	it("round-trips serialize → deserialize to an identical bundle", () => {
		const bundle = serialize(META, FILES)
		const raw = JSON.parse(JSON.stringify(bundle)) // simulate disk round-trip
		const back = deserialize(raw)
		assert.deepEqual(back.meta, META)
		assert.deepEqual(back.files, FILES)
	})

	it("rejects an unknown schemaVersion", () => {
		const bundle = serialize({ ...META, schemaVersion: 999 }, FILES)
		const raw = JSON.parse(JSON.stringify(bundle))
		assert.throws(() => deserialize(raw), SnapshotError)
	})

	it("rejects a bundle missing the meta block", () => {
		assert.throws(() => deserialize({ files: FILES }), SnapshotError)
	})
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx cross-env TS_NODE_PROJECT=./tsconfig.unit-test.json mocha src/core/storage/snapshot/__tests__/SessionSnapshot.test.ts`
Expected: FAIL — `Cannot find module '../SessionSnapshot'`.

- [ ] **Step 3: Write the minimal implementation**

```typescript
// src/core/storage/snapshot/SessionSnapshot.ts
import { GlobalFileNames } from "../disk"

/** Bump on any change to SnapshotBundle shape. */
export const SNAPSHOT_SCHEMA_VERSION = 1

/** Canonical state files captured in a snapshot, in stable order. */
export const SNAPSHOT_FILES: readonly string[] = [
	GlobalFileNames.apiConversationHistory,
	GlobalFileNames.contextHistory,
	GlobalFileNames.uiMessages,
	GlobalFileNames.taskMetadata,
]

export interface SnapshotMeta {
	id: string
	label: string
	sourceTaskId: string
	createdAt: string
	env: string
	schemaVersion: number
}

/** Canonical filename → raw JSON file contents. */
export type SnapshotFiles = Record<string, string>

export interface SnapshotBundle {
	meta: SnapshotMeta
	files: SnapshotFiles
}

/** Typed error so callers can distinguish snapshot failures from generic I/O. */
export class SnapshotError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "SnapshotError"
	}
}

export function serialize(meta: SnapshotMeta, files: SnapshotFiles): SnapshotBundle {
	return { meta: { ...meta }, files: { ...files } }
}

export function deserialize(raw: unknown): SnapshotBundle {
	if (typeof raw !== "object" || raw === null) {
		throw new SnapshotError("snapshot is not an object")
	}
	const obj = raw as Record<string, unknown>
	const meta = obj.meta as SnapshotMeta | undefined
	const files = obj.files as SnapshotFiles | undefined
	if (!meta || typeof meta !== "object") {
		throw new SnapshotError("snapshot is missing the meta block")
	}
	if (!files || typeof files !== "object") {
		throw new SnapshotError("snapshot is missing the files block")
	}
	if (meta.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
		throw new SnapshotError(
			`unsupported snapshot schemaVersion ${meta.schemaVersion} (expected ${SNAPSHOT_SCHEMA_VERSION})`,
		)
	}
	return { meta, files }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx cross-env TS_NODE_PROJECT=./tsconfig.unit-test.json mocha src/core/storage/snapshot/__tests__/SessionSnapshot.test.ts`
Expected: PASS (3 passing).

- [ ] **Step 5: Commit**

```bash
git add src/core/storage/snapshot/SessionSnapshot.ts src/core/storage/snapshot/__tests__/SessionSnapshot.test.ts
git commit -m "feat(snapshot): SessionSnapshot serialize/deserialize"
```

---

## Task 2: `SnapshotStore` over `Environment`

**Files:**
- Create: `src/core/storage/snapshot/SnapshotStore.ts`
- Test: `src/core/storage/snapshot/__tests__/SnapshotStore.test.ts`

The store treats `root` as a directory under which each snapshot lives at `<root>/<id>/`. It uses only `Environment` methods (`mkdir`, `writeFile`, `readFile`, `exists`, `list`) so it works against `InMemoryEnvironment`, `LocalEnvironment`, or `RemoteEnvironment` unchanged.

- [ ] **Step 1: Write the failing test**

```typescript
import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import { InMemoryEnvironment } from "@services/environment/InMemoryEnvironment"
import { GlobalFileNames } from "../../disk"
import { serialize, SNAPSHOT_SCHEMA_VERSION, SnapshotError, type SnapshotMeta } from "../SessionSnapshot"
import { SnapshotStore } from "../SnapshotStore"

function bundle(id: string, label: string) {
	const meta: SnapshotMeta = {
		id,
		label,
		sourceTaskId: "task-1",
		createdAt: "2026-06-08T10:00:00.000Z",
		env: "local",
		schemaVersion: SNAPSHOT_SCHEMA_VERSION,
	}
	return serialize(meta, {
		[GlobalFileNames.apiConversationHistory]: "[]",
		[GlobalFileNames.contextHistory]: "{}",
		[GlobalFileNames.uiMessages]: "[]",
		[GlobalFileNames.taskMetadata]: "{}",
	})
}

describe("SnapshotStore", () => {
	it("saves then loads an identical bundle", async () => {
		const env = new InMemoryEnvironment("/")
		const store = new SnapshotStore(env, "/snapshots")
		await store.save(bundle("snap_a", "first"))
		const loaded = await store.load("snap_a")
		assert.equal(loaded.meta.label, "first")
		assert.equal(loaded.files[GlobalFileNames.apiConversationHistory], "[]")
	})

	it("lists saved snapshots' metas", async () => {
		const env = new InMemoryEnvironment("/")
		const store = new SnapshotStore(env, "/snapshots")
		await store.save(bundle("snap_a", "first"))
		await store.save(bundle("snap_b", "second"))
		const metas = await store.list()
		const labels = metas.map((m) => m.label).sort()
		assert.deepEqual(labels, ["first", "second"])
	})

	it("throws SnapshotError loading a missing id", async () => {
		const env = new InMemoryEnvironment("/")
		const store = new SnapshotStore(env, "/snapshots")
		await assert.rejects(() => store.load("nope"), SnapshotError)
	})
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx cross-env TS_NODE_PROJECT=./tsconfig.unit-test.json mocha src/core/storage/snapshot/__tests__/SnapshotStore.test.ts`
Expected: FAIL — `Cannot find module '../SnapshotStore'`.

- [ ] **Step 3: Write the minimal implementation**

```typescript
// src/core/storage/snapshot/SnapshotStore.ts
import type { Environment } from "@services/environment/types"
import { deserialize, serialize, SnapshotError, type SnapshotBundle, type SnapshotMeta } from "./SessionSnapshot"

const META_FILE = "meta.json"

export class SnapshotStore {
	constructor(
		private readonly env: Environment,
		private readonly root: string,
	) {}

	private dir(id: string): string {
		return `${this.root}/${id}`
	}

	async save(bundle: SnapshotBundle): Promise<void> {
		const dir = this.dir(bundle.meta.id)
		await this.env.mkdir(dir, { recursive: true })
		await this.env.writeFile(`${dir}/${META_FILE}`, JSON.stringify(bundle.meta, null, 2))
		for (const [name, content] of Object.entries(bundle.files)) {
			await this.env.writeFile(`${dir}/${name}`, content)
		}
	}

	async list(): Promise<SnapshotMeta[]> {
		if (!(await this.env.exists(this.root))) {
			return []
		}
		const entries = await this.env.list(this.root)
		const metas: SnapshotMeta[] = []
		for (const entry of entries) {
			const metaPath = `${this.dir(entry.name)}/${META_FILE}`
			if (await this.env.exists(metaPath)) {
				metas.push(JSON.parse(await this.env.readFile(metaPath)) as SnapshotMeta)
			}
		}
		return metas
	}

	async load(id: string): Promise<SnapshotBundle> {
		const dir = this.dir(id)
		const metaPath = `${dir}/${META_FILE}`
		if (!(await this.env.exists(metaPath))) {
			throw new SnapshotError(`snapshot ${id} not found`)
		}
		const meta = JSON.parse(await this.env.readFile(metaPath)) as SnapshotMeta
		const files: Record<string, string> = {}
		const entries = await this.env.list(dir)
		for (const entry of entries) {
			if (entry.name === META_FILE) {
				continue
			}
			files[entry.name] = await this.env.readFile(`${dir}/${entry.name}`)
		}
		// Re-validate via deserialize so schemaVersion is enforced on read.
		return deserialize(serialize(meta, files))
	}
}
```

> **Note on `DirEntry`:** `env.list` returns `DirEntry[]` with a `name` field (see `src/services/environment/types.ts:12`). If the field name differs, adjust `entry.name` accordingly — confirm against the interface before writing the implementation.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx cross-env TS_NODE_PROJECT=./tsconfig.unit-test.json mocha src/core/storage/snapshot/__tests__/SnapshotStore.test.ts`
Expected: PASS (3 passing).

- [ ] **Step 5: Commit**

```bash
git add src/core/storage/snapshot/SnapshotStore.ts src/core/storage/snapshot/__tests__/SnapshotStore.test.ts
git commit -m "feat(snapshot): SnapshotStore over Environment"
```

---

## Task 3: `capture` + `rehydrate` (task-dir adapters)

**Files:**
- Modify: `src/core/storage/disk.ts` (add `writeTaskStateFile`, `readTaskStateFile`)
- Create: `src/core/storage/snapshot/capture.ts`
- Create: `src/core/storage/snapshot/restore.ts`
- Test: `src/core/storage/snapshot/__tests__/captureRestore.test.ts`

`capture` reads a live (local) task directory's four state files into a bundle. `rehydrate` writes a bundle's files into a (new) task directory using an atomic writer, returning the new taskId. Both go through `ensureTaskDirectoryExists` so paths match the rest of storage.

- [ ] **Step 1: Add the atomic raw-I/O helpers to `disk.ts`**

In `src/core/storage/disk.ts`, after `saveTaskMetadata` (around line 336), add:

```typescript
/**
 * Atomically write a raw state file into a task directory. Used by snapshot
 * restore to rehydrate captured JSON files without re-parsing their typed
 * shapes. Mirrors the temp+rename guarantee of the typed save* helpers.
 */
export async function writeTaskStateFile(taskId: string, fileName: string, data: string): Promise<void> {
	const filePath = path.join(await ensureTaskDirectoryExists(taskId), fileName)
	await atomicWriteFile(filePath, data)
}

/** Read a raw state file from a task directory, or undefined if absent. */
export async function readTaskStateFile(taskId: string, fileName: string): Promise<string | undefined> {
	const filePath = path.join(await ensureTaskDirectoryExists(taskId), fileName)
	if (await fileExistsAtPath(filePath)) {
		return fs.readFile(filePath, "utf8")
	}
	return undefined
}
```

- [ ] **Step 2: Write the failing test**

```typescript
import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import { GlobalFileNames, getSavedApiConversationHistory, saveApiConversationHistory } from "../../disk"
import { captureSnapshot } from "../capture"
import { rehydrate } from "../restore"

describe("capture + rehydrate", () => {
	it("captures a task's state and rehydrates it into a new task id", async () => {
		const sourceTaskId = "cap-src-portable-test"
		await saveApiConversationHistory(sourceTaskId, [{ role: "user", content: "hello" }])

		let counter = 0
		const bundle = await captureSnapshot(sourceTaskId, "lbl", "local", () => `snap_test${counter++}`)
		assert.equal(bundle.meta.sourceTaskId, sourceTaskId)
		assert.equal(bundle.meta.label, "lbl")
		assert.ok(bundle.files[GlobalFileNames.apiConversationHistory].includes("hello"))

		const newTaskId = "cap-dst-portable-test"
		const returned = await rehydrate(bundle, newTaskId)
		assert.equal(returned, newTaskId)
		const restored = await getSavedApiConversationHistory(newTaskId)
		assert.equal(restored.length, 1)
	})
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx cross-env TS_NODE_PROJECT=./tsconfig.unit-test.json mocha src/core/storage/snapshot/__tests__/captureRestore.test.ts`
Expected: FAIL — `Cannot find module '../capture'`.

- [ ] **Step 4: Implement `capture.ts`**

```typescript
// src/core/storage/snapshot/capture.ts
import { readTaskStateFile } from "../disk"
import {
	serialize,
	SNAPSHOT_FILES,
	SNAPSHOT_SCHEMA_VERSION,
	type SnapshotBundle,
	type SnapshotFiles,
} from "./SessionSnapshot"

/**
 * Read a live task's state files into a portable bundle. `idgen` returns a
 * fresh snapshot id (injected for testability). `envLabel` records provenance.
 * `now` is injectable so tests can pin createdAt.
 */
export async function captureSnapshot(
	taskId: string,
	label: string,
	envLabel: string,
	idgen: () => string,
	now: () => string = () => new Date().toISOString(),
): Promise<SnapshotBundle> {
	const files: SnapshotFiles = {}
	for (const name of SNAPSHOT_FILES) {
		const content = await readTaskStateFile(taskId, name)
		if (content !== undefined) {
			files[name] = content
		}
	}
	return serialize(
		{
			id: idgen(),
			label,
			sourceTaskId: taskId,
			createdAt: now(),
			env: envLabel,
			schemaVersion: SNAPSHOT_SCHEMA_VERSION,
		},
		files,
	)
}
```

- [ ] **Step 5: Implement `restore.ts`**

```typescript
// src/core/storage/snapshot/restore.ts
import { writeTaskStateFile } from "../disk"
import type { SnapshotBundle } from "./SessionSnapshot"

/**
 * Write a bundle's captured state files into `targetTaskId`'s directory,
 * atomically per file, and return that taskId for the resume path to consume.
 * The caller chooses a fresh taskId (rollback → new task).
 */
export async function rehydrate(bundle: SnapshotBundle, targetTaskId: string): Promise<string> {
	for (const [name, content] of Object.entries(bundle.files)) {
		await writeTaskStateFile(targetTaskId, name, content)
	}
	return targetTaskId
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx cross-env TS_NODE_PROJECT=./tsconfig.unit-test.json mocha src/core/storage/snapshot/__tests__/captureRestore.test.ts`
Expected: PASS (1 passing).

- [ ] **Step 7: Commit**

```bash
git add src/core/storage/disk.ts src/core/storage/snapshot/capture.ts src/core/storage/snapshot/restore.ts src/core/storage/snapshot/__tests__/captureRestore.test.ts
git commit -m "feat(snapshot): capture + rehydrate task state"
```

---

## Task 4: Slash command logic + wiring

**Files:**
- Create: `src/core/storage/snapshot/snapshotCommands.ts`
- Test: `src/core/storage/snapshot/__tests__/snapshotCommands.test.ts`
- Modify: `src/core/slash-commands/index.ts`, `src/shared/slashCommands.ts`, `src/core/storage/disk.ts`

Command logic is a set of pure functions over injected deps (store + capture/rehydrate + ids + taskId), each returning the user-facing string. This keeps them fully unit-testable without the task runtime. Steps 5–6 wire them into `parseSlashCommands` as direct-response commands (the `isDirectResponse` / `directResponseText` return already exists — see `src/core/slash-commands/index.ts` and its caller `src/core/task/ContextLoader.ts:351`).

- [ ] **Step 1: Write the failing test**

```typescript
import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import { InMemoryEnvironment } from "@services/environment/InMemoryEnvironment"
import { GlobalFileNames } from "../../disk"
import { serialize, SNAPSHOT_SCHEMA_VERSION, type SnapshotBundle } from "../SessionSnapshot"
import { SnapshotStore } from "../SnapshotStore"
import { runRestore, runSessions, runSnapshot, type SnapshotCommandDeps } from "../snapshotCommands"

function makeDeps(store: SnapshotStore): SnapshotCommandDeps {
	let n = 0
	return {
		store,
		taskId: "task-1",
		envLabel: "local",
		newId: () => `snap_id${n++}`,
		capture: async (taskId, label, envLabel, idgen) =>
			serialize(
				{
					id: idgen(),
					label,
					sourceTaskId: taskId,
					createdAt: "2026-06-08T10:00:00.000Z",
					env: envLabel,
					schemaVersion: SNAPSHOT_SCHEMA_VERSION,
				},
				{ [GlobalFileNames.apiConversationHistory]: "[]" },
			),
		rehydrate: async (_b: SnapshotBundle, target: string) => target,
		newTaskId: () => "task-restored",
	}
}

describe("snapshotCommands", () => {
	it("runSnapshot saves a bundle and reports its id", async () => {
		const store = new SnapshotStore(new InMemoryEnvironment("/"), "/snapshots")
		const out = await runSnapshot(makeDeps(store), "before refactor")
		assert.match(out, /snap_id0/)
		const metas = await store.list()
		assert.equal(metas.length, 1)
		assert.equal(metas[0].label, "before refactor")
	})

	it("runSessions lists saved snapshots", async () => {
		const store = new SnapshotStore(new InMemoryEnvironment("/"), "/snapshots")
		const deps = makeDeps(store)
		await runSnapshot(deps, "first")
		const out = await runSessions(deps)
		assert.match(out, /first/)
	})

	it("runRestore on a missing id reports a friendly error, not a throw", async () => {
		const store = new SnapshotStore(new InMemoryEnvironment("/"), "/snapshots")
		const out = await runRestore(makeDeps(store), "missing")
		assert.match(out, /not found/i)
	})
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx cross-env TS_NODE_PROJECT=./tsconfig.unit-test.json mocha src/core/storage/snapshot/__tests__/snapshotCommands.test.ts`
Expected: FAIL — `Cannot find module '../snapshotCommands'`.

- [ ] **Step 3: Implement `snapshotCommands.ts`**

```typescript
// src/core/storage/snapshot/snapshotCommands.ts
import type { captureSnapshot } from "./capture"
import type { rehydrate } from "./restore"
import { SnapshotError, type SnapshotBundle } from "./SessionSnapshot"
import type { SnapshotStore } from "./SnapshotStore"

export interface SnapshotCommandDeps {
	store: SnapshotStore
	taskId: string
	envLabel: string
	newId: () => string
	capture: typeof captureSnapshot
	rehydrate: typeof rehydrate
	newTaskId: () => string
}

export async function runSnapshot(deps: SnapshotCommandDeps, label: string): Promise<string> {
	const bundle = await deps.capture(deps.taskId, label || "(unlabeled)", deps.envLabel, deps.newId)
	await deps.store.save(bundle)
	return `Snapshot ${bundle.meta.id} saved${label ? ` ("${label}")` : ""}.`
}

export async function runSessions(deps: SnapshotCommandDeps): Promise<string> {
	const metas = await deps.store.list()
	if (metas.length === 0) {
		return "No snapshots yet. Use /snapshot [label] to create one."
	}
	const rows = metas
		.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
		.map((m) => `  ${m.id}  ${m.label}  ${m.createdAt}  ${m.env}`)
		.join("\n")
	return `Snapshots:\n${rows}`
}

export async function runRestore(deps: SnapshotCommandDeps, id: string): Promise<string> {
	if (!id) {
		return "Usage: /restore <snapshot-id>"
	}
	let bundle: SnapshotBundle
	try {
		bundle = await deps.store.load(id)
	} catch (error) {
		if (error instanceof SnapshotError) {
			return `Cannot restore: ${error.message}`
		}
		throw error
	}
	const target = deps.newTaskId()
	await deps.rehydrate(bundle, target)
	return `Restored snapshot ${id} into a new session (${target}).`
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx cross-env TS_NODE_PROJECT=./tsconfig.unit-test.json mocha src/core/storage/snapshot/__tests__/snapshotCommands.test.ts`
Expected: PASS (3 passing).

- [ ] **Step 5: Add the snapshots-root helper to `disk.ts`**

In `src/core/storage/disk.ts`, after `ensureStateDirectoryExists` (line ~338), add:

```typescript
export async function ensureSnapshotsDirectoryExists(): Promise<string> {
	return getGlobalStorageDir("snapshots")
}
```

- [ ] **Step 6: Wire the commands into `parseSlashCommands`**

In `src/core/slash-commands/index.ts`:

1. Add `"snapshot"`, `"restore"`, `"sessions"` to `SUPPORTED_DEFAULT_COMMANDS` (line ~58).
2. These are **direct-response** commands. Mirror the nearest existing command that returns `isDirectResponse: true` / `directResponseText` (the return shape consumed at `src/core/task/ContextLoader.ts:351`). In the handler, build `SnapshotCommandDeps`:
   - `taskId` — the active task id available in `ContextLoader`.
   - `envLabel` — the resolved `Environment.id` (e.g. `"local"`, `"memory"`).
   - `store` — `new SnapshotStore(localEnvironment, await ensureSnapshotsDirectoryExists())` (use the local `Environment` for now; remote targets are a later step).
   - `newId` — `() => "snap_" + randomUUID().slice(0, 8)` (import `randomUUID` from `node:crypto`, as `disk.ts` already does).
   - `capture` / `rehydrate` — the functions from Task 3.
   - `newTaskId` — `() => randomUUID()` (matches how task ids are generated elsewhere).
   Then call `runSnapshot(deps, arg)` / `runSessions(deps)` / `runRestore(deps, arg)` where `arg` is the text after the command, and return the string as `directResponseText`.

> Confirm the exact `isDirectResponse` return object shape and the `ContextLoader` dispatch branch before editing — copy the nearest existing direct-response command rather than inventing a new return contract.

3. Add the command descriptions to `src/shared/slashCommands.ts` (alongside the existing `SlashCommand` entries) so they surface in the UI:

```typescript
{ name: "snapshot", description: "Save a restorable snapshot of this session" },
{ name: "restore", description: "Restore a session from a snapshot id" },
{ name: "sessions", description: "List saved session snapshots" },
```

- [ ] **Step 7: Run the full root unit suite**

Run: `npx cross-env TS_NODE_PROJECT=./tsconfig.unit-test.json mocha`
Expected: PASS — prior count (1348) plus the new snapshot tests, 0 failing.

- [ ] **Step 8: Commit**

```bash
git add src/core/storage/snapshot/snapshotCommands.ts src/core/storage/snapshot/__tests__/snapshotCommands.test.ts src/core/slash-commands/index.ts src/shared/slashCommands.ts src/core/storage/disk.ts
git commit -m "feat(snapshot): /snapshot /restore /sessions commands"
```

---

## Task 5: Full gates + PR

**Files:** none (verification + PR only)

- [ ] **Step 1: Lint** — Run (repo root): `npm run lint` — Expected: clean.
- [ ] **Step 2: Type-check** — Run (repo root): `npm run check-types` — Expected: exit 0.
- [ ] **Step 3: Root unit tests** — Run (repo root): `npx cross-env TS_NODE_PROJECT=./tsconfig.unit-test.json mocha` — Expected: all passing, 0 failing.
- [ ] **Step 4: CLI tests (regression)** — Run: `cd cli && CI=1 npx vitest run` — Expected: all passing (559 baseline).
- [ ] **Step 5: Push the branch**

```bash
git push https://clems:<TOKEN>@git.saillant.cc/ailiance/isaac-cli.git feat/lisael-portable-sessions
```

- [ ] **Step 6: Open the PR via the Gitea API**

`POST https://git.saillant.cc/api/v1/repos/ailiance/isaac-cli/pulls` with header `Authorization: token <TOKEN>` and body:
`{ "title": "feat(memory): LISAEL #4 portable sessions", "head": "feat/lisael-portable-sessions", "base": "master", "body": "<summary + gate results + spec link>" }`

---

## Self-Review

**Spec coverage** — every spec section maps to a task:
- §3 architecture / §4 components → Tasks 1–4 (one module each).
- §5 snapshot shape (`meta.json` + 4 state files) → Task 2 (`save`/`load`) + Task 1 (`SNAPSHOT_FILES`).
- §6 data flow (`/snapshot`, `/sessions`, `/restore`) → Task 4.
- §7 error handling: missing/corrupt → Task 2 (`SnapshotError`) + Task 4 (`runRestore` friendly error); schema mismatch → Task 1 (`deserialize`); atomic rehydrate → Task 3 (`writeTaskStateFile` via `atomicWriteFile`); cross-env write failure leaves source intact → inherent (capture reads local, save writes to target; a failed save never touches the source task dir).
- §8 testing → tests in every task; capture↔restore round-trip in Task 3; command paths in Task 4.
- §9 risks: state-machine-implicit → captured files only, documented in spec; `snapId` scheme → `newId` = `snap_` + `randomUUID().slice(0,8)` (Task 4 Step 6); GC → out of scope; secrets → files copied as-is under the existing 0600 model (`saveApiConversationHistory` writes 0600; `writeTaskStateFile` preserves content verbatim).

**Placeholder scan** — `<TOKEN>` in Task 5 is a deliberate secret placeholder supplied at execution, not a logic gap. The one "confirm before editing" note (Task 4 Step 6, direct-response return shape) gives the exact file:line to mirror; it is a verification instruction, not a TODO.

**Type consistency** — `SnapshotMeta`, `SnapshotFiles`, `SnapshotBundle`, `SnapshotError`, `SNAPSHOT_SCHEMA_VERSION`, `SNAPSHOT_FILES` defined in Task 1, used unchanged in Tasks 2–4. `SnapshotStore.save/list/load` consistent across Tasks 2 and 4. `captureSnapshot` / `rehydrate` signatures from Task 3 referenced by `typeof` in Task 4's `SnapshotCommandDeps`, so they cannot drift.
