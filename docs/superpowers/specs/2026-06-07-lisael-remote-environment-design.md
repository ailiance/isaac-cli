# LISAEL — RemoteEnvironment + daemon (sub-project #2)

**Date:** 2026-06-07
**Status:** Design approved, pending spec review
**Branch:** `feat/lisael-remote`
**Builds on:** sub-project #1 (`Environment` foundation, merged) — `docs/superpowers/specs/2026-06-07-lisael-environment-foundation-design.md`

LISAEL = *Liaison Inter Système Agentiques Environnement Linker*. #1 introduced the
`Environment` interface (local brain, pluggable hands) with `LocalEnvironment`.
This spec covers **sub-project #2: a `RemoteEnvironment` that runs tool I/O in a
separate process over a JSON-RPC protocol, with a daemon that executes those ops.**

The MVP validates the **protocol** against a **locally-spawned daemon subprocess**
(no network). SSH (MacStudio), container, and cloud transports are deferred to
sub-iterations #2.x; portable sessions are #3.

---

## 1. Problem & context

#1 made tool I/O pluggable behind `Environment`, but only `LocalEnvironment`
exists — the hands still run on the same machine as the brain. #2 adds a
`RemoteEnvironment` so the agent's file/shell/search ops execute in a *different
process* (and later, a different machine/container/cloud), while the LLM loop
stays local.

### Decisions locked in brainstorming
- **Target first:** abstraction-first — a daemon spawned as a **local subprocess**
  (same machine), to prove the protocol before any network transport.
- **Transport/protocol:** **JSON-RPC 2.0 over stdio**, `Content-Length` framing.
- **Architecture:** the daemon **reuses `LocalEnvironment`** — it is a JSON-RPC
  server that dispatches each op to a `LocalEnvironment` instance. Zero duplicated
  I/O logic.
- **Daemon lifecycle:** **(A)** `RemoteEnvironment` spawns and owns the daemon
  (spawn on construct via an injected transport, kill on `dispose()`); one daemon
  per task. Generalizes to SSH (the spawn becomes `ssh … node daemon`).
- **`searchFormatted.isaacIgnoreController`** (non-serializable): the daemon applies
  the ignore **locally** (not sent over the wire).

