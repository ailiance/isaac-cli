# LISAEL — Environment Foundation (sub-project #1)

**Date:** 2026-06-07
**Status:** Design approved, pending spec review
**Branch:** `feat/lisael-environment`

LISAEL = *Liaison Inter Système Agentiques Environnement Linker*. Agentic
environment management for isaac: link agents to execution environments
(local, remote SSH, container, cloud) with provisioning, routing, isolation,
and workspace lifecycle.

This spec covers **only sub-project #1: the `Environment` foundation.** It is a
self-contained, mergeable unit. Sub-projects #2 (remote transport) and #3
(portable sessions) get their own specs.

---

## 1. Problem & context

isaac's agent loop (`Task` / `AgentLoopRunner` / `ToolExecutor`) reasons
locally, but its tool handlers perform I/O (file read/write/edit, shell,
ripgrep search) by calling Node `fs` / `child_process` / ripgrep **directly**.
The "hands" are hard-wired to the local machine. There is no seam to make those
actions land in a different environment (the MacStudio over SSH, a container, a
cloud sandbox).

LISAEL's chosen shape (from brainstorming):
- **Nature:** environment liaison.
- **Primary flow:** a *unified abstraction layer* (the "linker") + *portable
  agent sessions* (state continuity across environments).
- **Architecture:** **remote hands, local brain** — the LLM loop stays local;
  only tool-side I/O is environment-pluggable.
- **Transport (for #2):** a **LISAEL daemon + protocol** (chosen over per-op SSH
  and sync/mount).

### Existing building blocks LISAEL leans on
`local-router`/gateway (routing), git worktrees (isolation), SSH MacStudio
(remote), ACP + `SubagentRunner` (delegated execution), the headless CLI mode
(`isaac task -y`) + the new E2E harness (`cli/tests/e2e/`).

### Inspiration (architectural only, no code reuse)
- **Codex "for every role/tool/workflow"** — local ↔ cloud-sandbox hand-off,
  provisioned environments, environment-agnostic agent execution.
