import path from "node:path"
import { Logger } from "@/shared/services/Logger"
import type { DirEntry, Environment, EnvStat, ExecHandle, ExecOpts, FileInfo, SearchOpts } from "../../types"
import { RemoteEnvironment } from "../RemoteEnvironment"
import { type ConflictResolver, sideDirResolver } from "./conflicts"
import { buildManifest, locallyChanged, type Manifest } from "./manifest"
import { sshTransport } from "./sshTransport"
import {
	buildBootstrap,
	buildGcCommand,
	buildRsyncPull,
	buildRsyncPullExcept,
	buildRsyncPullInto,
	buildRsyncPush,
	DEFAULT_EXCLUDES,
	gitignoreExcludes,
	mergeExcludes,
	runRsync,
	runSsh,
} from "./sync"

const REMOTE_DAEMON = "~/.isaac/lisael-daemon.js"

export interface SshRemoteHooks {
	gc: () => Promise<void>
	bootstrap: () => Promise<void>
	push: () => Promise<void>
	pull: () => Promise<void>
	cleanup: () => Promise<void>
	makeEnv: () => Environment
}

export class SshRemoteSession implements Environment {
	readonly id: string
	readonly cwd: string
	private env?: Environment
	private ready: Promise<void>
	private disposed = false

	/** Excludes (DEFAULT + .gitignore) computed in init() before seed; reused at pull-back. */
	private excludes: string[] = DEFAULT_EXCLUDES
	/** Snapshot of the local workspace hashes taken right after the seed push. */
	private seedManifest: Manifest = {}

	private hooks: SshRemoteHooks

	private constructor(
		remoteCwd: string,
		private host: string,
		private localCwd: string,
		private sessionId: string,
		private resolver: ConflictResolver,
		hooksOverride: Partial<SshRemoteHooks>,
	) {
		this.id = "ssh"
		this.cwd = remoteCwd
		// Sibling of the bundled output (dist/lisael-daemon.js), like the
		// remote-local branch in resolveEnvironment. At bundled runtime __dirname
		// IS dist/; a 5-up source-tree path would resolve above the repo root.
		const localBundle = path.join(__dirname, "lisael-daemon.js")
		// Default hooks reference `this` so push/pull share the computed excludes,
		// the seed manifest and the conflict-aware pull-back. Overrides win.
		this.hooks = {
			gc: () => runSsh(host, buildGcCommand(7)),
			bootstrap: () => runRsync(buildBootstrap(host, localBundle, REMOTE_DAEMON)),
			push: () => runRsync(buildRsyncPush(host, this.localCwd, this.cwd, this.excludes)),
			pull: () => this.conflictAwarePull(),
			cleanup: () => runSsh(host, `rm -rf ${remoteCwd}`),
			makeEnv: () => new RemoteEnvironment(sshTransport(host, REMOTE_DAEMON, remoteCwd), remoteCwd, { id: `ssh:${host}` }),
			...hooksOverride,
		}
		this.ready = this.init()
		// Mark the eager promise as handled so a pre-first-op init failure does not
		// surface as an unhandledRejection; use()/dispose() still await + surface it.
		this.ready.catch(() => {})
	}

	/** Synchronous factory: keeps resolveEnvironment sync; init runs lazily on first op. */
	static create(
		host: string,
		localCwd: string,
		hooksOverride?: Partial<SshRemoteHooks> & { resolver?: ConflictResolver },
	): SshRemoteSession {
		const sessionId = `${process.pid}-${localCwd.replace(/[^a-zA-Z0-9]/g, "_")}`
		const remoteCwd = `~/.isaac/workspaces/${sessionId}`
		const { resolver: resolverOverride, ...hookOverrides } = hooksOverride ?? {}
		const resolver: ConflictResolver = resolverOverride ?? sideDirResolver
		return new SshRemoteSession(remoteCwd, host, localCwd, sessionId, resolver, hookOverrides)
	}

	private async init(): Promise<void> {
		// Best-effort GC of orphan workspaces; never blocks the session.
		try {
			await this.hooks.gc()
		} catch {}
		// .gitignore-aware excludes, computed before the seed push so push + manifest
		// + pull-back all share one exclude set.
		try {
			this.excludes = mergeExcludes(DEFAULT_EXCLUDES, await gitignoreExcludes(this.localCwd))
		} catch {
			this.excludes = DEFAULT_EXCLUDES
		}
		await this.hooks.bootstrap()
		await this.hooks.push()
		// Snapshot the local workspace right after seeding so pull-back can detect
		// files that changed locally during the remote session.
		try {
			this.seedManifest = await buildManifest(this.localCwd, this.excludes)
		} catch {
			this.seedManifest = {}
		}
		this.env = this.hooks.makeEnv()
	}

