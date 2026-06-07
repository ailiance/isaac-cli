import path from "node:path"
import {
	type CommandRunner,
	type DirEntry,
	type Environment,
	EnvironmentError,
	type EnvStat,
	type ExecHandle,
	type FileInfo,
	type Match,
} from "./types"

export class InMemoryEnvironment implements Environment {
	readonly id = "memory"
	private files = new Map<string, string>()
	constructor(readonly cwd: string = "/") {}

	private key(p: string): string {
		return path.posix.normalize(path.isAbsolute(p) ? p : path.posix.join(this.cwd, p))
	}

	async readFile(p: string): Promise<string> {
		const v = this.files.get(this.key(p))
		if (v === undefined) {
			throw new EnvironmentError("readFile", p, new Error("ENOENT"))
		}
		return v
	}
	async writeFile(p: string, content: string): Promise<void> {
		this.files.set(this.key(p), content)
	}
	async exists(p: string): Promise<boolean> {
		const k = this.key(p)
		return this.files.has(k) || [...this.files.keys()].some((f) => f.startsWith(`${k}/`))
	}
	async stat(p: string): Promise<EnvStat> {
		const k = this.key(p)
		if (this.files.has(k)) {
			return { isDir: false, size: Buffer.byteLength(this.files.get(k)!), mtimeMs: 0 }
		}
		if (await this.exists(p)) {
			return { isDir: true, size: 0, mtimeMs: 0 }
		}
		throw new EnvironmentError("stat", p, new Error("ENOENT"))
	}
	async list(p: string, opts?: { recursive?: boolean }): Promise<DirEntry[]> {
		const prefix = `${this.key(p)}/`
		const seen = new Map<string, boolean>()
		for (const f of this.files.keys()) {
			if (!f.startsWith(prefix)) {
				continue
			}
			const rest = f.slice(prefix.length)
			if (opts?.recursive) {
				seen.set(rest, false)
			} else {
				const head = rest.split("/")[0]
				seen.set(head, rest.includes("/"))
			}
		}
		return [...seen.entries()].map(([name, isDir]) => ({ name, isDir }))
	}
	async mkdir(): Promise<void> {}
	async delete(p: string, opts?: { recursive?: boolean }): Promise<void> {
		const k = this.key(p)
		this.files.delete(k)
		if (opts?.recursive) {
			for (const f of [...this.files.keys()]) {
				if (f.startsWith(`${k}/`)) {
					this.files.delete(f)
				}
			}
		}
	}
	async rename(from: string, to: string): Promise<void> {
		const v = await this.readFile(from)
		await this.writeFile(to, v)
		await this.delete(from)
	}
	async search(): Promise<Match[]> {
		return []
	}
	exec(): ExecHandle {
		const empty = (async function* () {})()
		return {
			stdout: empty,
			stderr: empty,
			writeStdin: () => {},
			kill: () => {},
			exitCode: Promise.resolve(0),
		}
	}
	runCommand: CommandRunner = async () => [false, ""]

	async listFilesNative(p: string, recursive: boolean, limit: number): Promise<[FileInfo[], boolean]> {
		const entries = await this.list(p, { recursive })
		const infos: FileInfo[] = entries.map((e) => ({
			path: `${this.key(p)}/${e.name}`,
			mtime: 0,
			isDirectory: e.isDir,
		}))
		return [infos.slice(0, limit), infos.length > limit]
	}

	async searchFormatted(): Promise<string> {
		return ""
	}

	async dispose(): Promise<void> {
		this.files.clear()
	}
}
