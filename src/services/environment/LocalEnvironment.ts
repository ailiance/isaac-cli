import { type ChildProcess, spawn } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"
import { regexSearchFiles } from "@services/ripgrep"
import {
	type CommandRunner,
	type DirEntry,
	type Environment,
	EnvironmentError,
	type EnvStat,
	type ExecHandle,
	type ExecOpts,
	type FileInfo,
	type Match,
	type SearchOpts,
} from "./types"

export class LocalEnvironment implements Environment {
	readonly id = "local"
	constructor(
		readonly cwd: string,
		private readonly commandRunner?: CommandRunner,
	) {}

	private abs(p: string): string {
		return path.isAbsolute(p) ? p : path.resolve(this.cwd, p)
	}

	async readFile(p: string): Promise<string> {
		try {
			return await fs.readFile(this.abs(p), "utf8")
		} catch (e) {
			throw new EnvironmentError("readFile", p, e)
		}
	}

	async writeFile(p: string, content: string): Promise<void> {
		try {
			await fs.mkdir(path.dirname(this.abs(p)), { recursive: true })
			await fs.writeFile(this.abs(p), content, "utf8")
		} catch (e) {
			throw new EnvironmentError("writeFile", p, e)
		}
	}

	async exists(p: string): Promise<boolean> {
		try {
			await fs.access(this.abs(p))
			return true
		} catch {
			return false
		}
	}

	async stat(p: string): Promise<EnvStat> {
		try {
			const s = await fs.stat(this.abs(p))
			return { isDir: s.isDirectory(), size: s.size, mtimeMs: s.mtimeMs }
		} catch (e) {
			throw new EnvironmentError("stat", p, e)
		}
	}

	async list(p: string, opts?: { recursive?: boolean }): Promise<DirEntry[]> {
		try {
			const ents = await fs.readdir(this.abs(p), {
				withFileTypes: true,
				recursive: opts?.recursive ?? false,
			})
			return ents.map((e) => ({ name: e.name, isDir: e.isDirectory() }))
		} catch (e) {
			throw new EnvironmentError("list", p, e)
		}
	}

	async mkdir(p: string, opts?: { recursive?: boolean }): Promise<void> {
		try {
			await fs.mkdir(this.abs(p), { recursive: opts?.recursive ?? true })
		} catch (e) {
			throw new EnvironmentError("mkdir", p, e)
		}
	}

	async delete(p: string, opts?: { recursive?: boolean }): Promise<void> {
		try {
			await fs.rm(this.abs(p), { recursive: opts?.recursive ?? false, force: true })
		} catch (e) {
			throw new EnvironmentError("delete", p, e)
		}
	}

	async rename(from: string, to: string): Promise<void> {
		try {
			await fs.rename(this.abs(from), this.abs(to))
		} catch (e) {
			throw new EnvironmentError("rename", from, e)
		}
	}

	async search(pattern: string, opts?: SearchOpts): Promise<Match[]> {
		const dir = this.abs(opts?.path ?? ".")
		const raw = await regexSearchFiles(
			this.cwd,
			dir,
			pattern,
			opts?.glob,
			undefined,
			undefined,
			opts?.contextLines,
			undefined,
			opts?.abortSignal,
		)
		return parseRipgrepOutput(raw)
	}

	exec(cmd: string, opts?: ExecOpts): ExecHandle {
		const cwd = opts?.cwd ? this.abs(opts.cwd) : this.cwd
		const child = spawn(cmd, {
			cwd,
			shell: true,
			env: { ...process.env, ...(opts?.env ?? {}) },
		})
		return new LocalExecHandle(child, opts)
	}

	runCommand: CommandRunner = (command, timeoutSeconds, opts) => {
		if (!this.commandRunner) {
			throw new EnvironmentError("runCommand", undefined, new Error("no command runner configured"))
		}
		return this.commandRunner(command, timeoutSeconds, opts)
	}

	async listFilesNative(
		p: string,
		recursive: boolean,
		limit: number,
		abortSignal?: AbortSignal,
	): Promise<[FileInfo[], boolean]> {
		const { listFiles } = await import("@services/glob/list-files")
		return listFiles(this.abs(p), recursive, limit, abortSignal)
	}

	async searchFormatted(
		directoryPath: string,
		regex: string,
		opts?: SearchOpts & { isaacIgnoreController?: any; taskId?: string },
	): Promise<string> {
		const { regexSearchFiles: rg } = await import("@services/ripgrep")
		return rg(
			this.cwd,
			this.abs(directoryPath),
			regex,
			opts?.filePattern ?? opts?.glob,
			opts?.isaacIgnoreController,
			opts?.taskId,
			opts?.contextLines,
			opts?.excludeFilePatterns,
			opts?.abortSignal,
		)
	}

	async dispose(): Promise<void> {}
}

/** Best-effort parse of "path:line:col:text" lines into structured matches. */
export function parseRipgrepOutput(raw: string): Match[] {
	const matches: Match[] = []
	for (const line of raw.split("\n")) {
		const m = line.match(/^(.+?):(\d+):(\d+):(.*)$/)
		if (m) {
			matches.push({ file: m[1], line: Number(m[2]), column: Number(m[3]), text: m[4] })
		}
	}
	return matches
}

class LocalExecHandle implements ExecHandle {
	readonly stdout: AsyncIterable<string>
	readonly stderr: AsyncIterable<string>
	readonly exitCode: Promise<number>
	constructor(
		private child: ChildProcess,
		opts?: ExecOpts,
	) {
		this.stdout = streamFrom(child, "stdout")
		this.stderr = streamFrom(child, "stderr")
		this.exitCode = new Promise<number>((resolve) => {
			child.on("close", (code) => resolve(code ?? 0))
		})
		if (opts?.abortSignal) {
			opts.abortSignal.addEventListener("abort", () => this.kill(), { once: true })
		}
		if (opts?.timeoutSeconds) {
			const t = setTimeout(() => this.kill(), opts.timeoutSeconds * 1000)
			void this.exitCode.finally(() => clearTimeout(t))
		}
	}
	writeStdin(data: string): void {
		this.child.stdin?.write(data)
	}
	kill(signal: NodeJS.Signals = "SIGTERM"): void {
		this.child.kill(signal)
	}
}

async function* streamFrom(child: ChildProcess, which: "stdout" | "stderr"): AsyncIterable<string> {
	const stream = child[which]
	if (!stream) {
		return
	}
	for await (const chunk of stream) {
		yield chunk.toString("utf8")
	}
}
