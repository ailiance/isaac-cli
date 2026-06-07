# LISAEL — SSH transport + workspace sync (sub-project #2.x)

**Date:** 2026-06-07
**Status:** Design approved, pending spec review
**Branch:** `feat/lisael-ssh`
**Builds on:** #1 (`Environment`, merged) + #2 (`RemoteEnvironment` + daemon, merged) — specs in `docs/superpowers/specs/2026-06-07-lisael-{environment-foundation,remote-environment}-design.md`

#2 added a `RemoteEnvironment` talking to a daemon over a subprocess stdio transport
(validated locally). #2.x makes the remote a **real machine over SSH** (MacStudio),
with **workspace sync** (push local → remote, run live, pull back).

---

## 1. Problem & context

The agent's brain runs locally; #2 made its hands run in a separate process. #2.x
points that process at **MacStudio over SSH** so heavy work (builds, tests, large
repos) runs on the powerful remote, while the LLM loop stays local.

### Key insight: #2 is reused unchanged
The SSH transport is just `subprocessTransport` over an `ssh` child process
(`ssh studio node <daemon> <cwd>`). `RemoteEnvironment` and the protocol are
**not modified**. #2.x is a thin layer: SSH transport + daemon bootstrap +
workspace sync lifecycle.

### Decisions locked in brainstorming
- **Workspace model:** **sync local → remote** (Codex-cloud style). Seed the
  workspace on MacStudio at session start; the agent works **live** on the remote
  copy via the daemon; **pull changes back** at session end.
- **Sync mechanism:** **rsync over SSH** (`rsync -az --delete -e ssh`), with
  excludes; incremental delta-transfer.
- **Daemon bootstrap:** **rsync the bundle per session** to
  `~/.isaac/lisael-daemon.js`, then `ssh … node ~/.isaac/lisael-daemon.js`.
  Self-contained; local daemon version always matches.
- **Auth:** the user's existing SSH config (`ssh studio`, user `ailiance`, Node 22
  user-level). No extra auth layer.

