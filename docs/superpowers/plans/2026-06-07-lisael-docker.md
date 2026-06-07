# LISAEL Container transport (docker exec) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** Run the agent's tool I/O inside a Docker container via `docker exec`, reusing #2's `RemoteEnvironment`. With a **bind-mounted** workspace (shared FS) there is NO sync, NO conflict, NO pull-back — the simplest remote.

**Design (inline; #2.z):**
- `dockerTransport(container, daemonPath, wsPath)` = `subprocessTransport(spawn("docker", ["exec","-i",container,"node",daemonPath,wsPath]))`.
- `bootstrapDaemonToContainer(container, localBundle, remotePath)` = `docker cp <localBundle> <container>:<remotePath>` (only the daemon needs copying; the workspace is bind-mounted by the user).
- `resolveEnvironment` branch `ISAAC_ENV=docker:<container>:<wsPathInContainer>` → bootstrap + `new RemoteEnvironment(dockerTransport(...), wsPath, { onClose })`. No session/sync wrapper. `dispose()` just closes the transport (changes are live on the bind-mounted local dir).
- Assumes the container is running with the workspace bind-mounted and has Node. Documented; failure → clear error.

**Branch:** `feat/lisael-docker` (off `fe8351d`). **Gates:** `npm run test:unit` · `npm run check-types` · `npm run lint`. Core tests via `npx cross-env TS_NODE_PROJECT=./tsconfig.unit-test.json mocha "<glob>"`.

**Shell:** `export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 22 >/dev/null; cd /Users/claude2/isaac-cli`

---

## Task 1: `dockerTransport` + bootstrap arg-builders

**Files:** Create `src/services/environment/remote/docker/dockerTransport.ts`, `docker/bootstrap.ts`; Test `docker/__tests__/docker.test.ts`.

- [ ] **Step 1: Failing test (arg-builders, no real docker)**

```ts
// src/services/environment/remote/docker/__tests__/docker.test.ts
import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import { buildDockerCp, buildDockerExecArgs } from "../bootstrap"

describe("docker arg builders", () => {
	it("docker exec args: -i <container> node <daemon> <ws>", () => {
		assert.deepEqual(buildDockerExecArgs("c1", "/tmp/lisael-daemon.js", "/workspace"), [
			"exec", "-i", "c1", "node", "/tmp/lisael-daemon.js", "/workspace",
		])
	})
	it("docker cp args: <local> <container>:<remote>", () => {
		assert.deepEqual(buildDockerCp("c1", "/repo/dist/lisael-daemon.js", "/tmp/lisael-daemon.js"), [
			"cp", "/repo/dist/lisael-daemon.js", "c1:/tmp/lisael-daemon.js",
		])
	})
})
```

- [ ] **Step 2: Implement `bootstrap.ts` + `dockerTransport.ts`**

```ts
// src/services/environment/remote/docker/bootstrap.ts
import { spawn } from "node:child_process"

export function buildDockerExecArgs(container: string, daemonPath: string, wsPath: string): string[] {
	return ["exec", "-i", container, "node", daemonPath, wsPath]
}
export function buildDockerCp(container: string, localFile: string, remotePath: string): string[] {
	return ["cp", localFile, `${container}:${remotePath}`]
}
export function bootstrapDaemonToContainer(container: string, localBundle: string, remotePath: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn("docker", buildDockerCp(container, localBundle, remotePath))
		let stderr = ""
		child.stderr.on("data", (d: Buffer) => { stderr += d.toString("utf8") })
		child.on("error", reject)
		child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`docker cp exited ${code}: ${stderr}`))))
	})
}
```

```ts
// src/services/environment/remote/docker/dockerTransport.ts
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process"
import { subprocessTransport, type Transport } from "../transport"
import { buildDockerExecArgs } from "./bootstrap"

export function dockerTransport(container: string, daemonPath: string, wsPath: string): Transport {
	const child = spawn("docker", buildDockerExecArgs(container, daemonPath, wsPath)) as ChildProcessWithoutNullStreams
	return subprocessTransport(child)
}
```

- [ ] **Step 3: Run + commit**

Run: `npx cross-env TS_NODE_PROJECT=./tsconfig.unit-test.json mocha src/services/environment/remote/docker/__tests__/docker.test.ts` → PASS.
```bash
git add src/services/environment/remote/docker/
git commit -m "feat(env): docker exec transport + cp bootstrap"
```

---

## Task 2: `resolveEnvironment` docker branch + exports + gated integration

**Files:** Modify `src/services/environment/resolveEnvironment.ts`, `src/services/environment/index.ts`; Create `docker/__tests__/docker.integration.test.ts`.

- [ ] **Step 1: Add the `docker:` branch**

In `resolveEnvironment.ts` (keep `ssh:`/`remote-local` + default `LocalEnvironment` unchanged):
```ts
import path from "node:path"
import { bootstrapDaemonToContainer } from "./remote/docker/bootstrap"
import { dockerTransport } from "./remote/docker/dockerTransport"
import { RemoteEnvironment } from "./remote/RemoteEnvironment"
// ... inside resolveEnvironment, reading isaacEnv = process.env.ISAAC_ENV:
	if (isaacEnv?.startsWith("docker:")) {
		// ISAAC_ENV=docker:<container>:<wsPathInContainer>
		const rest = isaacEnv.slice("docker:".length)
		const idx = rest.lastIndexOf(":")
		const container = idx === -1 ? rest : rest.slice(0, idx)
		const wsPath = idx === -1 ? opts.cwd : rest.slice(idx + 1)
		const remoteDaemon = "/tmp/lisael-daemon.js"
		const localBundle = path.join(__dirname, "lisael-daemon.js")
		void bootstrapDaemonToContainer(container, localBundle, remoteDaemon).catch(() => {})
		return new RemoteEnvironment(dockerTransport(container, remoteDaemon, wsPath), wsPath, { id: `docker:${container}` })
	}
```
> The `docker cp` runs concurrently with the `docker exec`. If a race is observed (exec starts before cp finishes), mirror `SshRemoteSession`'s lazy-init (sync factory; await bootstrap before first op). Confirm during the run.

- [ ] **Step 2: Exports**

`index.ts`: add `export { dockerTransport } from "./remote/docker/dockerTransport"` and `export { bootstrapDaemonToContainer } from "./remote/docker/bootstrap"`.

- [ ] **Step 3: Gated integration test**

```ts
// src/services/environment/remote/docker/__tests__/docker.integration.test.ts
import { strict as assert } from "node:assert"
import path from "node:path"
import { describe, it } from "mocha"
const C = process.env.ISAAC_E2E_DOCKER
;(C ? describe : describe.skip)("docker integration", () => {
	it("writes a file in the container workspace", async function () {
		this.timeout(60_000)
		const { RemoteEnvironment } = await import("../../RemoteEnvironment")
		const { dockerTransport } = await import("../dockerTransport")
		const { bootstrapDaemonToContainer } = await import("../bootstrap")
		await bootstrapDaemonToContainer(C!, path.resolve("dist/lisael-daemon.js"), "/tmp/lisael-daemon.js")
		const env = new RemoteEnvironment(dockerTransport(C!, "/tmp/lisael-daemon.js", "/workspace"), "/workspace")
		await env.writeFile("docker-made.txt", "FROM_DOCKER")
		assert.equal(await env.readFile("docker-made.txt"), "FROM_DOCKER")
		await env.dispose()
	})
})
```
> Default-skipped; opt-in via `ISAAC_E2E_DOCKER=<container>` (running container with Node + bind-mounted `/workspace` + the daemon built).

- [ ] **Step 4: Gates + commit**

Run: `npm run check-types && npm run lint && npm run test:unit && node esbuild.mjs` → all PASS.
```bash
git add src/services/environment/resolveEnvironment.ts src/services/environment/index.ts src/services/environment/remote/docker/__tests__/docker.integration.test.ts
git commit -m "feat(env): resolveEnvironment docker branch"
```

---

## Task 3: Final gates + PR

- [ ] **Step 1:** `npm run test:unit && npm run check-types && npm run lint && node esbuild.mjs` → all PASS; `rg ISAAC_ENV src/services/environment/resolveEnvironment.ts` confirms docker is opt-in; default `LocalEnvironment` unchanged.
- [ ] **Step 2:** `git push -u origin feat/lisael-docker`; open PR `feat/lisael-docker → master`, title `feat: LISAEL container transport (docker exec)`. (Scrub token after tokened HTTPS push.)

---

## Self-Review

- **Coverage:** transport+bootstrap builders (T1) ✓; resolve branch + exports + gated integration (T2) ✓; gates+PR (T3) ✓. **Deferred:** docker-cp sync model (bind-mount chosen → none needed), cloud sandbox, bootstrap/exec race lazy-init (flagged; mirror SshRemoteSession if observed).
- **Placeholder scan:** T2 flags the bootstrap/exec race with a concrete mitigation; tests assert arg shape. No vague TODOs.
- **Type consistency:** `dockerTransport`/`bootstrapDaemonToContainer`/`buildDockerExecArgs`/`buildDockerCp` consistent; reuses `subprocessTransport`/`RemoteEnvironment`; `resolveEnvironment` stays sync, default `LocalEnvironment` unchanged.
- **Simplicity:** bind-mount → no sync/conflict/pull-back; thinnest remote (transport + cp bootstrap only).
