# LISAEL Sync Conflicts + .gitignore-aware — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** Make `SshRemoteSession` pull-back safe when the **local** workspace changed during a remote session: detect locally-modified files (vs a seed manifest) and route the remote versions through a `ConflictResolver` (default: side-dir + warn, never silent overwrite). Plus `.gitignore`-aware rsync excludes.

**Design (inline; #2.x.y, scoped):**
- **Detection:** at seed, record a manifest `{relpath: sha256}` of the local workspace (respecting excludes). At pull-back, recompute; `locallyChanged` = paths whose current hash differs from the seed manifest (or new local files).
- **Resolution seam:** `ConflictResolver(conflicts, ctx) -> Map<path, "keep-local"|"keep-remote"|"side-dir">`. **Default (non-interactive, headless-safe):** every conflict → `side-dir`. An interactive CLI resolver (summary + per-file) is a thin seam filled later — out of scope here; the safe default ships.
- **Apply:** pull remote→local **excluding** `keep-local`+`side-dir` paths (local edits survive); for `side-dir` paths fetch remote versions into `<localDir>/.isaac/pulled-<sessionId>/` + warn; `keep-remote` paths pull normally.
- **.gitignore-aware:** read `<localDir>/.gitignore` → rsync `--exclude=` entries merged with `DEFAULT_EXCLUDES`.

**Branch:** `feat/lisael-sync-conflicts` (off `436ceff`). **Gates:** `npm run test:unit` · `npm run check-types` · `npm run lint`. Core tests via `npx cross-env TS_NODE_PROJECT=./tsconfig.unit-test.json mocha "<glob>"`.

**Shell:** `export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 22 >/dev/null; cd /Users/claude2/isaac-cli`

---

## Task 1: Workspace manifest (hash + diff)

**Files:** Create `src/services/environment/remote/ssh/manifest.ts`; Test `ssh/__tests__/manifest.test.ts`.

- [ ] **Step 1: Failing test**

```ts
// src/services/environment/remote/ssh/__tests__/manifest.test.ts
import { strict as assert } from "node:assert"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, it } from "mocha"
import { buildManifest, locallyChanged } from "../manifest"

describe("workspace manifest", () => {
	let dir: string
	beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "manifest-")) })
	afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }) })

	it("detects modified + new files vs the seed manifest", async () => {
		await fs.writeFile(path.join(dir, "a.txt"), "A")
		await fs.writeFile(path.join(dir, "b.txt"), "B")
		const seed = await buildManifest(dir, [])
		await fs.writeFile(path.join(dir, "a.txt"), "A2")
		await fs.writeFile(path.join(dir, "c.txt"), "C")
		const changed = (await locallyChanged(dir, seed, [])).sort()
		assert.deepEqual(changed, ["a.txt", "c.txt"])
	})
	it("respects excludes", async () => {
		await fs.mkdir(path.join(dir, "node_modules"))
		await fs.writeFile(path.join(dir, "node_modules", "x.js"), "x")
		const m = await buildManifest(dir, ["node_modules"])
		assert.equal(Object.keys(m).some((k) => k.startsWith("node_modules/")), false)
	})
})
```

- [ ] **Step 2: Implement `manifest.ts`**

```ts
// src/services/environment/remote/ssh/manifest.ts
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"

export type Manifest = Record<string, string>

function isExcluded(rel: string, excludes: string[]): boolean {
	const top = rel.split("/")[0]
	return excludes.some((e) => e === top || e === rel || rel.startsWith(`${e}/`))
}

export async function buildManifest(dir: string, excludes: string[]): Promise<Manifest> {
	const out: Manifest = {}
	async function walk(rel: string): Promise<void> {
		let entries: import("node:fs").Dirent[]
		try {
			entries = await fs.readdir(path.join(dir, rel), { withFileTypes: true })
		} catch {
			return
		}
		for (const e of entries) {
			const childRel = rel ? `${rel}/${e.name}` : e.name
			if (isExcluded(childRel, excludes)) continue
			if (e.isDirectory()) {
				await walk(childRel)
			} else if (e.isFile()) {
				try {
					const buf = await fs.readFile(path.join(dir, childRel))
					out[childRel] = createHash("sha256").update(buf).digest("hex")
				} catch {
					// unreadable -> skip
				}
			}
		}
	}
	await walk("")
	return out
}

export async function locallyChanged(dir: string, seed: Manifest, excludes: string[]): Promise<string[]> {
	const current = await buildManifest(dir, excludes)
	const changed: string[] = []
	for (const [rel, hash] of Object.entries(current)) {
		if (seed[rel] !== hash) changed.push(rel)
	}
	return changed
}
```

- [ ] **Step 3: Run + commit**

Run: `npx cross-env TS_NODE_PROJECT=./tsconfig.unit-test.json mocha src/services/environment/remote/ssh/__tests__/manifest.test.ts` → PASS.
```bash
git add src/services/environment/remote/ssh/manifest.ts src/services/environment/remote/ssh/__tests__/manifest.test.ts
git commit -m "feat(env): workspace manifest + local-change diff"
```

---

## Task 2: `.gitignore`-aware excludes

**Files:** Modify `src/services/environment/remote/ssh/sync.ts`; Test `ssh/__tests__/sync.test.ts`.

- [ ] **Step 1: Failing test** (write a `.gitignore` with `dist\n*.log\n# comment\n` into a temp dir):

```ts
import { gitignoreExcludes } from "../sync"
it("reads .gitignore into excludes (skips comments/blanks)", async () => {
	const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "gi-"))
	await fs.writeFile(path.join(tmp, ".gitignore"), "dist\n*.log\n# comment\n\n")
	const ex = await gitignoreExcludes(tmp)
	assert.ok(ex.includes("dist") && ex.includes("*.log"))
	assert.ok(!ex.some((e) => e.startsWith("#") || e === ""))
	await fs.rm(tmp, { recursive: true, force: true })
})
```
(Add `fs/os/path` imports if absent.)

- [ ] **Step 2: Implement in `sync.ts`**

```ts
import fs from "node:fs/promises"
import path from "node:path"

export async function gitignoreExcludes(localDir: string): Promise<string[]> {
	try {
		const raw = await fs.readFile(path.join(localDir, ".gitignore"), "utf8")
		return raw.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"))
	} catch {
		return []
	}
}

export function mergeExcludes(...lists: string[][]): string[] {
	return [...new Set(lists.flat())]
}
```

- [ ] **Step 3: Run + commit**

Run: mocha `ssh/__tests__/sync.test.ts` → PASS.
```bash
git add src/services/environment/remote/ssh/sync.ts src/services/environment/remote/ssh/__tests__/sync.test.ts
git commit -m "feat(env): .gitignore-aware rsync excludes"
```

---

## Task 3: `ConflictResolver` + safe default

**Files:** Create `src/services/environment/remote/ssh/conflicts.ts`; Test `ssh/__tests__/conflicts.test.ts`.

- [ ] **Step 1: Failing test**

```ts
// src/services/environment/remote/ssh/__tests__/conflicts.test.ts
import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import { sideDirResolver } from "../conflicts"

describe("sideDirResolver", () => {
	it("routes every conflict to side-dir", async () => {
		const d = await sideDirResolver(["a.txt", "b.txt"], { sessionId: "s1" } as any)
		assert.equal(d.get("a.txt"), "side-dir")
		assert.equal(d.get("b.txt"), "side-dir")
	})
	it("empty conflicts -> empty map", async () => {
		assert.equal((await sideDirResolver([], {} as any)).size, 0)
	})
})
```

- [ ] **Step 2: Implement `conflicts.ts`**

```ts
// src/services/environment/remote/ssh/conflicts.ts
export type ConflictDecision = "keep-local" | "keep-remote" | "side-dir"
export interface ConflictContext {
	localDir: string
	remoteDir: string
	host: string
	sessionId: string
}
export type ConflictResolver = (
	conflicts: string[],
	ctx: ConflictContext,
) => Promise<Map<string, ConflictDecision>>

/** Default headless-safe resolver: never overwrite a locally-changed file; remote copy goes to a side-dir. */
export const sideDirResolver: ConflictResolver = async (conflicts) => {
	const m = new Map<string, ConflictDecision>()
	for (const c of conflicts) m.set(c, "side-dir")
	return m
}
```

- [ ] **Step 3: Run + commit**

Run: mocha `ssh/__tests__/conflicts.test.ts` → PASS.
```bash
git add src/services/environment/remote/ssh/conflicts.ts src/services/environment/remote/ssh/__tests__/conflicts.test.ts
git commit -m "feat(env): conflict resolver + safe side-dir default"
```

---

## Task 4: Wire detection + resolution into `SshRemoteSession`

**Files:** Modify `src/services/environment/remote/ssh/sync.ts` (selective-pull builders), `SshRemoteSession.ts`; Test `SshRemoteSession.test.ts`.

- [ ] **Step 1: Selective-pull rsync builders in `sync.ts`**

```ts
/** Pull remote->local but exclude specific relpaths (protect local edits). */
export function buildRsyncPullExcept(host: string, remoteDir: string, localDir: string, excludes: string[], exceptPaths: string[]): string[] {
	return ["-az", "-e", "ssh", ...excludes.map((e) => `--exclude=${e}`), ...exceptPaths.map((p) => `--exclude=/${p}`), `${host}:${remoteDir}/`, `${localDir}/`]
}
/** Fetch only specific relpaths into a side directory, preserving structure. */
export function buildRsyncPullInto(host: string, remoteDir: string, sideDir: string, paths: string[]): string[] {
	return ["-az", "-R", "-e", "ssh", ...paths.map((p) => `${host}:${remoteDir}/./${p}`), `${sideDir}/`]
}
```
> Test asserts arg shape; confirm `-R` (relative) behavior against the live rsync during the run.

- [ ] **Step 2: Wire into `SshRemoteSession`**

- Compute `this.excludes = mergeExcludes(DEFAULT_EXCLUDES, await gitignoreExcludes(localCwd))` (await in `init()` before seed, store on the instance).
- After `push()` in `init()`: `this.seedManifest = await buildManifest(localCwd, this.excludes)`.
- Add `private resolver: ConflictResolver = sideDirResolver` (overridable via `hooksOverride`-style param).
- Replace the `pull` hook body with conflict-aware logic (using the snippet from the spec): compute `locallyChanged`; if none → `buildRsyncPull`; else → `resolver` → `buildRsyncPullExcept(keepLocal+sideDir)` + `buildRsyncPullInto(sideDir)` into `<localCwd>/.isaac/pulled-<sessionId>/` + `Logger.warn`. On any conflict-detection error, **prefer not pulling** over clobbering (log + skip pull).
- Keep `gc/bootstrap/push/cleanup/makeEnv` hooks + init order (`gc,bootstrap,push`) unchanged.

- [ ] **Step 3: Test (injected)**

Extend `SshRemoteSession.test.ts`: inject `resolver` + a manifest/changed seam (or use a real temp localCwd with a modified file). Assert: no local change → plain pull; local change → resolver invoked + side-dir path taken; init order test stays green.

- [ ] **Step 4: Run + commit**

Run: `npm run test:unit` → PASS.
```bash
git add src/services/environment/remote/ssh/
git commit -m "feat(env): conflict-aware pull-back in ssh session"
```

---

## Task 5: Final gates + PR

- [ ] **Step 1:** `npm run test:unit && npm run check-types && npm run lint && node esbuild.mjs` → all PASS; default path unchanged.
- [ ] **Step 2:** `git push -u origin feat/lisael-sync-conflicts`; open PR `feat/lisael-sync-conflicts → master`, title `feat: LISAEL sync conflict detection + .gitignore`. (Scrub token after tokened HTTPS push.)

---

## Self-Review

- **Coverage:** manifest+diff (T1) ✓; .gitignore excludes (T2) ✓; resolver+safe default (T3) ✓; conflict-aware pull-back (T4) ✓; gates+PR (T5) ✓. **Deferred:** interactive CLI resolver UI (seam shipped), watch-sync (#2.x.z), remote-side change detection.
- **Placeholder scan:** T4 flags confirming rsync `-R`/exclude-path form against the live rsync; tests assert arg shape. No vague TODOs.
- **Type consistency:** `Manifest`, `ConflictResolver`/`ConflictDecision`/`ConflictContext` consistent across manifest/conflicts/SshRemoteSession; `sideDirResolver` is the default `ConflictResolver`.
- **Safety:** no-conflict path = unchanged plain pull; conflict path never overwrites locally-changed files (excluded from pull; remote copy to side-dir); detection failure prefers not-pulling over clobbering.