### Existing building blocks
`RemoteEnvironment` + `subprocessTransport` + protocol (#2), the daemon bundle
(`dist/lisael-daemon.js`), MacStudio reachable via `ssh studio`.

---

## 2. Goals & non-goals (#2.x)

### Goals
1. `sshTransport(host, remoteDaemonPath, remoteCwd)` — spawns `ssh` and returns a
   `subprocessTransport`. (Trivial; reuses #2.)
2. `sync` — pure rsync/ssh **arg builders** (push/pull/bootstrap) + an executor;
   default excludes (`.git`, `node_modules`, `dist`, `.isaac`, `build`).
3. `SshRemoteSession` — orchestrates bootstrap → seed → transport →
   `RemoteEnvironment`; on `dispose()`: pull-back + remote cleanup.
4. `resolveEnvironment` branch `ISAAC_ENV=ssh:<host>` → `SshRemoteSession`; default
   `LocalEnvironment` unchanged.
5. Tests: deterministic unit tests of the arg builders; an env-gated real-SSH
   integration test.

### Non-goals (deferred)
- Conflict resolution when the remote workspace has diverged (#2.x.y).
- Continuous/bidirectional watch-sync.
- Generic non-MacStudio hosts; container/cloud (those are #2.z).
- Fine-grained `.gitignore` parsing (default exclude list for the MVP).
- `exec()` streaming over the wire (still deferred from #2).

### Success criteria
- Arg-builder unit tests pass (correct rsync/ssh commands + excludes).
- Env-gated SSH integration (`ISAAC_E2E_SSH=1`, requires `ssh studio`): seed →
  remote write via the agent path → pull → assert the change is on the local FS.
- Gates green; default `LocalEnvironment` path unchanged (existing suites green).

---

## 3. Architecture

```
resolveEnvironment(ISAAC_ENV="ssh:studio")
  └─ SshRemoteSession.create(host, localCwd):
       1. bootstrapDaemon: rsync dist/lisael-daemon.js -> studio:~/.isaac/lisael-daemon.js
       2. pushWorkspace:   rsync localCwd/ -> studio:~/.isaac/workspaces/<ulid>/   (excludes)
       3. transport = sshTransport("studio", "~/.isaac/lisael-daemon.js", remoteCwd)
       4. env = new RemoteEnvironment(transport, remoteCwd, { onClose })
       return env
  ── agent loop runs locally; every tool I/O op -> daemon on MacStudio (live) ──
  env.dispose():
       5. pullWorkspace: rsync studio:~/.isaac/workspaces/<ulid>/ -> localCwd/
       6. cleanup: ssh studio rm -rf ~/.isaac/workspaces/<ulid>
```

- `RemoteEnvironment`, the protocol, and the daemon are **unchanged** from #2.
- The daemon on MacStudio runs the same `LocalEnvironment` (real fs/ripgrep/spawn)
  against the synced workspace copy.

---

## 4. Components (files)

New under `src/services/environment/remote/ssh/`:
- `sshTransport.ts` — `sshTransport(host, remoteDaemonPath, remoteCwd): Transport`
  = `subprocessTransport(spawn("ssh", [host, "node", remoteDaemonPath, remoteCwd]))`.
- `sync.ts` — pure builders + executor:
  - `buildRsyncPush(host, localDir, remoteDir, excludes): string[]`
  - `buildRsyncPull(host, remoteDir, localDir, excludes): string[]`
  - `buildBootstrap(host, localBundle, remotePath): string[]`
  - `runRsync(args): Promise<void>` (spawn rsync, reject on non-zero) + a
    `DEFAULT_EXCLUDES` const.
- `SshRemoteSession.ts` — `static async create(host, localCwd): Promise<Environment>`
  doing steps 1-4; the returned env's `dispose()` does steps 5-6 (wraps the
  `RemoteEnvironment`, intercepting dispose).

Modified:
- `src/services/environment/resolveEnvironment.ts` — parse `ISAAC_ENV=ssh:<host>`
  → `await SshRemoteSession.create(host, opts.cwd)`. (Note: this makes the
  ssh branch **async**; see Open Questions.)
- `src/services/environment/index.ts` — export `SshRemoteSession`, `sshTransport`.

---

## 5. Sync details

- `rsync -az --delete -e ssh <src>/ <dst>/` (trailing slashes: sync contents).
- `DEFAULT_EXCLUDES`: `.git`, `node_modules`, `dist`, `build`, `.isaac`,
  `.ailiance-agent`, `*.vsix`. (`.gitignore`-aware filtering deferred.)
- Remote workspace: `~/.isaac/workspaces/<ulid>/` (ephemeral, per session),
  removed on dispose.
- Bootstrap is idempotent (rsync only transfers the bundle if changed).
- Push happens before the transport opens (seed); pull on dispose (retrieve the
  daemon's live writes). `--delete` on pull mirrors remote deletions back —
  confirm direction safety in planning.

---

## 6. Testing

- **Arg-builder unit tests** (deterministic, no SSH): assert `buildRsyncPush` /
  `buildRsyncPull` / `buildBootstrap` produce the expected argv (host, paths,
  `-az --delete`, `-e ssh`, each `--exclude`).
- **Env-gated SSH integration** (`ISAAC_E2E_SSH=1`, requires working `ssh studio`):
  create an `SshRemoteSession` on a temp local dir, have the agent path write a
  file via the daemon, `dispose()`, assert the file is pulled back locally. Default-
  skipped so the unit gate stays hermetic.
- **Behavior preservation:** default path unchanged; existing suites green.

---

## 7. Open questions / risks

| Item | Resolution |
|------|------------|
| `resolveEnvironment` becomes **async** for the ssh branch (bootstrap+seed are async), but callers (`TaskFactory.buildTaskManagers`) call it sync. | Either make the seam async (thread through `buildTaskManagers`), or have `SshRemoteSession` do bootstrap/seed lazily on first op. Decide in planning; lazy-async-first-op keeps the sync seam. |
| `--delete` on pull could delete local files the daemon didn't create | Scope pull to the remote workspace state; document that the remote is authoritative at session end. Consider `--delete` only on push (seed), plain sync on pull. Confirm in planning. |
| Large repos / slow seed | Acceptable for MVP; excludes cut the bulk. Incremental rsync helps on re-runs. |
| Remote `node` path (user-level `~/.local`) | `ssh studio node` relies on PATH — may need `ssh studio "PATH=$HOME/.local/bin:$PATH node …"`. Confirm against MacStudio in planning. |
| Interrupted session (no dispose) → orphan remote workspace | Best-effort cleanup; a `~/.isaac/workspaces` GC is a follow-up. |

---

## 8. Decomposition

1. **#2.x (this spec):** SSH transport + rsync sync (push/pull) + bootstrap +
   `SshRemoteSession`, MacStudio.
2. **#2.x.y:** conflict resolution, continuous sync, `.gitignore`-aware excludes.
3. **#2.z:** generic hosts — container (`docker exec`), cloud sandbox.
4. **#3:** portable sessions (snapshot/restore) — separate spec.
