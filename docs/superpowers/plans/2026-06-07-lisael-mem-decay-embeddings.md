# LISAEL Memory Decay + Semantic Retrieval (#3.x) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** Two #3.x improvements to the dreaming memory system: (A) **decay/freshness** — bump `lastSeenAt` when a memory is re-observed + TTL-expire stale entries; (B) **semantic retrieval** — gateway `/v1/embeddings` + sidecar vector index + cosine ranking, augmenting the token-overlap ranking in `loadRelevantMemories` (with safe fallback).

**Design (inline; captured in brainstorm):**
- Embeddings source = **gateway `/v1/embeddings`** (OpenAI-compatible). Store = **sidecar `~/.ailiance-agent/memory/.embeddings.json`** (`name -> {vector, scope}`); similarity = **cosine brute-force**.
- Decay = bump `lastSeenAt` on re-observe (instead of skip-by-name) + a TTL sweep (`deleteMemory` entries older than `MEMORY_TTL_DAYS`, default 60).
- Retrieval = `loadRelevantMemories` ranks by cosine when an index + a query embedding are available; **falls back to token-overlap** (`scoreMemoryRelevance`) on any failure/missing index → never breaks the prompt, works offline.
- All injectable (an `embed` fn / ranker) so tests need no network.

**Branch:** `feat/lisael-mem-embeddings` (off `dfba206`). **Gates:** `npm run test:unit` · `npm run check-types` · `npm run lint`. Core tests via `npx cross-env TS_NODE_PROJECT=./tsconfig.unit-test.json mocha "<glob>"`.

**Shell:** `export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 22 >/dev/null; cd /Users/claude2/isaac-cli`

**Anchors (verified):** `src/utils/ailiance-memory.ts` — `saveMemory` (L158, accepts `source`/`lastSeenAt`), `scoreMemoryRelevance` (L457, token-overlap), `loadRelevantMemories` (L550, uses `scoreMemoryRelevance` at L574), `listMemories`, `deleteMemory`, `projectScopeFromCwd` (L525). Dreaming: `src/services/memory/dreaming/` (synthesizer dedups by name; DreamWorker `runDreamOnce`).

---

## Task 1: Cosine util + sidecar embedding index

**Files:** Create `src/services/memory/embeddings/vectorIndex.ts`; Test `embeddings/__tests__/vectorIndex.test.ts`.

- [ ] **Step 1: Failing test**

```ts
// src/services/memory/embeddings/__tests__/vectorIndex.test.ts
import { strict as assert } from "node:assert"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, it } from "mocha"
import { cosine, loadIndex, rankByCosine, saveIndex } from "../vectorIndex"

describe("vectorIndex", () => {
	let file: string
	beforeEach(async () => { file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "vi-")), "idx.json") })
	afterEach(async () => { await fs.rm(path.dirname(file), { recursive: true, force: true }) })

	it("cosine: identical=1, orthogonal=0", () => {
		assert.ok(Math.abs(cosine([1, 0], [1, 0]) - 1) < 1e-9)
		assert.ok(Math.abs(cosine([1, 0], [0, 1])) < 1e-9)
	})
	it("round-trips index + ranks by cosine to the query", async () => {
		await saveIndex(file, { a: { vector: [1, 0], scope: "global" }, b: { vector: [0, 1], scope: "global" } })
		const idx = await loadIndex(file)
		const ranked = rankByCosine(idx, [0.9, 0.1]).map((r) => r.name)
		assert.deepEqual(ranked, ["a", "b"])
	})
	it("missing index -> {}", async () => {
		assert.deepEqual(await loadIndex(path.join(file, "nope.json")), {})
	})
})
```

- [ ] **Step 2: Implement `vectorIndex.ts`**

```ts
// src/services/memory/embeddings/vectorIndex.ts
import fs from "node:fs/promises"
import path from "node:path"

export interface IndexEntry { vector: number[]; scope: string }
export type VectorIndex = Record<string, IndexEntry>

export function cosine(a: number[], b: number[]): number {
	let dot = 0, na = 0, nb = 0
	const n = Math.min(a.length, b.length)
	for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
	if (na === 0 || nb === 0) return 0
	return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

export async function loadIndex(file: string): Promise<VectorIndex> {
	try {
		const parsed = JSON.parse(await fs.readFile(file, "utf8"))
		return parsed && typeof parsed === "object" ? parsed : {}
	} catch {
		return {}
	}
}

export async function saveIndex(file: string, index: VectorIndex): Promise<void> {
	await fs.mkdir(path.dirname(file), { recursive: true })
	const tmp = `${file}.tmp`
	await fs.writeFile(tmp, JSON.stringify(index), "utf8")
	await fs.rename(tmp, file)
}

export function rankByCosine(index: VectorIndex, query: number[]): Array<{ name: string; score: number }> {
	return Object.entries(index)
		.map(([name, e]) => ({ name, score: cosine(e.vector, query) }))
		.sort((x, y) => y.score - x.score)
}
```

