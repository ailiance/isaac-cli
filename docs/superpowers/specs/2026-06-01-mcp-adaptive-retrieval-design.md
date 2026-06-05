# Adaptive MCP Tool Retrieval — Design

**Date:** 2026-06-01
**Status:** Approved (design) — pending implementation plan
**Component:** `src/core/mcp/retrieval/` (new), `src/core/mcp/bootstrap.ts`, `src/core/prompts/system-prompt/registry/IsaacToolSet.ts`, `cli/src/index.ts`

## Problem

ISAAC sends every registered tool schema to the worker on every request. With the
default Claude-Code plugin MCP set loaded, that is **~95 tool schemas** (25 native +
~70 MCP) ≈ **41k tokens per turn**. Measured this session:

- 95 tools → the worker (Qwen3-Coder-30B Q4) intermittently streams a well-formed but
  **empty required array** (`read_file {"paths":[]}`), failing validation and spinning
  the agent into a retry loop. Reproduced deterministically: ~2 empty-array events per run.
- 25 tools (`--no-mcp`) → **0 empty-array events** across runs.

Tool-list bloat is the proven primary cause (and the dominant per-turn latency driver).
Two non-fixes were ruled out empirically: forcing `temperature=0` (made retries a
deterministic lock — counterproductive) and a sharper retry message alone (the model
still repeated the empty call under 95-tool load).

## Goal

Replace "inject all ~70 MCP tools every request" with "inject only the MCP tools relevant
to the current need, automatically." Native tools stay always-on. The result keeps the
per-request tool count low (≤ K + 26) without the user manually curating an allowlist.

## Decisions (locked)

| Axis | Decision |
|------|----------|
| Granularity | **Hybrid** — per-session base set + on-demand expansion |
| Matching mechanism | **Local embedding in the CLI** — MiniLM `all-MiniLM-L6-v2` ONNX (transformers.js); no gateway hop, offline-capable |
| Expansion trigger | **Meta-tool `find_tools(query)`** the model calls when it needs a capability it lacks |
| Base set sizing | **Cap + threshold** — at most K MCP tools, only those with cosine similarity ≥ τ (may be **empty**) |

Default knobs (tune empirically): **K = 8** (base cap), **K′ = 5** (find_tools cap),
**τ = 0.3** (cosine threshold).

## Architecture

Native tools (the 25 `IsaacDefaultTool`) and `find_tools` are **always** emitted. MCP
tool specs are **gated** by an "active set" of qualified names, selected by relevance.

### Components (`src/core/mcp/retrieval/`)

1. **Embedder** — wraps a local MiniLM `all-MiniLM-L6-v2` ONNX model via transformers.js.
   Lazy-loaded on first use; model weights pinned/vendored and cached in the user/config
   dir. Interface: `embed(texts: string[]) → Float32Array[]` (384-d), plus a `cosine(a, b)`
   helper. Mean-pooled + L2-normalized embeddings.

2. **Tool index** — at bootstrap, after MCP specs are loaded, embed each MCP tool's text
   (`name + "\n" + description`) once. Vectors are **persisted on disk**, keyed by
   `qualifiedName` + a hash of the description, so the index is reused across sessions and
   only re-embeds tools whose description changed. Native tools are NOT indexed.

3. **Active-set manager** — session-scoped set of active MCP `qualifiedName`s.
   - *Session start:* embed the first user task prompt → cosine vs the tool index →
     select MCP tools with `sim ≥ τ`, capped at the top K → base active set (possibly empty).
   - *`find_tools(query)`:* embed `query` → top matches (`sim ≥ τ`, capped at K′) → **add**
     to the active set; the handler returns the newly-activated tool names + one-line
     descriptions so the model knows what is now callable.

4. **Assembly gate** — at the per-request seam in `IsaacToolSet.getEnabledToolSpecs`
   (already runs every request): emit all native specs + `find_tools` + only the MCP
   specs whose `qualifiedName` is in the active set. Native filtering by
   `contextRequirements` is unchanged.

