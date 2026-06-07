import path from "node:path"
import type { DirEntry, Environment, EnvStat, ExecHandle, ExecOpts, FileInfo, SearchOpts } from "../../types"
import { RemoteEnvironment } from "../RemoteEnvironment"
import { bootstrapDaemonToContainer } from "./bootstrap"
import { dockerTransport } from "./dockerTransport"

const REMOTE_DAEMON = "/tmp/lisael-daemon.js"

export interface DockerHooks {
	/** Copy the bundled daemon into the container (docker cp). */
	bootstrap: () => Promise<void>
	/** Build the RemoteEnvironment talking to the in-container daemon (docker exec). */
	makeEnv: () => Environment
}

/**
 * Lazy-init Docker session. Mirrors {@link SshRemoteSession} but WITHOUT sync:
 * the workspace is bind-mounted (shared FS), so there is no seed/pull/conflict
 * handling — only the daemon bundle must be copied in before the first op.
 *
 * The race this fixes: previously resolveEnvironment fired the `docker cp`
 * best-effort and returned the RemoteEnvironment immediately, so the first
 * `docker exec` could start before the daemon bundle existed. Here every op
 * awaits `ready` (which awaits the bootstrap cp) before delegating.
 */
export class DockerSession implements Environment {
	readonly id: string
	readonly cwd: string
	private env?: Environment
	private ready: Promise<void>
	private disposed = false
	private hooks: DockerHooks

	private constructor(container: string, wsPath: string, hooksOverride: Partial<DockerHooks>) {
		this.id = `docker:${container}`
		this.cwd = wsPath
		// Sibling of the bundled output (dist/lisael-daemon.js); at bundled runtime
		// __dirname IS dist/. Matches resolveEnvironment's other branches.
		const localBundle = path.join(__dirname, "lisael-daemon.js")
		this.hooks = {
			bootstrap: () => bootstrapDaemonToContainer(container, localBundle, REMOTE_DAEMON),
			makeEnv: () => new RemoteEnvironment(dockerTransport(container, REMOTE_DAEMON, wsPath), wsPath, { id: this.id }),
			...hooksOverride,
		}
		this.ready = this.init()
		// Mark the eager promise as handled so a pre-first-op init failure does not
		// surface as an unhandledRejection; use()/dispose() still await + surface it.
		this.ready.catch(() => {})
	}

	/** Synchronous factory: keeps resolveEnvironment sync; init runs lazily on first op. */
	static create(container: string, wsPath: string, hooksOverride?: Partial<DockerHooks>): DockerSession {
		return new DockerSession(container, wsPath, hooksOverride ?? {})
	}

	private async init(): Promise<void> {
		// Copy the daemon bundle into the container BEFORE the first exec, so the
		// transport never spawns against a missing daemon path.
		await this.hooks.bootstrap()
		this.env = this.hooks.makeEnv()
	}

	private async use(): Promise<Environment> {
		await this.ready
		if (!this.env) {
			throw new Error("docker session not initialized")
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
		// exec() is synchronous (returns an ExecHandle) but the daemon is only
		// available after the async bootstrap; we cannot await here. Same tradeoff
		// as SshRemoteSession — callers use runCommand on remote sessions.
		throw new Error("DockerSession.exec not supported; use runCommand")
	}

	async dispose(): Promise<void> {
		if (this.disposed) {
			return
		}
		this.disposed = true
		try {
			await this.ready
		} catch {}
		// Bind-mount: no pull-back, no remote cleanup. Just close the transport.
		try {
			await this.env?.dispose()
		} catch {}
	}
}
