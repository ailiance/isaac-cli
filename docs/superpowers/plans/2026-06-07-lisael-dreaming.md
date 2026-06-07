# LISAEL Dreaming (background memory consolidation) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A background worker ("dreaming") that consolidates new run transcripts into structured memory entries (project + user scope) in the existing memory store, so future sessions auto-load relevant context. Quality is iterated by use; this plan proves the pipeline with a mocked LLM.

**Architecture:** `DreamWorker` (SyncWorker-pattern idle loop) reads un-consolidated runs via a per-project cursor → `MemorySynthesizer` (one injected LLM pass) → dedup/merge/freshness → `saveMemory` (existing store, extended frontmatter). Reinjection is already wired (`loadRelevantMemories` in `PromptBuilder`), so writing to the store is enough. All new units take **injected dependencies** so tests need no module mocking.

**Tech Stack:** TypeScript strict, Node fs, `src/utils/ailiance-memory.ts` store, `src/core/tracing` trace format, `buildApiHandler` (`@core/api`), `SyncWorker` pattern. Tests: mocha + `node:assert/strict` (core); vitest for the existing memory store test.

**Spec:** `docs/superpowers/specs/2026-06-07-lisael-dreaming-design.md`
**Branch:** `feat/lisael-dreaming` (off #2.x tip `6514afd`)

**Gates:** `npm run test:unit` · `npm run check-types` · `npm run lint`. Core tests: `npx cross-env TS_NODE_PROJECT=./tsconfig.unit-test.json mocha "<glob>"`.

**Shell setup:**
```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 22 >/dev/null; cd /Users/claude2/isaac-cli
```

**Reference (verified facts):**
- Store `src/utils/ailiance-memory.ts`: `saveMemory(entry)`, `listMemories({scope?,type?})`, `deleteMemory(name,scope)`, `projectScopeFromCwd(cwd)`; frontmatter `name, description, type, scope, created`; files `~/.ailiance-agent/memory/<name>.md` + `…/project_<slug>/<name>.md`.
- Trace: `<cwd>/.ailiance-agent/runs/<taskId>/{trace.jsonl,meta.json}` (`src/core/tracing/JsonlTracer.ts`).
- LLM: `buildApiHandler(config, mode).createMessage(systemPrompt, [{role:"user",content}])` → async-generator of `{type:"text",text}|…`. Off-task pattern: `cli/src/agent/review.ts:277`.
- Background: `SyncWorker` (`src/shared/services/worker/worker.ts`).

---

## File Structure

**Created** under `src/services/memory/dreaming/`: `types.ts`, `corpusCursor.ts`, `transcriptReader.ts`, `MemorySynthesizer.ts`, `DreamWorker.ts`, `wire.ts`, `index.ts`, `__tests__/{corpusCursor,transcriptReader,MemorySynthesizer,DreamWorker}.test.ts`.
**Modified:** `src/utils/ailiance-memory.ts` (frontmatter `source`/`lastSeenAt`), `src/common.ts` (start/stop worker, gated).

---

## Task 1: Extend memory frontmatter (`source`, `lastSeenAt`) — backward compatible

**Files:** Modify `src/utils/ailiance-memory.ts`; Test: extend `cli/src/utils/__tests__/ailiance-memory.test.ts` (existing vitest suite for this store).

- [ ] **Step 1: Read the current frontmatter parse/serialize**

Run: `rg -n "created|interface|---|scope:" src/utils/ailiance-memory.ts | head -40`
Identify the entry interface, the serialize block (~L164-175), the parse regex (~L89) + field extraction (~L40-46).

- [ ] **Step 2: Add a failing test (round-trip new fields + legacy)**

In the existing vitest memory test (match its `expect`/import style):
```ts
it("round-trips optional source + lastSeenAt and tolerates legacy entries", async () => {
	await saveMemory({ name: "dreamed-fact", description: "x", type: "project", scope: "global", body: "b", source: "dreamed", lastSeenAt: "2026-06-07T00:00:00.000Z" } as any)
	const m: any = (await listMemories({})).find((e: any) => e.name === "dreamed-fact")
	expect(m.source).toBe("dreamed")
	expect(m.lastSeenAt).toBe("2026-06-07T00:00:00.000Z")
	await saveMemory({ name: "human-fact", description: "y", type: "user", scope: "global", body: "b2" } as any)
	const h: any = (await listMemories({})).find((e: any) => e.name === "human-fact")
	expect(h.source).toBeUndefined()
})
```

- [ ] **Step 3: Extend the entry type + serialize + parse**

Add optional `source?: "dreamed"` and `lastSeenAt?: string` to the memory entry interface. In the serializer, emit `source:` / `lastSeenAt:` lines **only when present**. In the parser, read them if present (absent → undefined). Keep all existing fields/behavior identical.

- [ ] **Step 4: Run**

Run: `cd cli && CI=1 npx vitest run src/utils/__tests__/ailiance-memory.test.ts` then `cd .. && npm run check-types`
Expected: PASS (new + existing).

- [ ] **Step 5: Commit**

```bash
git add src/utils/ailiance-memory.ts cli/src/utils/__tests__/ailiance-memory.test.ts
git commit -m "feat(memory): optional source + lastSeenAt frontmatter"
```

---

## Task 2: `types.ts` + `corpusCursor.ts`

**Files:** Create `src/services/memory/dreaming/types.ts`, `corpusCursor.ts`; Test `__tests__/corpusCursor.test.ts`.

- [ ] **Step 1: Types**

```ts
// src/services/memory/dreaming/types.ts
export interface DreamCursor {
	processed: Record<string, string[]> // projectKey -> taskIds
}
export interface MemoryCandidate {
	scope: "global" | string // "global" | `project:<slug>`
	type: "project" | "user" | "feedback" | "reference"
	name: string
	description: string
	body: string
}
```

- [ ] **Step 2: Failing test**

```ts
// src/services/memory/dreaming/__tests__/corpusCursor.test.ts
import { strict as assert } from "node:assert"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, it } from "mocha"
import { isProcessed, loadCursor, markProcessed, saveCursor } from "../corpusCursor"

describe("dream corpus cursor", () => {
	let dir: string
	beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "dream-cur-")) })
	afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }) })

	it("marks tasks processed and persists", async () => {
		const file = path.join(dir, "cursor.json")
		let cur = await loadCursor(file)
		assert.deepEqual(cur.processed, {})
		cur = markProcessed(cur, "proj-a", "task1")
		await saveCursor(file, cur)
		const reloaded = await loadCursor(file)
		assert.ok(isProcessed(reloaded, "proj-a", "task1"))
	})
	it("tolerates a missing/corrupt cursor file", async () => {
		assert.deepEqual((await loadCursor(path.join(dir, "nope.json"))).processed, {})
	})
})
```

- [ ] **Step 3: Implement `corpusCursor.ts`**

```ts
// src/services/memory/dreaming/corpusCursor.ts
import fs from "node:fs/promises"
import path from "node:path"
import type { DreamCursor } from "./types"

export async function loadCursor(file: string): Promise<DreamCursor> {
	try {
		const parsed = JSON.parse(await fs.readFile(file, "utf8"))
		if (parsed && typeof parsed === "object" && parsed.processed) return parsed as DreamCursor
	} catch {
		// missing or corrupt -> fresh
	}
	return { processed: {} }
}

export async function saveCursor(file: string, cursor: DreamCursor): Promise<void> {
	await fs.mkdir(path.dirname(file), { recursive: true })
	const tmp = `${file}.tmp`
	await fs.writeFile(tmp, JSON.stringify(cursor, null, 2), "utf8")
	await fs.rename(tmp, file)
}

export function markProcessed(cursor: DreamCursor, projectKey: string, taskId: string): DreamCursor {
	const list = [...(cursor.processed[projectKey] ?? [])]
	if (!list.includes(taskId)) list.push(taskId)
	return { processed: { ...cursor.processed, [projectKey]: list } }
}

export function isProcessed(cursor: DreamCursor, projectKey: string, taskId: string): boolean {
	return (cursor.processed[projectKey] ?? []).includes(taskId)
}
```

- [ ] **Step 4: Run + commit**

Run: `npx cross-env TS_NODE_PROJECT=./tsconfig.unit-test.json mocha src/services/memory/dreaming/__tests__/corpusCursor.test.ts` → PASS.
```bash
git add src/services/memory/dreaming/types.ts src/services/memory/dreaming/corpusCursor.ts src/services/memory/dreaming/__tests__/corpusCursor.test.ts
git commit -m "feat(memory): dream corpus cursor"
```

---

## Task 3: `transcriptReader.ts`

**Files:** Create `src/services/memory/dreaming/transcriptReader.ts`; Test `__tests__/transcriptReader.test.ts`.

- [ ] **Step 1: Failing test**

```ts
// src/services/memory/dreaming/__tests__/transcriptReader.test.ts
import { strict as assert } from "node:assert"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, it } from "mocha"
import { condenseRun } from "../transcriptReader"

describe("transcriptReader.condenseRun", () => {
	let dir: string
	beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "dream-run-")) })
	afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }) })

	it("condenses trace + meta, skipping corrupt lines", async () => {
		await fs.writeFile(path.join(dir, "meta.json"), JSON.stringify({ task: "add feature X", cwd: "/repo", exit_reason: "completed" }))
		await fs.writeFile(path.join(dir, "trace.jsonl"),
			`{"turn":1,"phase":"execute","tool_execution":{"tool_name":"write_to_file","success":true}}\nNOT_JSON\n{"turn":2,"phase":"execute","errors":["boom"]}\n`)
		const text = await condenseRun(dir)
		assert.match(text, /add feature X/)
		assert.match(text, /write_to_file/)
		assert.match(text, /boom/)
	})
})
```

- [ ] **Step 2: Implement `transcriptReader.ts`**

```ts
// src/services/memory/dreaming/transcriptReader.ts
import fs from "node:fs/promises"
import path from "node:path"

export async function condenseRun(runDir: string): Promise<string> {
	const lines: string[] = []
	try {
		const meta = JSON.parse(await fs.readFile(path.join(runDir, "meta.json"), "utf8"))
		lines.push(`TASK: ${meta.task ?? "(unknown)"}`)
		if (meta.cwd) lines.push(`CWD: ${meta.cwd}`)
		if (meta.exit_reason) lines.push(`OUTCOME: ${meta.exit_reason}`)
	} catch {
		// no/corrupt meta
	}
	try {
		const jsonl = await fs.readFile(path.join(runDir, "trace.jsonl"), "utf8")
		for (const raw of jsonl.split("\n")) {
			if (!raw.trim()) continue
			let t: any
			try { t = JSON.parse(raw) } catch { continue }
			const tool = t.tool_execution?.tool_name
			if (tool) lines.push(`turn ${t.turn}: tool ${tool}${t.tool_execution.success === false ? " (failed)" : ""}`)
			if (Array.isArray(t.errors) && t.errors.length) lines.push(`turn ${t.turn}: errors ${t.errors.join("; ")}`)
		}
	} catch {
		// no trace
	}
	return lines.join("\n")
}
```

- [ ] **Step 3: Run + commit**

Run: `npx cross-env TS_NODE_PROJECT=./tsconfig.unit-test.json mocha src/services/memory/dreaming/__tests__/transcriptReader.test.ts` → PASS.
```bash
git add src/services/memory/dreaming/transcriptReader.ts src/services/memory/dreaming/__tests__/transcriptReader.test.ts
git commit -m "feat(memory): condense run transcripts for dreaming"
```

---

## Task 4: `MemorySynthesizer.ts` (injected LLM)

**Files:** Create `src/services/memory/dreaming/MemorySynthesizer.ts`; Test `__tests__/MemorySynthesizer.test.ts`.

- [ ] **Step 1: Failing test (fake async-generator LLM)**

```ts
// src/services/memory/dreaming/__tests__/MemorySynthesizer.test.ts
import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import { synthesizeMemories } from "../MemorySynthesizer"

async function* fakeStream(text: string) { yield { type: "text", text } as any }

describe("synthesizeMemories", () => {
	it("parses candidates and dedups vs existing by name", async () => {
		const modelJson = JSON.stringify([
			{ scope: "project:repo", type: "project", name: "uses-vitest", description: "tests via vitest", body: "The repo uses vitest." },
			{ scope: "global", type: "user", name: "prefers-fr", description: "FR", body: "User converses in French." },
		])
		const candidates = await synthesizeMemories("transcript", [{ name: "uses-vitest" }], { createMessage: () => fakeStream(modelJson) })
		assert.deepEqual(candidates.map((c) => c.name), ["prefers-fr"])
	})
	it("returns [] on unparseable output", async () => {
		assert.deepEqual(await synthesizeMemories("x", [], { createMessage: () => fakeStream("not json") }), [])
	})
})
```

- [ ] **Step 2: Implement `MemorySynthesizer.ts`**

```ts
// src/services/memory/dreaming/MemorySynthesizer.ts
import type { MemoryCandidate } from "./types"

export interface SynthDeps {
	createMessage: (systemPrompt: string, content: string) => AsyncIterable<{ type: string; text?: string }>
}

const SYSTEM_PROMPT =
	"You distill durable memory from a coding session transcript. Output ONLY a JSON array of " +
	'{scope,type,name,description,body}. scope is "global" (about the user) or "project:<slug>" ' +
	"(about this repo). type in [project,user,feedback,reference]. name is a short kebab-slug. " +
	"Keep entries durable and general; skip ephemeral details. Empty array if nothing worth remembering."

export async function synthesizeMemories(
	condensed: string,
	existing: Array<{ name: string }>,
	deps: SynthDeps,
): Promise<MemoryCandidate[]> {
	let text = ""
	try {
		for await (const chunk of deps.createMessage(SYSTEM_PROMPT, condensed)) {
			if (chunk.type === "text" && chunk.text) text += chunk.text
		}
	} catch {
		return []
	}
	const arr = parseJsonArray(text)
	if (!arr) return []
	const existingNames = new Set(existing.map((e) => e.name))
	const out: MemoryCandidate[] = []
	for (const c of arr) {
		if (!c || typeof c.name !== "string" || typeof c.body !== "string") continue
		if (existingNames.has(c.name)) continue
		out.push({
			scope: c.scope === "global" || String(c.scope).startsWith("project:") ? c.scope : "global",
			type: ["project", "user", "feedback", "reference"].includes(c.type) ? c.type : "project",
			name: c.name,
			description: typeof c.description === "string" ? c.description : "",
			body: c.body,
		})
	}
	return out
}

function parseJsonArray(text: string): any[] | null {
	try {
		const start = text.indexOf("[")
		const end = text.lastIndexOf("]")
		if (start === -1 || end < start) return null
		const parsed = JSON.parse(text.slice(start, end + 1))
		return Array.isArray(parsed) ? parsed : null
	} catch {
		return null
	}
}
```

- [ ] **Step 3: Run + commit**

Run: `npx cross-env TS_NODE_PROJECT=./tsconfig.unit-test.json mocha src/services/memory/dreaming/__tests__/MemorySynthesizer.test.ts` → PASS.
```bash
git add src/services/memory/dreaming/MemorySynthesizer.ts src/services/memory/dreaming/__tests__/MemorySynthesizer.test.ts
git commit -m "feat(memory): MemorySynthesizer (injected LLM pass)"
```

---

## Task 5: `DreamWorker.ts` (one-pass + loop) + index

**Files:** Create `src/services/memory/dreaming/DreamWorker.ts`, `index.ts`; Test `__tests__/DreamWorker.test.ts`.

- [ ] **Step 1: Failing test (one pass with fakes)**

```ts
// src/services/memory/dreaming/__tests__/DreamWorker.test.ts
import { strict as assert } from "node:assert"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, it } from "mocha"
import { runDreamOnce } from "../DreamWorker"

describe("runDreamOnce", () => {
	let dir: string
	beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "dream-w-")) })
	afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }) })

	it("processes new runs once, saves, advances cursor", async () => {
		const saved: any[] = []
		const deps = {
			cursorFile: path.join(dir, "cursor.json"),
			listRuns: async () => [{ projectKey: "repo", taskId: "t1", runDir: "/runs/t1" }],
			condense: async () => "condensed",
			listExisting: async () => [],
			synthesize: async () => [{ scope: "project:repo", type: "project", name: "fact-1", description: "d", body: "b" }],
			save: async (c: any) => { saved.push(c) },
		}
		await runDreamOnce(deps as any)
		assert.deepEqual(saved.map((s) => s.name), ["fact-1"])
		saved.length = 0
		await runDreamOnce(deps as any) // t1 already processed
		assert.deepEqual(saved, [])
	})
})
```

- [ ] **Step 2: Implement `DreamWorker.ts`**

```ts
// src/services/memory/dreaming/DreamWorker.ts
import { isProcessed, loadCursor, markProcessed, saveCursor } from "./corpusCursor"
import type { MemoryCandidate } from "./types"

export interface RunRef { projectKey: string; taskId: string; runDir: string }

export interface DreamDeps {
	cursorFile: string
	listRuns: () => Promise<RunRef[]>
	condense: (runDir: string) => Promise<string>
	listExisting: (scope?: string) => Promise<Array<{ name: string }>>
	synthesize: (condensed: string, existing: Array<{ name: string }>) => Promise<MemoryCandidate[]>
	save: (c: MemoryCandidate) => Promise<void>
}

export async function runDreamOnce(deps: DreamDeps): Promise<void> {
	let cursor = await loadCursor(deps.cursorFile)
	for (const run of await deps.listRuns()) {
		if (isProcessed(cursor, run.projectKey, run.taskId)) continue
		try {
			const condensed = await deps.condense(run.runDir)
			if (condensed.trim()) {
				const existing = await deps.listExisting()
				for (const c of await deps.synthesize(condensed, existing)) await deps.save(c)
			}
			cursor = markProcessed(cursor, run.projectKey, run.taskId)
			await saveCursor(deps.cursorFile, cursor)
		} catch {
			// skip; do not advance cursor so it retries next pass
		}
	}
}

export class DreamWorker {
	private timer?: NodeJS.Timeout
	private running = false
	constructor(private deps: DreamDeps, private intervalMs = 5 * 60_000) {}
	start(): void {
		if (this.timer) return
		this.timer = setInterval(() => this.tick(), this.intervalMs)
		this.timer.unref?.()
	}
	private async tick(): Promise<void> {
		if (this.running) return
		this.running = true
		try { await runDreamOnce(this.deps) } catch { /* best-effort */ } finally { this.running = false }
	}
	stop(): void {
		if (this.timer) clearInterval(this.timer)
		this.timer = undefined
	}
}
```

```ts
// src/services/memory/dreaming/index.ts
export { DreamWorker, runDreamOnce } from "./DreamWorker"
export type { DreamDeps, RunRef } from "./DreamWorker"
export type { DreamCursor, MemoryCandidate } from "./types"
```

- [ ] **Step 3: Run + commit**

Run: `npx cross-env TS_NODE_PROJECT=./tsconfig.unit-test.json mocha src/services/memory/dreaming/__tests__/DreamWorker.test.ts` → PASS.
```bash
git add src/services/memory/dreaming/DreamWorker.ts src/services/memory/dreaming/index.ts src/services/memory/dreaming/__tests__/DreamWorker.test.ts
git commit -m "feat(memory): DreamWorker loop + one-pass consolidation"
```

---

## Task 6: Production wiring + gated lifecycle + final gates + PR

**Files:** Create `src/services/memory/dreaming/wire.ts`; Modify `src/common.ts`.

- [ ] **Step 1: Confirm the exact upstream symbols**

Run: `rg -n "disableThinking|projectScopeFromCwd" cli/src/agent/review.ts src/utils/ailiance-memory.ts`
Note the exact import path of `disableThinking` (used at `review.ts:280`) and confirm `projectScopeFromCwd` is exported from `ailiance-memory.ts`.

- [ ] **Step 2: Implement `wire.ts` (real deps)**

```ts
// src/services/memory/dreaming/wire.ts
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { buildApiHandler } from "@core/api"
import { listMemories, projectScopeFromCwd, saveMemory } from "@/utils/ailiance-memory"
import type { DreamDeps, RunRef } from "./DreamWorker"
import { synthesizeMemories } from "./MemorySynthesizer"
import { condenseRun } from "./transcriptReader"
// import { disableThinking } from "<exact path confirmed in Step 1>"

const MEMORY_ROOT = path.join(os.homedir(), ".ailiance-agent", "memory")

export function buildDreamDeps(getApiConfig: () => any, getMode: () => "plan" | "act", searchRoots: string[]): DreamDeps {
	return {
		cursorFile: path.join(MEMORY_ROOT, ".dream-cursor.json"),
		listRuns: () => discoverRuns(searchRoots),
		condense: condenseRun,
		listExisting: () => listMemories({}),
		synthesize: (condensed, existing) => {
			const handler = buildApiHandler(getApiConfig(), getMode()) // wrap with disableThinking(...) once imported
			return synthesizeMemories(condensed, existing, {
				createMessage: (systemPrompt, content) =>
					handler.createMessage(systemPrompt, [{ role: "user", content }] as any),
			})
		},
		save: (c) =>
			saveMemory({
				name: c.name, description: c.description, type: c.type as any, scope: c.scope as any,
				body: c.body, source: "dreamed", lastSeenAt: new Date().toISOString(),
			} as any),
	}
}

async function discoverRuns(roots: string[]): Promise<RunRef[]> {
	const out: RunRef[] = []
	for (const root of roots) {
		const runsDir = path.join(root, ".ailiance-agent", "runs")
		let entries: string[] = []
		try { entries = await fs.readdir(runsDir) } catch { continue }
		const projectKey = projectScopeFromCwd(root).replace(/^project:/, "")
		for (const taskId of entries) out.push({ projectKey, taskId, runDir: path.join(runsDir, taskId) })
	}
	return out
}
```
> Add the `disableThinking` import (exact path from Step 1) and wrap `getApiConfig()` with it, matching `review.ts:280-281`. Confirm `projectScopeFromCwd` export name.

- [ ] **Step 3: Gated lifecycle in `common.ts`**

In `initialize()`, after existing workers: gate on opt-in (`process.env.ISAAC_DREAMING === "1"`, the simplest MVP gate) AND an available API config; if both, `const w = new DreamWorker(buildDreamDeps(...)); w.start()` and store it. In `tearDown()`, `dreamWorker?.stop()`. Default OFF → behavior unchanged. (`searchRoots` = the workspace roots available in `common.ts`; if not readily available, pass `[process.cwd()]` for the MVP and note it.)

- [ ] **Step 4: Full gates**

```bash
npm run test:unit
npm run check-types
npm run lint
```
Expected: PASS; dreaming OFF by default → behavior unchanged; existing `ailiance-memory` tests green.

- [ ] **Step 5: Confirm opt-in safety + push + PR**

```bash
rg -n "ISAAC_DREAMING|DreamWorker" src/common.ts
git add src/services/memory/dreaming/wire.ts src/common.ts
git commit -m "feat(memory): wire DreamWorker into lifecycle (opt-in)"
git push -u origin feat/lisael-dreaming
```
Open PR `feat/lisael-dreaming → master`, title `feat: LISAEL dreaming memory consolidation (#3)`. (Scrub token after a tokened HTTPS push.)

---

## Self-Review

- **Spec coverage:** frontmatter source/lastSeenAt (T1) ✓; cursor (T2) ✓; transcript condense (T3) ✓; synthesizer mocked-LLM (T4) ✓; worker loop + one-pass (T5) ✓; real wiring + gated lifecycle (T6) ✓. **Deferred per spec §2/§8:** quality tuning, eco tier, embeddings, decay sweep, privacy controls.
- **Placeholder scan:** T6 has explicit Step-1 confirmations (disableThinking import path, projectScopeFromCwd export, searchRoots source) — named, not vague. All unit code is concrete + DI-tested without module mocking.
- **Type consistency:** `MemoryCandidate`/`DreamDeps`/`RunRef`/`DreamCursor` consistent across cursor/synthesizer/worker/wire; `synthesizeMemories(condensed, existing, deps)` matches its test + the wire call; extended `saveMemory` entry shape matches Task 1.
- **Honesty:** synthesis *quality* is explicitly NOT claimed from green tests; the gate proves the pipeline only (per spec Risks).
