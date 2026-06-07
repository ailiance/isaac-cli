import path from "node:path"
import type { DirEntry, Environment, EnvStat, ExecHandle, ExecOpts, FileInfo, SearchOpts } from "../../types"
import { RemoteEnvironment } from "../RemoteEnvironment"
import { sshTransport } from "./sshTransport"
import { buildBootstrap, buildRsyncPull, buildRsyncPush, DEFAULT_EXCLUDES, runRsync, runSsh } from "./sync"

const REMOTE_DAEMON = "~/.isaac/lisael-daemon.js"

export interface SshRemoteHooks {
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

	private constructor(
		remoteCwd: string,
		private hooks: SshRemoteHooks,
	) {
		this.id = "ssh"
		this.cwd = remoteCwd
		this.ready = this.init()
		// Mark the eager promise as handled so a pre-first-op init failure does not
		// surface as an unhandledRejection; use()/dispose() still await + surface it.
		this.ready.catch(() => {})
	}

	/** Synchronous factory: keeps resolveEnvironment sync; init runs lazily on first op. */
	static create(host: string, localCwd: string, hooksOverride?: Partial<SshRemoteHooks>): SshRemoteSession {
		const sessionId = `${process.pid}-${localCwd.replace(/[^a-zA-Z0-9]/g, "_")}`
		const remoteCwd = `~/.isaac/workspaces/${sessionId}`
		// Sibling of the bundled output (dist/lisael-daemon.js), like the
		// remote-local branch in resolveEnvironment. At bundled runtime __dirname
		// IS dist/; a 5-up source-tree path would resolve above the repo root.
		const localBundle = path.join(__dirname, "lisael-daemon.js")
		const hooks: SshRemoteHooks = {
			bootstrap: () => runRsync(buildBootstrap(host, localBundle, REMOTE_DAEMON)),
			push: () => runRsync(buildRsyncPush(host, localCwd, remoteCwd, DEFAULT_EXCLUDES)),
			pull: () => runRsync(buildRsyncPull(host, remoteCwd, localCwd, DEFAULT_EXCLUDES)),
			cleanup: () => runSsh(host, `rm -rf ${remoteCwd}`),
			makeEnv: () => new RemoteEnvironment(sshTransport(host, REMOTE_DAEMON, remoteCwd), remoteCwd, { id: `ssh:${host}` }),
			...hooksOverride,
		}
		return new SshRemoteSession(remoteCwd, hooks)
	}

	private async init(): Promise<void> {
		await this.hooks.bootstrap()
		await this.hooks.push()
		this.env = this.hooks.makeEnv()
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
