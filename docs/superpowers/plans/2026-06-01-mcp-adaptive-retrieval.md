# Adaptive MCP Tool Retrieval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop sending all ~70 plugin MCP tool schemas on every request; inject only the MCP tools relevant to the current need (per-session base set + on-demand `find_tools`), keeping the per-request tool count at ≤ K + native, which removes the empty-array tool-call failures caused by 95-tool bloat.

**Architecture:** Reuse the registry's existing `contextRequirements(ctx) => boolean` gate. MCP tool specs get a `contextRequirements` that checks `ctx.activeMcpTools` (a Set of active qualified names). A session-scoped `ActiveMcpToolSet` is seeded from the first user prompt via a local MiniLM embedder + cosine top-K (cap K, threshold τ), and grown when the model calls a new always-on `find_tools(query)` native tool. Embedder failure degrades to native-only (MCP off).

**Tech Stack:** TypeScript, Node@22, biome, mocha (core unit) + vitest (cli), `@huggingface/transformers` (transformers.js, all-MiniLM-L6-v2 ONNX, pinned/vendored).

**Build/test prelude (run once per shell):**
```bash
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
cd /Users/electron/code/ailiance-agent
```
- Typecheck: `npm run check-types`
- Lint: `npm run lint`
- Core unit (one file): `npx cross-env TS_NODE_PROJECT=./tsconfig.unit-test.json mocha 'src/core/mcp/retrieval/__tests__/<file>.test.ts'`
- CLI build (deploys `cli/dist/cli.mjs`): `npm run cli:build`

---

## File Structure

- `src/core/mcp/retrieval/cosine.ts` — pure cosine similarity + top-K selection (cap + threshold). No deps.
- `src/core/mcp/retrieval/Embedder.ts` — lazy MiniLM ONNX wrapper; `embed(texts) → Float32Array[]`; throws on load/inference failure.
- `src/core/mcp/retrieval/ToolVectorIndex.ts` — embeds MCP tool texts once; on-disk cache keyed by `qualifiedName` + description hash.
- `src/core/mcp/retrieval/ActiveMcpToolSet.ts` — session state: base selection + `expand(query)`; holds the active Set; pure logic over an injected embedder+index.
- `src/core/mcp/retrieval/config.ts` — K/K′/τ defaults + env/flag overrides.
- `src/core/prompts/system-prompt/tools/find_tools.ts` — the `find_tools` native tool spec.
- `src/core/task/tools/handlers/FindToolsToolHandler.ts` — the `find_tools` handler.
- Modify: `src/shared/tools.ts` (enum), `src/core/prompts/system-prompt/tools/init.ts` (register spec), `src/core/prompts/system-prompt/registry/DiracToolSet.ts` (register handler list is elsewhere), `src/core/task/tools/ToolExecutorCoordinator.ts` (register handler), `src/core/mcp/bootstrap.ts` (gate via contextRequirements + build index/active-set), `src/core/prompts/system-prompt/types.ts` (`activeMcpTools` field), `cli/src/index.ts` (flags).

---

## Task 1: Pure cosine + top-K selection

**Files:**
- Create: `src/core/mcp/retrieval/cosine.ts`
- Test: `src/core/mcp/retrieval/__tests__/cosine.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it } from "mocha"
import "should"
import { cosineSim, selectTopK } from "../cosine"

describe("cosine retrieval", () => {
	it("computes cosine similarity of normalized-ish vectors", () => {
		cosineSim(new Float32Array([1, 0]), new Float32Array([1, 0])).should.be.approximately(1, 1e-6)
		cosineSim(new Float32Array([1, 0]), new Float32Array([0, 1])).should.be.approximately(0, 1e-6)
		cosineSim(new Float32Array([0, 0]), new Float32Array([1, 0])).should.equal(0) // zero-vector guard
	})

	it("selectTopK applies threshold then caps, sorted by score desc", () => {
		const query = new Float32Array([1, 0])
		const items = [
			{ id: "a", vec: new Float32Array([1, 0]) }, // 1.0
			{ id: "b", vec: new Float32Array([0.9, 0.1]) }, // ~0.994
			{ id: "c", vec: new Float32Array([0, 1]) }, // 0.0 (below τ)
		]
		selectTopK(query, items, { k: 1, threshold: 0.3 }).should.deepEqual(["a"])
		selectTopK(query, items, { k: 5, threshold: 0.3 }).should.deepEqual(["a", "b"])
		selectTopK(query, items, { k: 5, threshold: 0.99 }).should.deepEqual(["a", "b"])
	})

	it("returns [] when nothing clears the threshold or items is empty", () => {
		const q = new Float32Array([1, 0])
		selectTopK(q, [{ id: "c", vec: new Float32Array([0, 1]) }], { k: 5, threshold: 0.3 }).should.deepEqual([])
		selectTopK(q, [], { k: 5, threshold: 0.3 }).should.deepEqual([])
	})
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx cross-env TS_NODE_PROJECT=./tsconfig.unit-test.json mocha 'src/core/mcp/retrieval/__tests__/cosine.test.ts'`
Expected: FAIL — `Cannot find module '../cosine'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/core/mcp/retrieval/cosine.ts
export function cosineSim(a: Float32Array, b: Float32Array): number {
	let dot = 0
	let na = 0
	let nb = 0
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i]
		na += a[i] * a[i]
		nb += b[i] * b[i]
	}
	if (na === 0 || nb === 0) {
		return 0
	}
	return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

export interface ScoredItem {
	id: string
	vec: Float32Array
}

export interface SelectOptions {
	k: number
	threshold: number
}

/** Items with cosine(query, vec) >= threshold, sorted desc, capped at k. */
export function selectTopK(query: Float32Array, items: ScoredItem[], opts: SelectOptions): string[] {
	return items
		.map((it) => ({ id: it.id, score: cosineSim(query, it.vec) }))
		.filter((s) => s.score >= opts.threshold)
		.sort((a, b) => b.score - a.score)
		.slice(0, Math.max(0, opts.k))
		.map((s) => s.id)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx cross-env TS_NODE_PROJECT=./tsconfig.unit-test.json mocha 'src/core/mcp/retrieval/__tests__/cosine.test.ts'`