5. **`find_tools` native tool** — `name: "find_tools"`, param `query: string`
   ("describe the capability you need"). Registered like other `IsaacDefaultTool`s,
   always-on (never gated). Its handler mutates the active-set manager and returns a
   compact list of activated tools.

### Data flow

```
bootstrap            : load MCP specs → embed+cache tool vectors → register specs (gated)
task start           : embed first user prompt → cosine top-K (≥τ) → base active set
each request (gate)  : native specs + find_tools + active-set MCP specs   [NO embedding here]
model calls find_tools(query) : embed query → top-K′ (≥τ) → grow active set → next turn includes them
```

The per-request path performs **no embedding** — the active set is precomputed; only
`find_tools` calls (and the one-shot session-start selection) embed text.

### Flag composition

- **default** = adaptive (base = cap+threshold, `find_tools` on).
- `--no-mcp` = fully off: no MCP servers, no embedder load, no `find_tools` (existing
  `AILIANCE_NO_MCP` path, unchanged).
- `--mcp a,b` = restrict the **candidate pool** to servers `a,b`; retrieval and
  `find_tools` only see tools from those servers (existing `AILIANCE_MCP_SERVERS` path,
  reinterpreted as the pool the retriever ranks over).
- New optional tuning flags: `--mcp-top-k <K>`, `--mcp-threshold <τ>` (sane defaults; env
  fallbacks `AILIANCE_MCP_TOP_K`, `AILIANCE_MCP_THRESHOLD`).

### Error handling / fallback

- Embedder load or inference failure → **degrade to native-only with MCP off** (the
  proven 25-tool state that produced 0 empty-array events) + a single warning log;
  `find_tools` returns "tool retrieval unavailable." Never crash; never fall back to the
  full 95-tool flood.
- Session-start embedding is best-effort: failure → empty base set (model can still
  `find_tools`, which will also report unavailable if the embedder is down).
- Tool-vector cache entry is invalidated when the description hash changes.

### Latency budget

- Model download once (~88 MB, cached). Tool-index embedding: ~70 short texts once per
  bootstrap, cached across sessions → tens of ms first time, ~0 afterward.
- Per request: **0 embedding** (active set precomputed).
- `find_tools`: embeds 1 query (~ms on CPU).

## Testing

- **Unit:** embedder wrapper (mocked model); cosine top-K selection with threshold + cap
  edge cases (empty pool, all-below-threshold → `[]`, ties, cap boundary); active-set
  manager (add, dedup, pool restriction); assembly gate (native always present, MCP gated
  correctly, `find_tools` always present).
- **Integration:** bootstrap → index → base selection against a fixture MCP tool set;
  `find_tools` expands the active set; `--no-mcp` disables everything; `--mcp a,b` scopes
  the candidate pool.
- **Regression / e2e:** the repro task (read several files in sequence) now sends
  ≤ K + 26 tools, and the empty-array event rate drops materially versus the 95-tool
  baseline.

## Supply-chain (HITL policy)

- Pin the embedding library (transformers.js) by exact version + integrity hash in the
  lockfile.
- Vendor/mirror the `all-MiniLM-L6-v2` ONNX weights into the `ailiance` org against a
  frozen baseline; do not pull from the public HF CDN at runtime in production.
- Add both to the SBOM. Human-in-the-loop diff review before any upgrade.

## Out of scope

- Re-selecting tools automatically every turn (rejected in favor of the hybrid meta-tool
  trigger — bounded latency, no churn).
- A gateway-side `/v1/embeddings` endpoint (rejected in favor of local embedding — no hop,
  offline).
- Changing native-tool filtering or the `contextRequirements` mechanism.
- The separate `missingToolParameterError` wording improvement (already a small standalone
  change; complementary but not part of this feature).

## Open defaults to validate during implementation

`K=8`, `K′=5`, `τ=0.3` are starting points; validate against the repro harness and adjust
so a pure-coding task yields a near-empty base set while genuinely tool-needing tasks
surface the right MCP tools.