### Existing building blocks
The `Environment` interface + `LocalEnvironment` (#1), the conformance suite
(`src/services/environment/__tests__/conformance.ts`), `resolveEnvironment` (the
single selection seam), esbuild (for a daemon bundle), SSH to MacStudio (later).

---

## 2. Goals & non-goals (#2 MVP)

### Goals
1. A JSON-RPC protocol (methods + framing + error mapping) covering every
   `Environment` op, including streaming (`runCommand`/`exec` output).
2. A **transport abstraction** with two implementations: in-process (paired
   streams, for fast tests) and subprocess (a child process's stdio).
3. `RemoteEnvironment implements Environment` — serializes each op over the
   transport; reconstructs `ExecHandle` from streaming notifications.
4. A `daemon` entry that runs a JSON-RPC server over the transport, dispatching to
   a `LocalEnvironment`; built as a standalone bundle (`dist/lisael-daemon.js`).
5. Wire selection into `resolveEnvironment` (e.g. `ISAAC_ENV=remote-local`),
   defaulting to `LocalEnvironment` (unchanged).
6. The #1 conformance suite runs against `RemoteEnvironment`→in-process-daemon,
   proving op-for-op equivalence with `LocalEnvironment`.

### Non-goals (deferred — #2.x / #3)
- SSH transport (MacStudio) + bootstrap-on-remote (delivering Node + the daemon).
- Container (`docker exec`) and cloud-sandbox provisioning.
- Security/auth (no network boundary in local-subprocess; SSH provides auth +
  encryption when it lands).
- Portable sessions / `snapshot`/`restore` (#3).

### Success criteria
- Conformance suite passes for `RemoteEnvironment` (in-process daemon) — identical
  assertions as `Local`/`InMemory`.
- Streaming, error-code preservation, and a subprocess integration test pass.
- Gates green: `npm run test:unit`, `npm run check-types`, `npm run lint`. Default
  path (`LocalEnvironment`) unchanged → existing suites stay green.

---

## 3. Architecture

```
   ToolExecutor / handlers (brain, local)
            │ config.environment : Environment
            ▼
   RemoteEnvironment (client)  ──JSON-RPC / Content-Length──►  daemon (server)
   - implements Environment        (over a Transport)          - JSON-RPC loop
   - one request per op                                         - dispatch to ▼
   - reconstructs ExecHandle                              LocalEnvironment (real fs/rg/spawn)
     from env/output notifications
   - owns daemon lifecycle (spawn/dispose)
```

- `RemoteEnvironment` depends only on a `Transport` (duplex message channel) and,
  for subprocess mode, a `spawnDaemon` thunk.
- The daemon is transport-agnostic: it serves the same protocol whether the
  transport is in-process streams, a subprocess's stdio, or (later) an `ssh` pipe.

---

## 4. The protocol

- **Framing:** `Content-Length: <n>\r\n\r\n<json>` (LSP-style) — robust to
  newlines/binary in payloads.
- **Requests (1:1 with ops):** method names `env/readFile`, `env/writeFile`,
  `env/exists`, `env/stat`, `env/list`, `env/mkdir`, `env/delete`, `env/rename`,
  `env/listFilesNative`, `env/searchFormatted`, `env/runCommand`, `env/exec`,
  `env/dispose`. `params` = serialized args; `result` = the op's return value.
- **Errors:** `EnvironmentError` → JSON-RPC error `{ code, message, data: { op,
  errno?, code? } }`, so the original Node `error.code` (ENOENT/ENOTDIR/EACCES/
  EROFS) survives the wire — `WriteToFileToolHandler` unwraps it exactly as today.
- **Streaming (`runCommand`, `exec`):** the request carries a `streamId`. The
  server emits **notifications** `env/output { streamId, stream: "stdout"|"stderr",
  chunk }` as output arrives, then returns the final response (`exitCode` for
  `exec`; `[userRejected, result]` for `runCommand`). Client→server notifications
  `env/stdin { streamId, data }`, `env/kill { streamId, signal? }`,
  `env/abort { streamId }` drive stdin/kill/abort.
  - `RemoteEnvironment.runCommand` rebinds the caller's `onOutputLine` to the
    `env/output` notifications.
  - `RemoteEnvironment.exec` returns an `ExecHandle` whose `stdout`/`stderr`
    async-iterables drain queues fed by `env/output`; `kill`/`writeStdin` send the
    corresponding notifications; `exitCode` resolves from the final response.
- **Non-serializable args:** `searchFormatted`'s `isaacIgnoreController` is NOT
  sent; the daemon's `LocalEnvironment` applies ignore rules locally. `abortSignal`
  is represented by the `env/abort` notification, not serialized.

---

## 5. Components (files)

New under `src/services/environment/remote/`:
- `protocol.ts` — JSON-RPC message types, method-name constants, `Content-Length`
  encode/decode, `EnvironmentError`↔RPC-error mapping.
- `transport.ts` — `Transport` interface (send message / async-iterate incoming) +
  two impls: `inProcessTransportPair()` (returns linked client/server transports
  over in-memory streams) and `subprocessTransport(child)` (frames over a child's
  stdin/stdout).
- `RemoteEnvironment.ts` — `implements Environment`; takes a `Transport` (+ optional
  `spawnDaemon` for subprocess ownership). Serializes ops; manages stream queues;
  `dispose()` tears down transport/daemon. (`runCommand`/`exec` execute in the
  daemon — see Open Questions for the daemon's command runner.)
- `daemon.ts` — server entry: JSON-RPC loop over a transport, dispatching to a
  `LocalEnvironment`; standalone esbuild bundle → `dist/lisael-daemon.js`,
  spawnable as `node dist/lisael-daemon.js`.

Modified:
- `src/services/environment/resolveEnvironment.ts` — branch on config: remote-local
  → `new RemoteEnvironment(subprocessTransport(() => spawn("node", [daemonPath])))`;
  else `LocalEnvironment` (default).
- `esbuild.mjs` (or `cli/esbuild.mts`) — add the daemon bundle target.
- `src/services/environment/index.ts` — export `RemoteEnvironment` + transports.

---

## 6. Testing

- **In-process conformance:** run `runEnvironmentConformance` against a
  `RemoteEnvironment` wired to a daemon over `inProcessTransportPair()` — no
  subprocess; proves op equivalence + serialization deterministically and fast.
- **Streaming test:** `runCommand`/`exec` deliver output via `env/output`;
  `onOutputLine` fires; `exitCode` correct (incl. non-zero on signal-kill).
- **Error mapping test:** a missing `readFile`/`stat` propagates `EnvironmentError`
  with `code === "ENOENT"` across the wire (the path `WriteToFile` unwraps).
- **Subprocess integration test (1):** spawn the built daemon, run a few ops + one
  command end-to-end.
- **Behavior preservation:** default `LocalEnvironment` path unchanged → existing
  1287 + 554 + 87 suites stay green.

---

## 7. Open questions / risks

| Item | Resolution |
|------|------------|
| The daemon's `LocalEnvironment` needs a `commandRunner` for `runCommand`/`exec`, but the host's `executeCommandTool` (terminal UI) lives in the *client*. | In the daemon, `runCommand`/`exec` use a **plain spawn-based** command runner (the daemon has no terminal UI). Acceptable for the local-subprocess MVP; the host-terminal integration applies to `LocalEnvironment` only. Confirm during planning. |
| Large file payloads over JSON-RPC (utf8/base64 bloat) | Acceptable for MVP (text files); binary/large-file streaming is a #2.x optimization. |
| Backpressure on streaming output | Bounded queue with consumption; document that `ExecHandle` streams must be drained (carried over from #1 nit). |
| Daemon crash / transport death | `RemoteEnvironment` ops reject with a clear `EnvironmentError("transport", …)`; `dispose()` is idempotent. |

---

## 8. Decomposition (this is #2; #2.x and #3 follow)

1. **#2 (this spec):** protocol + transport (in-process + subprocess) +
   RemoteEnvironment + daemon + conformance, local-subprocess only.
2. **#2.x:** SSH transport + bootstrap-on-remote (MacStudio), then container, then
   cloud; security/auth for non-stdio transports.
3. **#3:** portable sessions (snapshot/restore, migration) on top of the daemon.