Expected: PASS (3 passing).

- [ ] **Step 5: Commit**

```bash
git add src/core/mcp/retrieval/cosine.ts src/core/mcp/retrieval/__tests__/cosine.test.ts
git commit -m "feat(mcp): cosine similarity + top-K selection for tool retrieval"
```

---

## Task 2: Retrieval config (K/K′/τ defaults + overrides)

**Files:**
- Create: `src/core/mcp/retrieval/config.ts`
- Test: `src/core/mcp/retrieval/__tests__/config.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, afterEach } from "mocha"
import "should"
import { getRetrievalConfig } from "../config"

describe("getRetrievalConfig", () => {
	afterEach(() => {
		delete process.env.AILIANCE_MCP_TOP_K
		delete process.env.AILIANCE_MCP_FIND_K
		delete process.env.AILIANCE_MCP_THRESHOLD
	})

	it("returns sane defaults", () => {
		getRetrievalConfig().should.deepEqual({ baseK: 8, findK: 5, threshold: 0.3 })
	})

	it("honors env overrides and ignores invalid ones", () => {
		process.env.AILIANCE_MCP_TOP_K = "12"
		process.env.AILIANCE_MCP_THRESHOLD = "0.45"
		process.env.AILIANCE_MCP_FIND_K = "not-a-number"
		getRetrievalConfig().should.deepEqual({ baseK: 12, findK: 5, threshold: 0.45 })
	})
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx cross-env TS_NODE_PROJECT=./tsconfig.unit-test.json mocha 'src/core/mcp/retrieval/__tests__/config.test.ts'`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/core/mcp/retrieval/config.ts
export interface RetrievalConfig {
	baseK: number
	findK: number
	threshold: number
}

const DEFAULTS: RetrievalConfig = { baseK: 8, findK: 5, threshold: 0.3 }

function numEnv(name: string, fallback: number): number {
	const raw = process.env[name]
	if (raw === undefined) {
		return fallback
	}
	const n = Number(raw)
	return Number.isFinite(n) ? n : fallback
}

export function getRetrievalConfig(): RetrievalConfig {
	return {
		baseK: numEnv("AILIANCE_MCP_TOP_K", DEFAULTS.baseK),
		findK: numEnv("AILIANCE_MCP_FIND_K", DEFAULTS.findK),
		threshold: numEnv("AILIANCE_MCP_THRESHOLD", DEFAULTS.threshold),
	}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx cross-env TS_NODE_PROJECT=./tsconfig.unit-test.json mocha 'src/core/mcp/retrieval/__tests__/config.test.ts'`
Expected: PASS (2 passing).

- [ ] **Step 5: Commit**

```bash
git add src/core/mcp/retrieval/config.ts src/core/mcp/retrieval/__tests__/config.test.ts
git commit -m "feat(mcp): retrieval config with env-overridable K/findK/threshold"
```

---

## Task 3: Embedder dependency (pin transformers.js) — supply-chain

**Files:**
- Modify: `package.json` (root), lockfile

- [ ] **Step 1: Add the pinned dependency**

Run:
```bash
npm install --save-exact @huggingface/transformers@3.3.3
```
(Pin the exact version; verify the resolved integrity hash lands in `package-lock.json`.)

- [ ] **Step 2: Verify install + hash present**

Run: `node -e "console.log(require('@huggingface/transformers/package.json').version)"`
Expected: `3.3.3`
Run: `grep -c '"@huggingface/transformers"' package-lock.json`
Expected: ≥ 1 (entry with `integrity` sha512 present).

- [ ] **Step 3: Record supply-chain note**

Append to `docs/superpowers/plans/2026-06-01-mcp-adaptive-retrieval.md` a one-line SBOM note, or add to the existing dependency inventory: `@huggingface/transformers@3.3.3` + model `Xenova/all-MiniLM-L6-v2` (ONNX) must be mirrored into the `ailiance` org before production; runtime must load from the vendored/cached path, not the public HF CDN.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json docs/superpowers/plans/2026-06-01-mcp-adaptive-retrieval.md
git commit -m "build(mcp): pin @huggingface/transformers for local tool embedding"
```

---

## Task 4: Embedder wrapper (lazy MiniLM, fails loud)

**Files:**
- Create: `src/core/mcp/retrieval/Embedder.ts`
- Test: `src/core/mcp/retrieval/__tests__/Embedder.test.ts`

The Embedder takes an injectable "pipeline factory" so tests never load the real model. Production passes the transformers.js factory.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it } from "mocha"
import "should"
import { Embedder } from "../Embedder"

