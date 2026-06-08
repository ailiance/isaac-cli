# ISAAC / LISAEL — Consolidation (reliquat post-audit)

**Date:** 2026-06-08
**Branch:** `feat/consolidation-reliquat`

Closes the genuinely-open technical debt remaining after the `simplify-souverain`
work merged most of `AUDIT-DETTE.md` (2026-06-05). Re-verification on
2026-06-08 found ~80% of that audit already resolved (wrapScript whitelist,
Tailscale IPs externalized, `.ailiance-agent`/`.isaac` gitignored, AGENTS.md
rebranded, providers purged to souverain-strict, CI now runs tests as blocking
steps, disk path canonicalized to `~/.isaac`). This spec targets only what is
still open, plus the fresh debt from the LISAEL #4 (portable sessions) work.

## 1. Problem & context

Four small debt pockets remain, spanning security, tests, the LISAEL feature
set, and rebrand cosmetics. They are independent and each independently
testable, so this is one spec delivered in four sequenced lots with gates
(lint, check-types, unit) after each.

Verified open items (file:line as of 2026-06-08):
- **Plugin hooks spawn with `shell: true`** — `src/core/hooks/HookProcess.ts:73`.
  Plugin hook commands load from the user-writable `~/.claude/plugins/cache/`
  with no signature; `shell: true` turns the command string into a shell
  injection surface. (`AUDIT-DETTE.md` #4.)
- **Trace scrubbing misses gateway tokens** — `src/core/tracing/JsonlTracer.ts`
  writes per-task JSONL traces under `.ailiance-agent/runs/` with no redaction
  of `Bearer <token>` / `sk-…` / ailiance gateway keys. (`AUDIT-DETTE.md` #5.)
- **`src/core/tracing/` has zero tests** — the EU AI Act compliance argument
  rests on the tracer, which is untested. (`AUDIT-DETTE.md` #19.)
- **LISAEL #4 half-features**: snapshots never expire (no GC/retention), and
  `/restore` writes a restorable task but does NOT re-enter the live session
  (the live-switch was deferred to avoid a `clearTask()` re-entrancy during
  `loadContext`).
- **Rebrand cosmetics**: `getDiracHomePath` is mis-named (it already returns
  `~/.isaac`).

Non-goals (deliberately excluded): ISAAC.md UI toggle (always-on is fine;
a gRPC-proto toggle is disproportionate); snapshot file permissions (already
`0600` via `writeTaskStateFile` + `0700` snapshots dir); disk-path migration
(already canonical `~/.isaac`); renaming the `dirac.*` VS Code command IDs
(needs a user-facing migration plan — tracked separately, out of scope here).

## 2. Goals

- Remove the plugin-hook shell-injection surface without breaking legitimate
  hooks.
- Guarantee secrets never land in JSONL traces.
- Make the tracer's redaction and record shape testable and tested.
- Make snapshots self-limiting (bounded disk) and `/restore` actually re-enter
  the restored session.
- Fix the one mis-named storage helper.

Each lot leaves the tree green (lint, check-types, root mocha unit, cli vitest).

## 3. Lots

### Lot 1 — Security

**1a. Plugin hook execution hardening** (`src/core/hooks/HookProcess.ts`)
The launcher already calls `spawn(launchConfig.command, launchConfig.args, …)`
(line ~176) but with `shell: true` (line 73). Drop `shell: true` so the command
is executed directly with its explicit `args` array (no shell parsing of the
command string). Where a shell is genuinely required (e.g. a hook whose command
is a shell snippet), run it as `spawn(shellPath, ["-c", snippet], { shell: false })`
with the snippet passed as a single argv element, never interpolated. Confirm
the existing hook tests still pass; add a test that a command containing shell
metacharacters (`; rm -rf x`) is NOT interpreted.

**1b. Trace secret scrubbing** (`src/core/tracing/`)
Add a pure `scrubSecrets(text: string): string` (new `scrub.ts`) that redacts:
`Bearer <token>` → `Bearer ***`, `sk-[A-Za-z0-9_-]{8,}` → `sk-***`, and the
configured ailiance gateway key when present. Apply it in `JsonlTracer` to every
string field before the record is serialized to JSONL. Redaction must be
idempotent and must not corrupt non-secret JSON.

### Lot 2 — Tracing tests

**2a.** New `src/core/tracing/__tests__/`:
- `scrub.test.ts` — each redaction pattern, idempotency, no false-positives on
  ordinary text.
- `JsonlTracer.test.ts` — a recorded event with a `Bearer` token in a field
  lands in the JSONL with the token redacted; the record shape matches the
  documented schema (the layout comment at `JsonlTracer.ts:8`).

### Lot 3 — LISAEL completion

**3a. Snapshot retention/GC** (`src/core/storage/snapshot/`)
Add `pruneSnapshots(store, keep: number)` to `SnapshotStore` (or a sibling) that
deletes all but the `keep` most recent snapshots (by `meta.createdAt`). Default
`keep = 20`. Call it best-effort after each successful `save` (mirrors the #2
remote-GC pattern). A manual `/sessions prune` is out of scope; the auto-prune
on save is enough.

**3b. `/restore` live session re-entry**
`runRestore` already rehydrates the snapshot into a new task id and persists a
`HistoryItem`. Add re-entry WITHOUT the mid-`loadContext` re-entrancy: set a
`pendingRestoreTaskId` on the task state from `runRestore`, and have the task
loop consume it at a safe point (after the current turn completes / before the
next request) to call `controller.reinitExistingTaskFromId(id)`. The
direct-response message changes to confirm the session is being switched. If no
safe consumption point exists without deeper task-loop surgery, fall back to the
current "open from history" behaviour and record why (DONE_WITH_CONCERNS).

### Lot 4 — Rebrand cosmetics

**4a.** Rename `getDiracHomePath` → `getIsaacHomePath` in `src/core/storage/disk.ts`
and update all call sites (grep-driven). Pure rename, no behaviour change.

## 4. Sequencing & testing

Order: Lot 1 → Lot 2 (tests cover Lot 1b) → Lot 3 → Lot 4. Each lot is a small
set of atomic commits ending green on: `npm run lint`, `npm run check-types`,
`npx cross-env TS_NODE_PROJECT=./tsconfig.unit-test.json mocha`, and
`cd cli && CI=1 npx vitest run`.

New tests: scrub + tracer (Lot 2), hook-metachar non-interpretation (Lot 1a),
snapshot prune (Lot 3a), restore-reentry behaviour (Lot 3b).

## 5. Risks / open questions

| Risk | Note |
|------|------|
| Dropping `shell: true` breaks hooks that rely on shell features (pipes, globs) | Mitigate by the explicit `shell -c <snippet>` path for snippet-style hooks; test legitimate + malicious cases. Confirm how existing plugin hooks declare their command (single string vs argv). |
| `/restore` re-entry re-entrancy | The whole reason it was deferred. The pending-flag approach must be consumed strictly outside `loadContext`. If the task loop has no clean hook, ship 3a/1/2/4 and leave 3b as documented deferral rather than forcing unsafe `clearTask()`. |
| Scrub false-negatives | Token formats evolve; keep patterns conservative and central so they're easy to extend. The gateway key is read from config when available rather than guessed. |
| Auto-prune deleting a snapshot mid-restore | Prune runs on save, not restore; restore reads by id. Low risk; prune is best-effort and logged. |

## 6. Out of scope (tracked elsewhere)
- ISAAC.md UI toggle (always-on retained).
- `dirac.*` VS Code command-id rename + migration.
- The Gitea Actions Docker runner repair (infra, not code).
