# LISAEL — Dreaming: background memory consolidation (sub-project #3)

**Date:** 2026-06-07
**Status:** Design approved, pending spec review
**Branch:** `feat/lisael-dreaming`
**Builds on:** #1/#2/#2.x (merged). Independent of the remote stack — this is a memory feature.

Inspired by ChatGPT's "dreaming" memory synthesis. A background worker consolidates
durable, structured memory from session transcripts so future sessions start with
relevant context instead of from scratch.

---

## 1. Problem & context

isaac persists explicit memories (`isaac memory remember`) and run transcripts, but
it does not **learn passively**: nothing distills what happened across sessions into
durable memory. #3 adds a background consolidation pass ("dreaming") that reads new
transcripts, synthesizes structured memory entries, and writes them to the existing
memory store — where they are **already auto-reinjected** into future sessions.

### Key simplification (from code exploration)
Auto-reinjection is **already wired**: `PromptBuilder.preparePlaceholders`
(`src/core/prompts/system-prompt/registry/PromptBuilder.ts:50-58`) calls
`loadRelevantMemories(cwd, userPrompt)` → `formatMemoriesSection` →
`{{MEMORIES_SECTION}}`. **If dreaming writes to the existing store via `saveMemory`,
reinjection is automatic — no new wiring.** This collapses most of the design.

### Decisions locked in brainstorming
- **Nature:** dreaming = background memory consolidation.
- **Scope:** **both layers** — project (`scope: project:<slug>`) + user (`scope: global`).
- **Trigger:** **background/idle worker** (closest to ChatGPT).

### Existing building blocks (verified)
- **Store:** `src/utils/ailiance-memory.ts` — markdown+frontmatter in
  `~/.ailiance-agent/memory/<name>.md` (global) and `…/project_<slug>/<name>.md`
  (project). CRUD: `saveMemory`, `listMemories`, `deleteMemory`, `findMemories`.
  Frontmatter: `name, description, type, scope, created`.
- **Reinjection:** `loadRelevantMemories`/`formatMemoriesSection` (already in the
  prompt) — token-overlap ranked, 8 000-char budget, project ranked over global.
- **Corpus:** `<cwd>/.ailiance-agent/runs/<taskId>/trace.jsonl` + `meta.json`
  (`src/core/tracing/JsonlTracer.ts`, already secret-scrubbed). `TraceLine`:
  `turn, phase, planner_request/response, tool_execution, errors`.
- **Background pattern:** `SyncWorker` (`src/shared/services/worker/worker.ts`) —
  setInterval + `isProcessing` guard + start/stop + singleton; wired in
  `common.ts` `initialize`/`tearDown`.
- **LLM pass (off-task):** `buildApiHandler(disableThinking(config), "act")` +
  `createMessage(systemPrompt, [{role:"user",content}])` (async-generator), per
  `cli/src/agent/review.ts:277`. No eco-tier exists — reuse current config.

---

## 2. Goals & non-goals (#3 MVP)

### Goals
1. A `DreamWorker` (background loop, SyncWorker pattern) that, when idle, finds
   **un-consolidated** run transcripts (via a per-project cursor) and consolidates
   them.
2. A `MemorySynthesizer` — one LLM pass over a transcript batch → structured
   memory entries (project + user scope), deduped/merged against existing memory,
   with **freshness** (timestamps; stale entries revised/expired).
3. Persist via the **existing** `saveMemory` (extended frontmatter: `source:
   "dreamed"`, `lastSeenAt`), so `memory list/show/forget` and auto-reinjection work
   unchanged.
4. A processed-cursor store (per project) so transcripts are consolidated once.
5. Wire the worker into the existing lifecycle (`common.ts` host; a CLI attach
   point), opt-in/safe (off by a setting or when no API config).
6. Tests: deterministic pipeline tests with a **mocked LLM** (cursor advances,
   dedup, freshness/expiry, store round-trip).

### Non-goals (deferred)
- Synthesis *quality* tuning (judged by use, not by a gate — see Risks).
- Embeddings/semantic retrieval of memories (current token-overlap ranking stays).
- A dedicated eco model tier (reuse current API config; add later).
- Real-time/online consolidation; cross-device sync of memory.
- Privacy UI beyond the existing `memory list/forget` review surface.

### Success criteria
- Pipeline tests pass (mocked synthesizer): cursor advances and never re-processes;
  dedup/merge; stale entries expired; entries land in the store readable by
  `listMemories`/`loadRelevantMemories`.
- Worker is opt-in/safe: no-op without API config or when disabled; never blocks a
  task; throttled.
- Gates green; default behavior unchanged when dreaming is off.

---

## 3. Architecture