	/**
	 * Pull remote -> local without ever silently overwriting a locally-changed file.
	 * No local changes -> plain pull. Otherwise route conflicts through the resolver:
	 * keep-local/side-dir paths are excluded from the in-place pull (local edits
	 * survive); side-dir paths additionally fetch the remote version into
	 * <localCwd>/.isaac/pulled-<sessionId>/ and warn. On detection failure we prefer
	 * not pulling at all over clobbering local work.
	 */
	private async conflictAwarePull(): Promise<void> {
		let changed: string[]
		try {
			changed = await locallyChanged(this.localCwd, this.seedManifest, this.excludes)
		} catch (e) {
			// Detection failed: do nothing rather than risk overwriting local edits.
			Logger.warn(`ssh pull-back: change detection failed, skipping pull to protect local files: ${e}`)
			return
		}

		if (changed.length === 0) {
			await runRsync(buildRsyncPull(this.host, this.cwd, this.localCwd, this.excludes))
			return
		}

		const decisions = await this.resolver(changed, {
			localDir: this.localCwd,
			remoteDir: this.cwd,
			host: this.host,
			sessionId: this.sessionId,
		})

		const keepLocal: string[] = []
		const sideDir: string[] = []
		for (const [p, decision] of decisions) {
			if (decision === "keep-local") {
				keepLocal.push(p)
			} else if (decision === "side-dir") {
				sideDir.push(p)
			}
			// keep-remote: not protected -> pulled in place below.
		}

		// In-place pull, protecting kept-local + side-dir paths from being overwritten.
		await runRsync(buildRsyncPullExcept(this.host, this.cwd, this.localCwd, this.excludes, [...keepLocal, ...sideDir]))

		// Fetch remote versions of side-dir conflicts into a quarantine dir + warn.
		if (sideDir.length > 0) {
			const sideDirPath = path.join(this.localCwd, ".isaac", `pulled-${this.sessionId}`)
			await runRsync(buildRsyncPullInto(this.host, this.cwd, sideDirPath, sideDir))
			Logger.warn(
				`ssh pull-back: ${sideDir.length} file(s) changed both locally and remotely; ` +
					`local kept, remote copies saved to ${sideDirPath} (${sideDir.join(", ")})`,
			)
		}
	}

	private async use(): Promise<Environment> {
		await this.ready
		if (!this.env) {
			throw new Error("ssh session not initialized")
		}
		return this.env
	}

	async readFile(p: string): Promise<string> {
		return (await this.use()).readFile(p)
	}
	async writeFile(p: string, c: string): Promise<void> {
		return (await this.use()).writeFile(p, c)
	}
	async exists(p: string): Promise<boolean> {
		return (await this.use()).exists(p)
	}
	async stat(p: string): Promise<EnvStat> {
		return (await this.use()).stat(p)
	}
	async list(p: string, o?: { recursive?: boolean }): Promise<DirEntry[]> {
		return (await this.use()).list(p, o)
	}
	async mkdir(p: string, o?: { recursive?: boolean }): Promise<void> {
		return (await this.use()).mkdir(p, o)
	}
	async delete(p: string, o?: { recursive?: boolean }): Promise<void> {
		return (await this.use()).delete(p, o)
	}
	async rename(a: string, b: string): Promise<void> {
		return (await this.use()).rename(a, b)
	}
	async listFilesNative(p: string, r: boolean, l: number, s?: AbortSignal): Promise<[FileInfo[], boolean]> {
		return (await this.use()).listFilesNative(p, r, l, s)
	}
	async searchFormatted(d: string, re: string, o?: SearchOpts & { taskId?: string; cwd?: string }): Promise<string> {
		return (await this.use()).searchFormatted(d, re, o)
	}
	runCommand: Environment["runCommand"] = async (command, timeoutSeconds, opts) =>
		(await this.use()).runCommand(command, timeoutSeconds, opts)
	exec(_cmd: string, _opts?: ExecOpts): ExecHandle {
		throw new Error("SshRemoteSession.exec not supported; use runCommand")
	}

	async dispose(): Promise<void> {
		if (this.disposed) {
			return
		}
		this.disposed = true
		try {
			await this.ready
		} catch {}
		try {
			await this.env?.dispose()
		} catch {}
		try {
			await this.hooks.pull()
		} catch {}
		try {
			await this.hooks.cleanup()
		} catch {}
	}
}