describe("Embedder", () => {
	it("embeds via the injected pipeline and returns Float32Array[]", async () => {
		const fakePipeline = async (texts: string[]) =>
			texts.map((t) => new Float32Array([t.length, 0, 0]))
		const e = new Embedder(async () => fakePipeline)
		const [v] = await e.embed(["abc"])
		Array.from(v).should.deepEqual([3, 0, 0])
	})

	it("loads the pipeline only once (lazy, memoized)", async () => {
		let loads = 0
		const e = new Embedder(async () => {
			loads++
			return async (texts: string[]) => texts.map(() => new Float32Array([1]))
		})
		await e.embed(["a"])
		await e.embed(["b"])
		loads.should.equal(1)
	})

	it("propagates load failure (caller degrades)", async () => {
		const e = new Embedder(async () => {
			throw new Error("model load failed")
		})
		let threw = false
		try {
			await e.embed(["a"])
		} catch {
			threw = true
		}
		threw.should.equal(true)
	})
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx cross-env TS_NODE_PROJECT=./tsconfig.unit-test.json mocha 'src/core/mcp/retrieval/__tests__/Embedder.test.ts'`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/core/mcp/retrieval/Embedder.ts
export type EmbedFn = (texts: string[]) => Promise<Float32Array[]>
export type PipelineFactory = () => Promise<EmbedFn>

/**
 * Lazy local text embedder. The pipeline factory is injected so tests run
 * without loading the real ONNX model. Production wires the transformers.js
 * factory in `createDefaultEmbedder`.
 */
export class Embedder {
	private pipelinePromise: Promise<EmbedFn> | undefined

	constructor(private readonly factory: PipelineFactory) {}

	async embed(texts: string[]): Promise<Float32Array[]> {
		if (!this.pipelinePromise) {
			this.pipelinePromise = this.factory()
		}
		const fn = await this.pipelinePromise
		return fn(texts)
	}
}

/**
 * Production factory: all-MiniLM-L6-v2 ONNX via transformers.js, mean-pooled +
 * normalized 384-d. Imported lazily so `--no-mcp` never pays the import cost.
 */
export function createDefaultEmbedder(): Embedder {
	return new Embedder(async () => {
		const { pipeline } = await import("@huggingface/transformers")
		const extractor = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2")
		return async (texts: string[]) => {
			const out = await extractor(texts, { pooling: "mean", normalize: true })
			// out.tolist() → number[][]; convert each row to Float32Array
			return (out.tolist() as number[][]).map((row) => Float32Array.from(row))
		}
	})
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx cross-env TS_NODE_PROJECT=./tsconfig.unit-test.json mocha 'src/core/mcp/retrieval/__tests__/Embedder.test.ts'`
Expected: PASS (3 passing).

- [ ] **Step 5: Commit**

```bash
git add src/core/mcp/retrieval/Embedder.ts src/core/mcp/retrieval/__tests__/Embedder.test.ts
git commit -m "feat(mcp): lazy injectable local embedder wrapper"
```

---

## Task 5: Tool-vector index with on-disk cache

**Files:**
- Create: `src/core/mcp/retrieval/ToolVectorIndex.ts`
- Test: `src/core/mcp/retrieval/__tests__/ToolVectorIndex.test.ts`

The index embeds each MCP tool's `name + "\n" + description` once, caches vectors on disk keyed by `qualifiedName` + a hash of the embedded text, and re-embeds only changed/new tools.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, beforeEach, afterEach } from "mocha"
import "should"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { Embedder } from "../Embedder"
import { ToolVectorIndex } from "../ToolVectorIndex"

function tmpFile(): string {
	return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tvi-")), "index.json")
}

describe("ToolVectorIndex", () => {
	let cachePath: string
	beforeEach(() => {
		cachePath = tmpFile()
	})
	afterEach(() => {
		fs.rmSync(path.dirname(cachePath), { recursive: true, force: true })
	})

	it("embeds each tool once and returns vectors keyed by qualifiedName", async () => {
		let embedCalls = 0
		const embedder = new Embedder(async () => async (texts: string[]) => {
			embedCalls += texts.length
			return texts.map((t) => new Float32Array([t.length]))
		})
		const idx = new ToolVectorIndex(embedder, cachePath)
		const tools = [
			{ qualifiedName: "mcp__p_s__a", text: "alpha" },
			{ qualifiedName: "mcp__p_s__b", text: "beta!" },
		]
		const vecs = await idx.build(tools)
		embedCalls.should.equal(2)
		Array.from(vecs.get("mcp__p_s__a")!).should.deepEqual([5]) // "alpha".length
	})

	it("re-uses the disk cache and only embeds new/changed tools", async () => {
		let embedCalls = 0
		const embedder = new Embedder(async () => async (texts: string[]) => {
			embedCalls += texts.length
			return texts.map((t) => new Float32Array([t.length]))
		})
		const tools = [{ qualifiedName: "mcp__p_s__a", text: "alpha" }]
		await new ToolVectorIndex(embedder, cachePath).build(tools) // embeds 1
		await new ToolVectorIndex(embedder, cachePath).build(tools) // cache hit, embeds 0
		embedCalls.should.equal(1)
		// changed text → re-embed
		await new ToolVectorIndex(embedder, cachePath).build([{ qualifiedName: "mcp__p_s__a", text: "alpha2" }])
		embedCalls.should.equal(2)
	})
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx cross-env TS_NODE_PROJECT=./tsconfig.unit-test.json mocha 'src/core/mcp/retrieval/__tests__/ToolVectorIndex.test.ts'`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/core/mcp/retrieval/ToolVectorIndex.ts
import * as crypto from "crypto"
import * as fs from "fs"
import * as path from "path"
import type { Embedder } from "./Embedder"

export interface ToolText {
	qualifiedName: string
	text: string
}

interface CacheEntry {
	hash: string
	vec: number[]
}

function hashText(text: string): string {
	return crypto.createHash("sha256").update(text).digest("hex").slice(0, 16)
}

export class ToolVectorIndex {
	constructor(
		private readonly embedder: Embedder,
		private readonly cachePath: string,
	) {}

	private readCache(): Record<string, CacheEntry> {
		try {
			return JSON.parse(fs.readFileSync(this.cachePath, "utf8"))
		} catch {
			return {}
		}
	}

	private writeCache(cache: Record<string, CacheEntry>): void {
		fs.mkdirSync(path.dirname(this.cachePath), { recursive: true })
		fs.writeFileSync(this.cachePath, JSON.stringify(cache))
	}

	/** Returns a Map<qualifiedName, Float32Array>, embedding only new/changed tools. */
	async build(tools: ToolText[]): Promise<Map<string, Float32Array>> {
		const cache = this.readCache()
		const stale = tools.filter((t) => cache[t.qualifiedName]?.hash !== hashText(t.text))
		if (stale.length > 0) {
			const vecs = await this.embedder.embed(stale.map((t) => t.text))
			stale.forEach((t, i) => {
				cache[t.qualifiedName] = { hash: hashText(t.text), vec: Array.from(vecs[i]) }
			})
			this.writeCache(cache)
		}
		const result = new Map<string, Float32Array>()
		for (const t of tools) {
			result.set(t.qualifiedName, Float32Array.from(cache[t.qualifiedName].vec))
		}
		return result
	}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx cross-env TS_NODE_PROJECT=./tsconfig.unit-test.json mocha 'src/core/mcp/retrieval/__tests__/ToolVectorIndex.test.ts'`
Expected: PASS (2 passing).

- [ ] **Step 5: Commit**

```bash
git add src/core/mcp/retrieval/ToolVectorIndex.ts src/core/mcp/retrieval/__tests__/ToolVectorIndex.test.ts
git commit -m "feat(mcp): on-disk tool-vector index with hash-keyed cache"
```

---

## Task 6: ActiveMcpToolSet (base selection + expand)

**Files:**
- Create: `src/core/mcp/retrieval/ActiveMcpToolSet.ts`
- Test: `src/core/mcp/retrieval/__tests__/ActiveMcpToolSet.test.ts`

Session state. Built from a vector map (from Task 5) + embedder (Task 4) + config (Task 2). `seed(prompt)` sets the base set; `expand(query)` adds; `snapshot()` returns a `ReadonlySet<string>`. Embedder failure → empty set (degrade), surfaced via `available()`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it } from "mocha"
import "should"
import { Embedder } from "../Embedder"
import { ActiveMcpToolSet } from "../ActiveMcpToolSet"

// query "alpha" embeds to [5]; tools embed to their length → cosine of 1-d
// vectors is always 1 for same-sign, so threshold gates by presence, and we
// instead use distinct directions to exercise ranking.
function makeEmbedder(map: Record<string, number[]>) {
	return new Embedder(async () => async (texts: string[]) =>
		texts.map((t) => Float32Array.from(map[t] ?? [0, 0])),
	)
}

describe("ActiveMcpToolSet", () => {
	const vectors = new Map<string, Float32Array>([
		["mcp__git__issues", Float32Array.from([1, 0])],
		["mcp__fs__read", Float32Array.from([0, 1])],
	])

	it("seeds the base set from the prompt (cap + threshold)", async () => {
		const embedder = makeEmbedder({ "find github issues": [1, 0] })
		const set = new ActiveMcpToolSet(embedder, vectors, { baseK: 8, findK: 5, threshold: 0.3 })
		await set.seed("find github issues")
		set.snapshot().has("mcp__git__issues").should.equal(true)
		set.snapshot().has("mcp__fs__read").should.equal(false) // cosine 0 < τ
	})

	it("expand() adds matching tools and is idempotent", async () => {
		const embedder = makeEmbedder({ "read a file": [0, 1], seed: [1, 0] })
		const set = new ActiveMcpToolSet(embedder, vectors, { baseK: 8, findK: 5, threshold: 0.3 })
		await set.seed("seed")
		const added = await set.expand("read a file")
		added.should.deepEqual(["mcp__fs__read"])
		set.snapshot().has("mcp__fs__read").should.equal(true)
		;(await set.expand("read a file")).should.deepEqual([]) // already active
	})

	it("degrades to empty set + available()=false when embedder throws", async () => {
		const embedder = new Embedder(async () => {
			throw new Error("no model")
		})
		const set = new ActiveMcpToolSet(embedder, vectors, { baseK: 8, findK: 5, threshold: 0.3 })
		await set.seed("anything")
		set.snapshot().size.should.equal(0)
		set.available().should.equal(false)
	})
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx cross-env TS_NODE_PROJECT=./tsconfig.unit-test.json mocha 'src/core/mcp/retrieval/__tests__/ActiveMcpToolSet.test.ts'`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/core/mcp/retrieval/ActiveMcpToolSet.ts
import type { RetrievalConfig } from "./config"
import { type ScoredItem, selectTopK } from "./cosine"
import type { Embedder } from "./Embedder"

export class ActiveMcpToolSet {
	private readonly active = new Set<string>()
	private readonly items: ScoredItem[]
	private embedderOk = true

	constructor(
		private readonly embedder: Embedder,
		vectors: Map<string, Float32Array>,
		private readonly config: RetrievalConfig,
	) {
		this.items = Array.from(vectors.entries()).map(([id, vec]) => ({ id, vec }))
	}

	available(): boolean {
		return this.embedderOk
	}

	snapshot(): ReadonlySet<string> {
		return this.active
	}

	private async select(text: string, k: number): Promise<string[]> {
		const [q] = await this.embedder.embed([text])
		return selectTopK(q, this.items, { k, threshold: this.config.threshold })
	}

	/** Seed the base set from the first user prompt. Failure → empty set. */
	async seed(prompt: string): Promise<void> {
		try {
			for (const id of await this.select(prompt, this.config.baseK)) {
				this.active.add(id)
			}
		} catch {
			this.embedderOk = false
		}
	}

	/** Grow the set on a find_tools query. Returns newly-added ids. */
	async expand(query: string): Promise<string[]> {
		try {
			const added: string[] = []
			for (const id of await this.select(query, this.config.findK)) {
				if (!this.active.has(id)) {
					this.active.add(id)
					added.push(id)
				}
			}
			return added
		} catch {
			this.embedderOk = false
			return []
		}
	}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx cross-env TS_NODE_PROJECT=./tsconfig.unit-test.json mocha 'src/core/mcp/retrieval/__tests__/ActiveMcpToolSet.test.ts'`
Expected: PASS (3 passing).

- [ ] **Step 5: Commit**

```bash
git add src/core/mcp/retrieval/ActiveMcpToolSet.ts src/core/mcp/retrieval/__tests__/ActiveMcpToolSet.test.ts
git commit -m "feat(mcp): session active-tool set with seed + expand"
```

---

## Task 7: Session singleton + context field for the gate

**Files:**
- Modify: `src/core/prompts/system-prompt/types.ts` (add `activeMcpTools`)
- Create: `src/core/mcp/retrieval/session.ts` (process-wide current ActiveMcpToolSet accessor)
- Test: `src/core/mcp/retrieval/__tests__/session.test.ts`

- [ ] **Step 1: Add the context field**

In `src/core/prompts/system-prompt/types.ts`, inside `interface SystemPromptContext`, add after `readonly subagentsEnabled?: boolean`:

```ts
	/** Active MCP tool qualified names for adaptive retrieval. When set, only
	 * these MCP tools are emitted; undefined means "no gating" (legacy: all). */
	readonly activeMcpTools?: ReadonlySet<string>
```

- [ ] **Step 2: Write the failing test for the session accessor**

```ts
// src/core/mcp/retrieval/__tests__/session.test.ts
import { describe, it } from "mocha"
import "should"
import { getActiveMcpToolSet, setActiveMcpToolSet } from "../session"

describe("active mcp tool set session", () => {
	it("stores and returns the current set; undefined by default after clear", () => {
		setActiveMcpToolSet(undefined)
		;(getActiveMcpToolSet() === undefined).should.equal(true)
		const fake = { snapshot: () => new Set(["mcp__x__y"]) } as any
		setActiveMcpToolSet(fake)
		getActiveMcpToolSet()!.snapshot().has("mcp__x__y").should.equal(true)
	})
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx cross-env TS_NODE_PROJECT=./tsconfig.unit-test.json mocha 'src/core/mcp/retrieval/__tests__/session.test.ts'`
Expected: FAIL — module not found.

- [ ] **Step 4: Write minimal implementation**

```ts
// src/core/mcp/retrieval/session.ts
import type { ActiveMcpToolSet } from "./ActiveMcpToolSet"

let current: ActiveMcpToolSet | undefined

export function setActiveMcpToolSet(set: ActiveMcpToolSet | undefined): void {
	current = set
}

export function getActiveMcpToolSet(): ActiveMcpToolSet | undefined {
	return current
}
```

- [ ] **Step 5: Run test + typecheck**

Run: `npx cross-env TS_NODE_PROJECT=./tsconfig.unit-test.json mocha 'src/core/mcp/retrieval/__tests__/session.test.ts'`
Expected: PASS (1 passing).
Run: `npm run check-types`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/prompts/system-prompt/types.ts src/core/mcp/retrieval/session.ts src/core/mcp/retrieval/__tests__/session.test.ts
git commit -m "feat(mcp): session-scoped active tool set + context field"
```

---

## Task 8: Gate MCP specs via contextRequirements

**Files:**
- Modify: `src/core/mcp/bootstrap.ts` (`mcpToolToSpec`, ~line 69-78)
- Test: `src/core/mcp/retrieval/__tests__/gate.test.ts`

MCP specs get a `contextRequirements` that returns true only when the qualified name is in `ctx.activeMcpTools` (or when gating is disabled, i.e. `activeMcpTools === undefined` → legacy "all", preserving `--no-mcp`/no-retrieval behavior).

- [ ] **Step 1: Write the failing test**

```ts
// src/core/mcp/retrieval/__tests__/gate.test.ts
import { describe, it } from "mocha"
import "should"
import { mcpToolToSpec } from "../../bootstrap"

const meta = {
	qualifiedName: "mcp__p_s__a",
	serverId: "s",
	pluginName: "p",
	rawName: "a",
	description: "does A",
	inputSchema: { type: "object", properties: {} },
}

describe("mcpToolToSpec gating", () => {
	it("is enabled when no gating set (undefined activeMcpTools)", () => {
		const spec = mcpToolToSpec(meta as any)
		spec.contextRequirements!({ activeMcpTools: undefined } as any).should.equal(true)
	})
	it("is enabled only when present in the active set", () => {
		const spec = mcpToolToSpec(meta as any)
		spec.contextRequirements!({ activeMcpTools: new Set(["mcp__p_s__a"]) } as any).should.equal(true)
		spec.contextRequirements!({ activeMcpTools: new Set(["other"]) } as any).should.equal(false)
	})
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx cross-env TS_NODE_PROJECT=./tsconfig.unit-test.json mocha 'src/core/mcp/retrieval/__tests__/gate.test.ts'`
Expected: FAIL — `spec.contextRequirements` is undefined.

- [ ] **Step 3: Implement the gate in `mcpToolToSpec`**

In `src/core/mcp/bootstrap.ts`, replace the return of `mcpToolToSpec`:

```ts
export function mcpToolToSpec(tool: McpToolMetadata): DiracToolSpec {
	const qualifiedName = tool.qualifiedName
	return {
		id: qualifiedName as DiracDefaultTool,
		name: qualifiedName,
		description: tool.description ?? `MCP tool from plugin ${tool.pluginName}`,
		parameters: convertJsonSchemaToParams(tool.inputSchema),
		// Adaptive retrieval gate: when ctx.activeMcpTools is set, only emit this
		// MCP tool if its qualified name is active. undefined → legacy "all".
		contextRequirements: (ctx) => ctx.activeMcpTools === undefined || ctx.activeMcpTools.has(qualifiedName),
	}
}
```

- [ ] **Step 4: Run test + typecheck**

Run: `npx cross-env TS_NODE_PROJECT=./tsconfig.unit-test.json mocha 'src/core/mcp/retrieval/__tests__/gate.test.ts'`
Expected: PASS (2 passing).
Run: `npm run check-types`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/mcp/bootstrap.ts src/core/mcp/retrieval/__tests__/gate.test.ts
git commit -m "feat(mcp): gate MCP tool specs by active set via contextRequirements"
```

---

## Task 9: `find_tools` native tool — spec + enum + register

**Files:**
- Modify: `src/shared/tools.ts` (enum)
- Create: `src/core/prompts/system-prompt/tools/find_tools.ts`
- Modify: `src/core/prompts/system-prompt/tools/init.ts` (import + add to allTools)

- [ ] **Step 1: Add enum member**

In `src/shared/tools.ts`, inside `enum DiracDefaultTool`, add:

```ts
	FIND_TOOLS = "find_tools",
```

- [ ] **Step 2: Create the spec**

```ts
// src/core/prompts/system-prompt/tools/find_tools.ts
import { DiracDefaultTool } from "@/shared/tools"
import type { DiracToolSpec } from "../spec"

export const find_tools: DiracToolSpec = {
	id: DiracDefaultTool.FIND_TOOLS,
	name: "find_tools",
	description:
		"Discover and activate additional MCP tools that are not currently available to you. " +
		"Only a relevant subset of external (MCP) tools is loaded by default to keep the tool list small. " +
		"If you need a capability you don't see (e.g. interacting with GitHub, a database, a browser, etc.), " +
		"call find_tools with a short natural-language description of the capability you need. The matching " +
		"tools become available on your next turn. Example: { query: \"search and comment on GitHub issues\" }.",
	parameters: [
		{
			name: "query",
			required: true,
			type: "string",
			instruction: "A short natural-language description of the capability/tool you need.",
			usage: "search and comment on GitHub issues",
		},
	],
}
```

- [ ] **Step 3: Register the spec**

In `src/core/prompts/system-prompt/tools/init.ts`: add `import { find_tools } from "./find_tools"` with the other imports, and add `find_tools,` into the `allTools` array.

- [ ] **Step 4: Typecheck**

Run: `npm run check-types`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/tools.ts src/core/prompts/system-prompt/tools/find_tools.ts src/core/prompts/system-prompt/tools/init.ts
git commit -m "feat(mcp): add find_tools native tool spec"
```

---

## Task 10: `find_tools` handler + dispatch

**Files:**
- Create: `src/core/task/tools/handlers/FindToolsToolHandler.ts`
- Modify: `src/core/task/tools/ToolExecutorCoordinator.ts` (register, near where native handlers are registered — see existing `registerByName` calls)
- Test: `src/core/task/tools/handlers/__tests__/FindToolsToolHandler.test.ts`

First read how an existing simple handler (e.g. `ListSkillsHandler` / `list_skills`) is registered in `ToolExecutorCoordinator` so this follows the same pattern (`coordinator.registerByName(DiracDefaultTool.X, validator)` or a handler-instance registration — match what the file actually does).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, afterEach } from "mocha"
import "should"
import { setActiveMcpToolSet } from "@core/mcp/retrieval/session"
import { FindToolsToolHandler } from "../FindToolsToolHandler"

describe("FindToolsToolHandler", () => {
	afterEach(() => setActiveMcpToolSet(undefined))

	it("expands the active set and reports activated tools", async () => {
		const calls: string[] = []
		setActiveMcpToolSet({
			expand: async (q: string) => {
				calls.push(q)
				return ["mcp__git__issues"]
			},
			available: () => true,
		} as any)
		const handler = new FindToolsToolHandler()
		const res = await handler.execute({ params: { query: "github issues" } } as any)
		calls.should.deepEqual(["github issues"])
		String(res).should.match(/mcp__git__issues/)
	})

	it("reports unavailability when retrieval is disabled", async () => {
		setActiveMcpToolSet(undefined)
		const handler = new FindToolsToolHandler()
		String(await handler.execute({ params: { query: "x" } } as any)).should.match(/unavailable|not available/i)
	})
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx cross-env TS_NODE_PROJECT=./tsconfig.unit-test.json mocha 'src/core/task/tools/handlers/__tests__/FindToolsToolHandler.test.ts'`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the handler**

Model the class shape on a sibling handler (read `src/core/task/tools/handlers/ListSkillsToolHandler.ts` for the exact `IFullyManagedTool`/`IToolHandler` interface, `name`, `getDescription`, `handlePartialBlock`, `execute(config, block)` signatures) and adapt:

```ts
// src/core/task/tools/handlers/FindToolsToolHandler.ts
import type { ToolUse } from "@core/assistant-message"
import { getActiveMcpToolSet } from "@core/mcp/retrieval/session"
import { DiracDefaultTool } from "@/shared/tools"
import type { ToolResponse } from "../../index"
import type { IFullyManagedTool } from "../ToolExecutorCoordinator"
import type { StronglyTypedUIHelpers } from "../types/UIHelpers"
import type { TaskConfig } from "../types/TaskConfig"

export class FindToolsToolHandler implements IFullyManagedTool {
	readonly name = DiracDefaultTool.FIND_TOOLS

	getDescription(block: ToolUse): string {
		const q = (block.params.query as string) || ""
		return `[find_tools for '${q}']`
	}

	async handlePartialBlock(_block: ToolUse, _uiHelpers: StronglyTypedUIHelpers): Promise<void> {
		// no-op: find_tools has no streamed side effects to preview
	}

	async execute(_config: TaskConfig, block: ToolUse): Promise<ToolResponse> {
		const query = ((block.params.query as string) || "").trim()
		const set = getActiveMcpToolSet()
		if (!set || !set.available()) {
			return "Tool retrieval is unavailable in this run; the default tool set is all that is available."
		}
		if (!query) {
			return "find_tools requires a non-empty 'query' describing the capability you need."
		}
		const added = await set.expand(query)
		if (added.length === 0) {
			return `No additional tools matched "${query}". The relevant tools may already be available, or none exist for this need.`
		}
		return `Activated ${added.length} tool(s) for "${query}" (available next turn):\n${added.map((n) => `- ${n}`).join("\n")}`
	}
}
```

NOTE: adjust the import paths / interface to exactly match `ListSkillsToolHandler.ts`. If `execute` there returns via `formatResponse.toolResult(...)`, wrap the strings the same way.

- [ ] **Step 4: Register the handler**

In `src/core/task/tools/ToolExecutorCoordinator.ts`, register `FindToolsToolHandler` next to the other native handlers (follow the exact registration call used for `list_skills`).

- [ ] **Step 5: Run test + typecheck**

Run: `npx cross-env TS_NODE_PROJECT=./tsconfig.unit-test.json mocha 'src/core/task/tools/handlers/__tests__/FindToolsToolHandler.test.ts'`
Expected: PASS (2 passing).
Run: `npm run check-types`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/task/tools/handlers/FindToolsToolHandler.ts src/core/task/tools/ToolExecutorCoordinator.ts src/core/task/tools/handlers/__tests__/FindToolsToolHandler.test.ts
git commit -m "feat(mcp): find_tools handler wired to active set"
```

---

## Task 11: Wire bootstrap — build index, seed active set, publish to session

**Files:**
- Modify: `src/core/mcp/bootstrap.ts` (`initializeMcpForTask`, after `listAllTools`)

After MCP tools are listed and specs registered, build the vector index, create the `ActiveMcpToolSet`, and publish it via `setActiveMcpToolSet`. Seeding from the first user prompt happens in Task 12 (where the task text is available); here we publish an unseeded set so the gate has a Set (empty until seeded). When `--no-mcp` (returns early) or retrieval disabled, leave the session set `undefined` (legacy "all" — but with zero MCP tools registered, "all" = none, which is correct).

- [ ] **Step 1: Extend `initializeMcpForTask`**

After the `for (const tool of tools) { ... }` registration loop and before `return tools`, insert this block. On success it publishes a real active set; on ANY failure it publishes an active set backed by a throwing embedder + empty index, so the gate emits ZERO MCP tools (never the legacy "all" flood) and `available()` reports false:

```ts
	// Adaptive retrieval: build the vector index and publish a session active set.
	const { ActiveMcpToolSet } = await import("./retrieval/ActiveMcpToolSet")
	const { getRetrievalConfig } = await import("./retrieval/config")
	const { setActiveMcpToolSet } = await import("./retrieval/session")
	try {
		const { createDefaultEmbedder } = await import("./retrieval/Embedder")
		const { ToolVectorIndex } = await import("./retrieval/ToolVectorIndex")
		const os = await import("os")
		const path = await import("path")
		const cachePath = path.join(os.homedir(), ".dirac", "mcp-tool-vectors.json")
		const embedder = createDefaultEmbedder()
		const index = await new ToolVectorIndex(embedder, cachePath).build(
			tools.map((t) => ({ qualifiedName: t.qualifiedName, text: `${t.qualifiedName}\n${t.description ?? ""}` })),
		)
		setActiveMcpToolSet(new ActiveMcpToolSet(embedder, index, getRetrievalConfig()))
	} catch (err) {
		Logger.warn("MCP adaptive retrieval unavailable; running native-only:", err)
		const { Embedder } = await import("./retrieval/Embedder")
		const dead = new Embedder(async () => {
			throw new Error("embedder unavailable")
		})
		setActiveMcpToolSet(new ActiveMcpToolSet(dead, new Map(), getRetrievalConfig()))
	}
```

- [ ] **Step 2: Typecheck**

Run: `npm run check-types`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/core/mcp/bootstrap.ts
git commit -m "feat(mcp): build tool index + publish session active set at bootstrap"
```

---

## Task 12: Seed the base set from the first user prompt

**Files:**
- Modify: the task-start path that has the initial user task text. Find it: `grep -rn "initiateTaskLoop\|startTask\|getActiveMcpToolSet" src/core/task` and the LifecycleManager (`src/core/task/LifecycleManager.ts startTask`). Seed right after MCP init completes and the first user message is known.

- [ ] **Step 1: Locate the first-prompt seam**

Run: `grep -rn "initializeMcpForTask\|startTask\|initiateTaskLoop" src/core/task`
Identify the call site where `initializeMcpForTask` is awaited and the initial user task string is in scope.

- [ ] **Step 2: Seed after MCP init**

At that site, after `await initializeMcpForTask(...)`, add:

```ts
	const _activeSet = getActiveMcpToolSet()
	if (_activeSet) {
		await _activeSet.seed(firstUserTaskText)
	}
```

(Use the actual variable holding the first user task text at that location; import `getActiveMcpToolSet` from `@core/mcp/retrieval/session`.)

- [ ] **Step 3: Wire `activeMcpTools` into SystemPromptContext construction**

Find where `SystemPromptContext` is built per request: `grep -rn "providerInfo:" src/core/task | grep -i context` and the `getSystemPrompt(promptContext)` caller (`src/core/task/ApiRequestHandler.ts` and the CLI equivalent). In the object literal that builds the context, add:

```ts
		activeMcpTools: getActiveMcpToolSet()?.snapshot(),
```

- [ ] **Step 4: Typecheck + cli build**

Run: `npm run check-types`
Expected: PASS.
Run: `npm run cli:build`
Expected: build OK.

- [ ] **Step 5: Commit**

```bash
git add src/core/task
git commit -m "feat(mcp): seed base active set from first prompt + expose to prompt context"
```

---

## Task 13: CLI flags `--mcp-top-k` / `--mcp-threshold`

**Files:**
- Modify: `cli/src/index.ts` (two command definitions, near the existing `--mcp` / `--no-mcp` options at ~lines 64-72 and ~286-290)

- [ ] **Step 1: Add the options + env wiring**

For BOTH command definitions that currently declare `--mcp`/`--no-mcp`, add:

```ts
	.option("--mcp-top-k <n>", "Max number of MCP tools to preload by relevance (default 8)")
	.option("--mcp-threshold <τ>", "Min cosine similarity to preload an MCP tool (default 0.3)")
```

In the action handler block where `AILIANCE_NO_MCP` / `AILIANCE_MCP_SERVERS` are set from options, add:

```ts
		if (typeof options.mcpTopK === "string") {
			process.env.AILIANCE_MCP_TOP_K = options.mcpTopK
		}
		if (typeof options.mcpThreshold === "string") {
			process.env.AILIANCE_MCP_THRESHOLD = options.mcpThreshold
		}
```

- [ ] **Step 2: Typecheck + cli build**

Run: `npm run check-types`
Expected: PASS.
Run: `npm run cli:build`
Expected: build OK.

- [ ] **Step 3: Manual smoke**

Run: `node cli/dist/cli.mjs --help`
Expected: `--mcp-top-k` and `--mcp-threshold` appear in the options list.

- [ ] **Step 4: Commit**

```bash
git add cli/src/index.ts
git commit -m "feat(cli): --mcp-top-k / --mcp-threshold tuning flags"
```

---

## Task 14: Full check + e2e regression

**Files:** none (verification)

- [ ] **Step 1: Full typecheck + lint + core tests + cli build**

```bash
npm run check-types
npm run lint
npx cross-env TS_NODE_PROJECT=./tsconfig.unit-test.json mocha
npm run cli:build
```
Expected: all green; new retrieval + find_tools tests included in the mocha count.

- [ ] **Step 2: e2e — tool count + empty-array rate**

Create a temp project and run the multi-file-read task that previously triggered 2 empty-array events/run with 95 tools. Confirm the request now carries ≤ K + ~26 tools and the task completes without an empty-array retry loop.

```bash
mkdir -p /tmp/mcp-e2e/src && cd /tmp/mcp-e2e
printf '# Demo\nA small project.\n' > README.md
printf 'def a(): return 1\n' > src/a.py
printf 'def b(): return 2\n' > src/b.py
node /Users/electron/code/ailiance-agent/cli/dist/cli.mjs -y --json -t 90 \
  "Read the README, then read src/a.py and src/b.py one at a time, then summarize the project." \
  > /tmp/mcp-e2e.json 2>&1
grep -c "without providing a value\|Missing value for required parameter" /tmp/mcp-e2e.json   # expect 0
grep -c '"completion_result"' /tmp/mcp-e2e.json                                                # expect >=1
```
Expected: 0 empty-array events, task completes. (If non-zero, lower `--mcp-threshold` or raise `--mcp-top-k` and re-test; tune the defaults in `config.ts`.)

- [ ] **Step 3: `find_tools` round-trip smoke**

Run a task that needs an MCP capability NOT in the base set (e.g. a github action), and confirm the model calls `find_tools`, the response lists activated tools, and a subsequent turn can call one.

- [ ] **Step 4: `--no-mcp` still fully off**

```bash
node /Users/electron/code/ailiance-agent/cli/dist/cli.mjs -y --json --no-mcp -t 60 "List files here." > /tmp/nomcp.json 2>&1
# confirm no find_tools / no MCP tools loaded, task runs
```

- [ ] **Step 5: Commit any default tuning**

```bash
git add src/core/mcp/retrieval/config.ts
git commit -m "chore(mcp): tune retrieval defaults from e2e (K/findK/threshold)"
```

---

## Task 15: Ship — critic + PR

- [ ] **Step 1: Run the pre-ship critic** (`/ship-critic`) on the branch diff vs `master`; address MAJOR findings.
- [ ] **Step 2: Open PR** `feat/mcp-adaptive-retrieval` → `master` with a body summarizing: problem (95-tool bloat → empty arrays), approach (relevance-gated MCP + find_tools), evidence (e2e tool-count + empty-array rate), supply-chain note (pinned/vendored model).
- [ ] **Step 3:** Do NOT merge until the model weights are mirrored into the `ailiance` org per the HITL supply-chain policy (call this out as a merge blocker in the PR).

---

## Notes for the implementer

- The `missingToolParameterError` wording change (sharper empty-array message) is an independent improvement already in the working tree on this branch; keep it.
- Native tools are NEVER gated — only specs whose `id` is an `mcp__…` qualified name carry the active-set `contextRequirements`. `find_tools` has no `contextRequirements`, so it is always emitted.
- `~/.dirac` is the existing CLI storage dir (see `src/core/storage`); the vector cache lives alongside it.
- If `getSystemPrompt` is also called from the VS Code extension host path, `getActiveMcpToolSet()` returns `undefined` there (no CLI bootstrap) → MCP specs fall back to legacy "all". That is acceptable for v1 (the empty-array problem is CLI/worker-specific); a follow-up can wire the extension host similarly.