- [ ] **Step 3: Run + commit**

Run: `npx cross-env TS_NODE_PROJECT=./tsconfig.unit-test.json mocha src/services/memory/embeddings/__tests__/vectorIndex.test.ts` → PASS.
```bash
git add src/services/memory/embeddings/vectorIndex.ts src/services/memory/embeddings/__tests__/vectorIndex.test.ts
git commit -m "feat(memory): vector index + cosine"
```

---

## Task 2: Gateway embeddings client (injectable)

**Files:** Create `src/services/memory/embeddings/embedClient.ts`; Test `embeddings/__tests__/embedClient.test.ts`.

- [ ] **Step 1: Failing test (injected fetch)**

```ts
// src/services/memory/embeddings/__tests__/embedClient.test.ts
import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import { embedText } from "../embedClient"

describe("embedText", () => {
	it("posts to <base>/embeddings and returns the vector", async () => {
		let url = ""
		const fakeFetch = async (u: string, init: any) => {
			url = u
			assert.equal(JSON.parse(init.body).input, "hello")
			return { ok: true, json: async () => ({ data: [{ embedding: [0.1, 0.2] }] }) } as any
		}
		const v = await embedText("hello", { baseUrl: "https://gw/v1", apiKey: "k", model: "emb" }, fakeFetch as any)
		assert.deepEqual(v, [0.1, 0.2])
		assert.match(url, /\/embeddings$/)
	})
	it("returns null on non-ok / error (caller falls back)", async () => {
		const bad = async () => ({ ok: false, status: 500, json: async () => ({}) }) as any
		assert.equal(await embedText("x", { baseUrl: "https://gw/v1", apiKey: "k", model: "emb" }, bad as any), null)
	})
})
```

- [ ] **Step 2: Implement `embedClient.ts`**

```ts
// src/services/memory/embeddings/embedClient.ts
export interface EmbedConfig { baseUrl: string; apiKey: string; model: string }
type FetchLike = typeof fetch

/** Calls an OpenAI-compatible /embeddings endpoint. Returns null on any failure (caller falls back). */
export async function embedText(text: string, cfg: EmbedConfig, fetchImpl: FetchLike = fetch): Promise<number[] | null> {
	try {
		const res = await fetchImpl(`${cfg.baseUrl.replace(/\/$/, "")}/embeddings`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
			body: JSON.stringify({ model: cfg.model, input: text }),
		})
		if (!res.ok) return null
		const json: any = await res.json()
		const vec = json?.data?.[0]?.embedding
		return Array.isArray(vec) ? vec : null
	} catch {
		return null
	}
}
```

- [ ] **Step 3: Run + commit**

Run: mocha `embeddings/__tests__/embedClient.test.ts` → PASS.
```bash
git add src/services/memory/embeddings/embedClient.ts src/services/memory/embeddings/__tests__/embedClient.test.ts
git commit -m "feat(memory): gateway embeddings client"
```

---

## Task 3: Decay — bump lastSeenAt on re-observe + TTL expiry

**Files:** Modify `src/services/memory/dreaming/MemorySynthesizer.ts`, `DreamWorker.ts` (+ a `decay.ts` for `isStale`); Tests.

- [ ] **Step 1: Surface re-observed names from the synthesizer**

Change `synthesizeMemories` to return `{ created: MemoryCandidate[]; reobserved: string[] }` — `reobserved` = candidate names that matched an existing memory (currently skipped). Update its tests + the DreamWorker call site.

- [ ] **Step 2: `isStale` + bump/expire in the worker**

```ts
// src/services/memory/dreaming/decay.ts
export const MEMORY_TTL_DAYS = 60
export function isStale(m: { lastSeenAt?: string; created?: string }, ttlDays = MEMORY_TTL_DAYS, now = Date.now()): boolean {
	const ts = Date.parse(m.lastSeenAt ?? m.created ?? "")
	if (Number.isNaN(ts)) return false
	return now - ts > ttlDays * 86_400_000
}
```
In `runDreamOnce` deps, add `bump(name)` (re-save existing memory with `lastSeenAt = now`), `expire()` (list → `deleteMemory` where `isStale`). After saving `created` candidates: bump each `reobserved`; then run `expire()` once per pass. Keep these injectable.

- [ ] **Step 3: Test**

`isStale` unit (old→true, fresh→false, unparseable→false). Worker (injected): `reobserved` name → `bump` called; stale memory → `deleteMemory` called; fresh → not.

- [ ] **Step 4: Run + commit**

Run: `npm run test:unit` → PASS.
```bash
git add src/services/memory/dreaming/
git commit -m "feat(memory): decay - bump lastSeenAt + TTL expiry"
```