- **ChatGPT memory "dreaming"** — background-consolidated, time-fresh persistent
  state (informs #3 portable sessions, not #1).
- **OpenAI Agents SDK (models/providers)** — explicit per-agent / per-run /
  process-default model resolution (informs per-environment model/provider
  resolution, a later concern).

---

## 2. Goals & non-goals (sub-project #1)

### Goals
1. Define an `Environment` interface that abstracts all workspace I/O the tool
   handlers need (files, shell, search).
2. Ship `LocalEnvironment` that reproduces **current behavior 1:1**.
3. Migrate every I/O consumer (handlers + relevant services) to go through an
   injected `Environment` instead of direct `fs`/`child_process`/ripgrep.
4. Centralize cwd-relative path resolution in the `Environment`.
5. Single selection seam (`resolveEnvironment(config)`) wired through
   `TaskFactory`, used by both CLI and extension.
6. Test scaffolding: `InMemoryEnvironment` + a reusable conformance suite +
   an E2E dimension.

### Non-goals (explicitly out of scope for #1 — YAGNI)
- No `RemoteEnvironment`, no daemon, no transport (that is #2).
- No portable sessions / `snapshot`/`restore` / "dreaming" (that is #3).
- No per-environment model/provider resolution.
- `browser_action`, MCP transport, web tools — unchanged, not routed through
  `Environment`.

### Success criteria
- Existing suites stay green (proof of behavior-preservation):
  root `npm run test:unit` (1277), `cd cli && CI=1 npm test` (554), webview
  vitest (87), all typechecks, lint.
- New: handler tests run against `InMemoryEnvironment`; conformance suite passes
  for `Local` + `InMemory`; E2E harness runs with an explicit `LocalEnvironment`.
- No tool handler imports `node:fs` / `node:child_process` / ripgrep directly.

---

## 3. Architecture

```
        Task / AgentLoopRunner / ToolExecutor       (brain — always local)
                          │ uses (injected)
                          ▼
                 ┌────────────────────┐
                 │     Environment     │   ← single interface (the "linker")
                 │   (I/O contract)    │
                 └────────────────────┘
              ┌───────────┴─────────────┐
     LocalEnvironment            RemoteEnvironment   (#2 — later)
     fs / child_process / rg     → LISAEL daemon over protocol
```

- The agent loop is unchanged and local.
- Tool handlers receive an `Environment` via the tool-execution context and use
  only its methods.
- `LocalEnvironment` wraps today's implementations verbatim.
- tree-sitter (`list_code_definition_names`) stays **local**: it reads file
  content via `Environment.readFile`, then parses in-process. No remote
  tree-sitter.
- Checkpoints (git shadow) run through `Environment.exec`.

---

## 4. The `Environment` interface (contract)

```ts
export interface Environment {
  readonly id: string          // "local" | "ssh:studio" | "container:<id>"
  readonly cwd: string         // workspace root within THIS environment

  // --- Files (paths are cwd-relative; the Environment resolves them) ---
  readFile(path: string): Promise<string>
  writeFile(path: string, content: string): Promise<void>
  exists(path: string): Promise<boolean>
  stat(path: string): Promise<EnvStat>           // { isDir, size, mtimeMs }
  list(path: string, opts?: { recursive?: boolean }): Promise<DirEntry[]>
  mkdir(path: string, opts?: { recursive?: boolean }): Promise<void>
  delete(path: string, opts?: { recursive?: boolean }): Promise<void>
  rename(from: string, to: string): Promise<void>

  // --- Search (ripgrep) ---
  search(pattern: string, opts: SearchOpts): Promise<Match[]>

  // --- Process (streaming: required for execute_command) ---
  exec(cmd: string, opts?: ExecOpts): ExecHandle

  dispose(): Promise<void>
}

export interface ExecHandle {
  readonly stdout: AsyncIterable<string>
  readonly stderr: AsyncIterable<string>
  writeStdin(data: string): void
  kill(signal?: NodeJS.Signals): void
  readonly exitCode: Promise<number>
}
```

Notes:
- **`exec` streaming is the delicate part** — the CLI streams live output and
  supports kill/stdin. It returns a handle, not a flat promise.
- **Path resolution** is the `Environment`'s responsibility (cwd-relative). No
  `path.resolve` against the local cwd inside handlers.
- The interface is **sufficient for #2** (the daemon implements these ops 1:1
  remotely) and **#3** (`id`/`cwd` plus a future optional `snapshot()/restore()`
  carry session state) — without changing the interface.
- Decision: `search` is **in** the interface from #1 (ripgrep must be remote in
  #2); tree-sitter stays local consuming `readFile`.

---

## 5. Refactor plan

### Consumers to migrate
- **Files:** `ReadFileToolHandler`, `WriteToFileToolHandler`,
  `EditFileToolHandler` (+ `edit-file/BatchProcessor`, `DiffViewProvider`),
  `ListFilesToolHandler`.
- **Shell:** `ExecuteCommandToolHandler` (streaming + kill + stdin).
- **Search:** `search_files` handler → `Environment.search`;
  `list_code_definition_names` → `readFile` + local parse.
- **Checkpoints:** `CheckpointGitOperations` (git) → `Environment.exec`.
- **Support:** `FileContextTracker`, scattered path resolution.

### Out of scope (unchanged)
`browser_action`, MCP connections, web/link tools.

### Discipline
- `LocalEnvironment` reproduces current behavior **1:1**; the existing suites are
  the behavior-preservation contract.
- **Incremental migration by group**, gates green after each:
  1. interface + `LocalEnvironment` + wiring seam (no handler changes yet)
  2. file handlers
  3. shell handler
  4. search handlers
  5. checkpoints + support
- **Boundaries:** handlers depend only on the `Environment` interface — no
  `node:fs` / `node:child_process` / ripgrep imports remain in them.

---

## 6. Wiring (dependency injection)

- `TaskFactory.buildTaskManagers` constructs the `Environment` (default
  `LocalEnvironment`) and injects it into the tool-execution context, alongside
  the other managers.
- Single selection seam: `resolveEnvironment(config): Environment`. For #1 it
  always returns `LocalEnvironment`. #2 extends it to return `RemoteEnvironment`
  based on a flag/config (e.g. `--env ssh:studio`).
- Both the CLI (`cli/`) and the extension host go through this seam — no
  duplicated I/O wiring.

---

## 7. Testing

- **`InMemoryEnvironment`** (temp-dir backed): fast, deterministic handler tests
  with no real-fs coupling. Extends the existing E2E harness (`cli/tests/e2e/`).
- **Conformance suite:** one set of assertions run against every `Environment`
  implementation (`Local`, `InMemory`, later `Remote`) — guarantees identical
  behavior across environments.
- **Behavior preservation:** the existing 1277 + 554 + 87 suites must stay green
  on the `LocalEnvironment` path.
- **E2E dimension:** the headless-CLI mock-LLM E2E runs with an explicit
  `LocalEnvironment` now; the same harness targets `RemoteEnvironment` in #2.

---

## 8. Error handling

- I/O errors surface as typed `EnvironmentError` (with `op`, `path`, cause),
  caught by handlers and reported to the agent exactly as today (no silent
  swallowing — consistent with the fork's no-silent-failure stance).
- `exec` non-zero exit is **not** an error of the handle (it resolves
  `exitCode`); transport/spawn failures reject.
- For #1, `LocalEnvironment` failures map to current Node error behavior 1:1.

---

## 9. Forward-compatibility (#2 / #3)

- **#2 `RemoteEnvironment`** implements the same interface over the daemon
  protocol; the protocol mirrors the ops 1:1. Daemon bootstrapped via
  SSH / `docker exec` (Node + bundle in-env). Conformance suite runs against it.
  No change to handlers or interface.
- **#3 Portable sessions** add an optional `snapshot()/restore()` plus
  persistence of task state (`.isaac`, history, checkpoints) carried by the
  daemon; "dreaming"-style background consolidation is a later enhancement.

---

## 10. Risks & mitigations

| Risk | Mitigation |
|------|------------|
| Large refactor surface (many handlers + tests) | Incremental by group; gates green per group; `LocalEnvironment` 1:1 |
| `exec` streaming semantics drift (live output/kill/stdin) | Port `ExecuteCommandToolHandler` carefully; dedicated streaming `ExecHandle`; cover with tests |
| Hidden path-resolution edge cases | Centralize in `Environment`; rely on existing suite to catch regressions |
| Scope creep into #2/#3 | Hard non-goals above; #1 ships interface + Local only |

---

## 11. Decomposition (whole LISAEL)

1. **#1 — `Environment` foundation** (this spec): interface + `LocalEnvironment`
   + handler migration + tests.
2. **#2 — Remote transport:** `RemoteEnvironment` + LISAEL daemon + protocol +
   bootstrap (SSH / container / cloud).
3. **#3 — Portable sessions:** state snapshot/restore + migration/resume +
   background consolidation.

Each sub-project gets its own spec → plan → implementation cycle.