```
  <cwd>/.ailiance-agent/runs/<taskId>/trace.jsonl   (corpus, scrubbed)
        │  DreamWorker (idle loop): cursor -> new transcripts since last run
        ▼
  MemorySynthesizer  ── LLM pass (buildApiHandler + createMessage) ──>
        │  structured candidates { scope, type, name, description, body, source:"dreamed", createdAt, lastSeenAt }
        │  merge/dedup vs existing (listMemories) ; mark stale
        ▼
  saveMemory  ->  ~/.ailiance-agent/memory/{<name>.md | project_<slug>/<name>.md}
        │
        ▼  (already wired) loadRelevantMemories -> formatMemoriesSection -> {{MEMORIES_SECTION}} in the next session
```

- The only genuinely new pieces are the **worker loop**, the **synthesizer**, and a
  **cursor**. Storage and reinjection reuse existing code.

---

## 4. Components (files)

New under `src/services/memory/dreaming/`:
- `DreamWorker.ts` — SyncWorker-style loop: `start(intervalMs)`/`stop()`, singleton,
  `isProcessing` guard. Each tick: read cursor → list new run dirs under
  `.ailiance-agent/runs/` not yet processed → call the synthesizer → advance cursor.
  No-op if disabled or no API config.
- `MemorySynthesizer.ts` — `synthesize(transcripts, existing): Candidate[]`: builds a
  prompt from the (scrubbed) transcript batch, runs `buildApiHandler(...).createMessage`,
  parses structured entries (project + user scope), dedups/merges vs `existing`,
  flags stale.
- `corpusCursor.ts` — read/write a per-project cursor (processed taskIds /
  timestamp) at `~/.ailiance-agent/memory/.dream-cursor.json`.
- `transcriptReader.ts` — read + condense a run's `trace.jsonl`/`meta.json` into a
  compact text the synthesizer consumes (turns, tools used, errors, outcome).

Modified:
- `src/utils/ailiance-memory.ts` — extend frontmatter with optional `source` +
  `lastSeenAt` (backward-compatible: existing files lack them). `saveMemory`/parser
  round-trip them; `listMemories` exposes them.
- `src/common.ts` — `initialize()` starts `DreamWorker` (gated by a setting +
  API-config presence); `tearDown()` stops it. (CLI: attach via the agent/cleanup
  lifecycle, or rely on the host worker; confirm in planning.)

---

## 5. Memory entry shape (extended)

```
---
name: <kebab-slug>
description: <one-line>
type: project | user | feedback | reference
scope: global | project:<slug>
created: <ISO>
source: dreamed            # NEW (optional; absent = human/remember)
lastSeenAt: <ISO>          # NEW (optional; freshness — bumped when re-observed)
---
<body: the consolidated fact/preference/project-note>
```

- Freshness: on each dream pass, a re-observed fact bumps `lastSeenAt`; entries not
  re-observed for N passes / older than a TTL are revised or `deleteMemory`-d.
- Dreamed entries are first-class: `memory list/show/forget` operate on them; users
  can review/remove (the privacy surface).

---

## 6. Testing

- **Cursor:** advances past processed runs; never re-processes; resumes correctly.
- **Synthesizer (mocked LLM):** `vi.mock("@/core/api")` with a `createMessage`
  async-generator yielding canned structured entries; assert candidates parsed,
  deduped vs existing, stale flagged.
- **Store round-trip:** dreamed entries written via `saveMemory` are read back by
  `listMemories`/`loadRelevantMemories` with `source`/`lastSeenAt` preserved;
  existing (source-less) files still parse.
- **Worker:** no-op when disabled / no API config; `isProcessing` guard prevents
  overlap; stop() is clean.
- **Behavior preservation:** with dreaming off, the memory store + reinjection
  behave exactly as today; existing `ailiance-memory` tests stay green.

---

## 7. Risks / open questions

| Item | Resolution |
|------|------------|
| Synthesis **quality** is not gate-validatable | MVP proves the **pipeline** (mocked LLM); quality is iterated via a manual eval + the `memory list` review surface. State this openly; do not claim quality from green tests. |
| LLM cost of dreaming | Throttle (long interval, batch caps); gate behind a setting; reuse current config (eco-tier later). No-op without API config. |
| Privacy (global/user memory = sensitive) | Dreamed entries are reviewable/removable via `memory list/forget`; default project-scope bias; consider a per-scope opt-out in planning. |
| CLI has no idle loop (short-lived process) | Host worker covers the extension; for CLI, attach a consolidation pass at session end as a fallback, or a `isaac memory dream` manual trigger. Confirm in planning. |
| `saveTaskMetadata` non-atomic / corrupt files | Reader tolerates corrupt entries (quarantine pattern already in `ailiance-memory`); the dreamer skips unreadable runs. |
| Cursor races (multiple isaac instances) | Reuse the `ailiance-memory` `.rebuild.lock` mkdir-lock pattern for cursor writes. |

---

## 8. Decomposition

1. **#3 (this spec):** DreamWorker + MemorySynthesizer + cursor + frontmatter
   extension + lifecycle wiring; mocked-LLM pipeline tests. Both scopes.
2. **#3.x:** quality tuning, eco model tier, embeddings/semantic memory retrieval,
   richer freshness/decay, privacy controls.
