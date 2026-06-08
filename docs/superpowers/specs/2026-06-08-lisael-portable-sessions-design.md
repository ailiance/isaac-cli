# LISAEL — Portable Sessions (sub-project #4)

**Date:** 2026-06-08
**Branch:** `feat/lisael-portable-sessions`

LISAEL = *Liaison Inter Système Agentique Environnement Linker*. Sub-projects
#1–#3 delivered the `Environment` abstraction (#1), remote transport over a
daemon (#2 / #2.x SSH+sync / #2.z docker), and background memory consolidation
(#3 dreaming + #3.x decay/embeddings). #4 makes a *session itself* portable:
the agent state can be snapshotted to a named point and restored later — on the
same machine (temporal rollback) or on a different `Environment` (cross-machine
migration).

## 1. Problem & context

A running task accumulates state on disk: conversation history, context
history, UI messages, and task metadata (see `src/core/storage/disk.ts`
`GlobalFileNames`). Today this state is read back only implicitly on resume
(`readTaskHistoryFromState`); there is **no first-class snapshot/restore
primitive**. Two needs follow from the LISAEL goal of running the same agent
across environments:

- **Cross-machine migration:** start a task locally, continue it on `studio`
  (or a container) with the same conversation and context — leaning on the
  `Environment` seam that #2 already uses to reach remote hosts.
- **Temporal rollback:** return a session to an earlier point (undo the last N
  turns, branch a variant) without losing the ability to go forward again.

Both reduce to one primitive: serialize the agent-state bundle to a portable,
addressable snapshot, and rehydrate it on demand through an `Environment`.

## 2. Goals & non-goals

**Goals**
- A pure, testable serialization primitive for the agent-state bundle.
- A snapshot store that reads/writes through the `Environment` interface, so
  the *same* code path serves local and remote targets.
- Restore that rehydrates state into a task directory and reuses the existing
  resume path — no parallel resume logic.
- Manual slash commands: `/snapshot [label]`, `/restore <id>`, `/sessions`.
- Atomic, non-destructive restore (a failed restore never corrupts the live
  session).

**Non-goals (explicitly out of scope for #4)**
- Workspace **file** transport — already handled by #2.x rsync + conflict
  resolution. A snapshot carries agent state only; files are reconciled by the
  existing Environment sync.
- Automatic checkpoints (per-turn / pre-risky-action). Manual only for now;
  auto-checkpointing can build on this primitive later.
- Snapshot retention / GC policy (mirror how #2 added GC as its own step).
- Encryption-at-rest beyond the existing storage trust model.

## 3. Architecture

```
  /snapshot [label]                          /restore <id>
        │                                          │
        ▼                                          ▼
  ┌───────────────┐   serialize          ┌──────────────────┐
  │ current task  │ ───────────────►     │  SnapshotStore   │
  │ state files   │                      │  .load(env, id)  │
  └───────────────┘                      └────────┬─────────┘
        │  SnapshotStore.save(env, snap)          │ deserialize
        ▼                                          ▼
  ┌──────────────────────────┐            ┌──────────────────┐
  │ snapshots/<snapId>/       │            │ restore.rehydrate│
  │   meta.json               │            │  → target taskId │
  │   api_conversation_*.json │            └────────┬─────────┘
  │   context_history.json    │                     │ existing resume path
  │   ui_messages.json        │                     ▼
  │   task_metadata.json      │            ┌──────────────────┐
  └──────────────────────────┘            │ readTaskHistory  │
        ▲ via Environment (local OR remote)│ FromState        │
        │                                  └──────────────────┘
   same interface reaches a remote host (#2 daemon / SSH)
```

The store is parameterized by an `Environment`. Writing a snapshot to a remote
host and reading it back there is the *same* call as locally — that is what
makes a session portable without a second transport layer. Workspace files are
out of band: reconciled by the #2.x sync when the task continues on the target.

## 4. Components

| File | Responsibility |
|------|----------------|
| `src/core/storage/snapshot/SessionSnapshot.ts` | Bundle types + `serialize(stateFiles) → SnapshotBundle` and `deserialize(bundle) → stateFiles`. Pure, no I/O. |
| `src/core/storage/snapshot/SnapshotStore.ts` | `save(env, bundle, meta)`, `list(env) → SnapshotMeta[]`, `load(env, id) → SnapshotBundle`. All I/O via injected `Environment`. |
| `src/core/storage/snapshot/restore.ts` | `rehydrate(bundle) → taskId`: writes state files into a (new or target) task dir atomically, returns the id the resume path consumes. |
| `src/core/slash-commands/` (new handlers) | `/snapshot [label]`, `/restore <id>`, `/sessions` wired to the store + current task context. |
| `__tests__/` co-located | Round-trip, store-against-`InMemoryEnvironment`, restore, slash-command tests. |

Each unit has one purpose and a narrow interface: `SessionSnapshot` is pure data
transformation; `SnapshotStore` is the only I/O boundary; `restore` is the only
writer into task dirs; slash commands are thin wiring. None needs to read the
others' internals.

## 5. Snapshot shape (on disk)

```
snapshots/<snapId>/
  meta.json            { id, label, sourceTaskId, createdAt, env, schemaVersion }
  api_conversation_history.json
  context_history.json
  ui_messages.json
  task_metadata.json
```

- `snapId` — short, collision-resistant id (scheme finalized in the plan;
  align with existing id helpers rather than inventing a new one).
- `schemaVersion` — integer; bump on any bundle-shape change. Restore refuses a
  version it does not understand (see §7).
- `env` — provenance label (e.g. `local`, `ssh:studio`) for `/sessions` display
  and debugging; not load-bearing for restore.

## 6. Data flow

- **`/snapshot [label]`** — resolve current task id → read its state files via
  the active `Environment` → `SessionSnapshot.serialize` → `SnapshotStore.save`
  with a fresh `snapId` and `meta` → report `snapId` + label.
- **`/sessions`** — `SnapshotStore.list` → table (`id  label  age  env`).
- **`/restore <id>`** — `SnapshotStore.load(id)` → validate `schemaVersion` →
  `restore.rehydrate` into a task dir → hand the resulting taskId to the
  existing resume path. For a different target environment, `save`/`load` run
  against that env; workspace files are reconciled by #2.x sync when the task
  resumes there.

## 7. Error handling

- **Missing / unreadable / corrupt snapshot** → typed error; `/restore` aborts
  **before** touching the live session. The current task is never mutated on a
  failed restore.
- **Schema-version mismatch** → explicit refusal with the offending version in
  the message. No silent partial restore.
- **Atomic rehydrate** → write state files to a temp task dir, then swap
  (reuse the temp-write + rename pattern already in `disk.ts`). A crash
  mid-restore leaves either the old state or the new, never a mix.
- **Cross-env write failure** → the source snapshot is left intact; the error
  surfaces to the caller. No half-written snapshot is listed.

## 8. Testing

- **Unit (pure):** `serialize` → `deserialize` round-trips to an identical
  bundle; unknown `schemaVersion` is rejected.
- **Unit (store):** `save` / `list` / `load` against `InMemoryEnvironment`
  (already exists for handler tests) — no disk needed.
- **Integration:** snapshot → restore rehydrates byte-identical state files;
  rollback produces a task whose history is truncated to the snapshot point;
  a corrupt snapshot leaves the live session untouched.
- **Slash commands:** `/snapshot`, `/restore`, `/sessions` happy-path + the
  missing-id and bad-version error paths.

## 9. Risks / open questions

| Risk / question | Note |
|-----------------|------|
| State machine is implicit | `TaskState` is not serialized explicitly today. The plan must confirm what runtime state beyond the JSON files must be captured (in-flight tool call, pending checkpoint) or documented as deliberately dropped on restore. |
| `snapId` scheme | Reuse an existing id helper; do not invent a parallel scheme. Decide in the plan. |
| Retention / GC | Out of scope for #4 (manual only). Add later as its own step, as #2 did for GC. |
| Secrets in history | `api_conversation_history.json` may hold sensitive content. Snapshots inherit the existing storage trust model; cross-machine transport relies on the Environment's security (SSH). Scope is **not** expanded here. |
| Workspace divergence on restore | Files are reconciled by #2.x sync, not the snapshot. The plan should define the UX when the target workspace differs from the snapshot's `sourceTaskId` expectation. |

## 10. Sequencing

Single implementation plan, built bottom-up so each layer is testable before
the next:

1. `SessionSnapshot` (pure serialize/deserialize) + round-trip tests.
2. `SnapshotStore` over `Environment` + `InMemoryEnvironment` tests.
3. `restore.rehydrate` (atomic) + integration test against the resume path.
4. Slash commands `/snapshot`, `/restore`, `/sessions` + command tests.
5. Full gates (lint, check-types, unit) + PR.