---

## Task 4: Semantic ranking in `loadRelevantMemories` (with fallback)

**Files:** Modify `src/utils/ailiance-memory.ts`; Create `src/services/memory/embeddings/semanticRanker.ts`; Tests (vitest + mocha).

- [ ] **Step 1: Optional injected ranker in `loadRelevantMemories`**

```ts
export interface SemanticRanker { rank(query: string, names: string[]): Promise<Map<string, number> | null> }
```
`loadRelevantMemories(cwd, userPrompt, ranker?)`: if `ranker`, `const scores = await ranker.rank(userPrompt, candidateNames)`; if non-null → order by scores; **else** the current `scoreMemoryRelevance` path (unchanged). Keep 8 000-char budget + project-over-global. No-ranker call = identical to today.

- [ ] **Step 2: `semanticRanker.ts`**

```ts
// src/services/memory/embeddings/semanticRanker.ts
import { type EmbedConfig, embedText } from "./embedClient"
import { cosine, loadIndex } from "./vectorIndex"
import type { SemanticRanker } from "@/utils/ailiance-memory"

export function makeSemanticRanker(indexFile: string, cfg: EmbedConfig, embed = embedText): SemanticRanker {
	return {
		async rank(query, names) {
			const index = await loadIndex(indexFile)
			if (!Object.keys(index).length) return null
			const q = await embed(query, cfg)
			if (!q) return null
			const m = new Map<string, number>()
			for (const n of names) { const e = index[n]; if (e) m.set(n, cosine(e.vector, q)) }
			return m.size ? m : null
		},
	}
}
```

- [ ] **Step 3: Test**

- vitest `ailiance-memory`: no-ranker = unchanged (existing green); injected ranker with canned scores → ordering follows; ranker→null → token-overlap fallback.
- mocha `semanticRanker`: injected `embed` + temp index → cosine ranking; embed→null → returns null; empty index → null.

- [ ] **Step 4: Run + commit**

Run: `cd cli && CI=1 npx vitest run src/utils/__tests__/ailiance-memory.test.ts` + `cd .. && npm run test:unit` → PASS.
```bash
git add src/utils/ailiance-memory.ts src/services/memory/embeddings/ cli/src/utils/__tests__/ailiance-memory.test.ts
git commit -m "feat(memory): semantic ranking with token fallback"
```

---

## Task 5: Wire embedding-on-save + ranker (gated/fallback) + PR

**Files:** Modify `src/services/memory/dreaming/wire.ts`, `src/core/prompts/system-prompt/registry/PromptBuilder.ts`; final gates + PR.

- [ ] **Step 1: Index dreamed memories** — in the dreaming `save` (wire.ts), after `saveMemory`, best-effort `embedText(body, cfg)` → `saveIndex` `{name:{vector,scope}}`. Failure leaves token-overlap working. `cfg` from the api config base/key + an embeddings model (config field or default).
- [ ] **Step 2: Pass ranker in PromptBuilder** — at `loadRelevantMemories(cwd, userPromptText)` (~L53), pass `makeSemanticRanker(EMBEDDINGS_INDEX_FILE, cfgFromApiConfig)`. Ranker returns `null` without index/network → prompt falls back to today's behavior (no regression). Keep `isTesting` skip. > Confirm the api-config accessor in PromptBuilder; if absent, gate behind `ISAAC_MEM_EMBEDDINGS=1` + default off.
- [ ] **Step 3: Full gates + PR**

```bash
npm run test:unit && npm run check-types && npm run lint && node esbuild.mjs
git add -A && git commit -m "feat(memory): wire embeddings index + ranker"
git push -u origin feat/lisael-mem-embeddings
```
Open PR `feat/lisael-mem-embeddings → master`, title `feat: LISAEL memory decay + semantic retrieval (#3.x)`. (Scrub token after tokened push.)

---

## Self-Review

- **Coverage:** cosine+index (T1) ✓; gateway embed client (T2) ✓; decay bump+TTL (T3) ✓; semantic ranking + fallback (T4) ✓; wire + gated PromptBuilder (T5) ✓. **Deferred (#3.x.y):** eco model tier, privacy controls, index compaction/backfill of pre-existing memories, re-embed on edit.
- **Placeholder scan:** T5 flags confirming the PromptBuilder api-config accessor + an embeddings-model default; all units DI-tested without network. No vague TODOs.
- **Type consistency:** `VectorIndex`/`IndexEntry`, `EmbedConfig`, `SemanticRanker` consistent across vectorIndex/embedClient/semanticRanker/wire; `loadRelevantMemories` optional `ranker` keeps no-arg behavior identical.
- **Safety/no-regression:** retrieval falls back to token-overlap on any embed failure / missing index → prompt never breaks, identical to today when embeddings off. Decay only deletes past 60-day TTL. Embedding-on-save best-effort.
