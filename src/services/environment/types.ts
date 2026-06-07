import type { FileInfo } from "@services/glob/list-files"

export type { FileInfo }

export interface EnvStat {
	isDir: boolean
	size: number
	mtimeMs: number
}

export interface DirEntry {
	name: string
	isDir: boolean
}

export interface Match {
	file: string
	line: number
	column: number
	text: string
}

export interface SearchOpts {
	path?: string
	glob?: string
	contextLines?: number
	abortSignal?: AbortSignal
	filePattern?: string
	excludeFilePatterns?: string[]
}

export interface ExecOpts {
	cwd?: string
	timeoutSeconds?: number
	abortSignal?: AbortSignal
	env?: Record<string, string>
}

export interface ExecHandle {
	readonly stdout: AsyncIterable<string>
	readonly stderr: AsyncIterable<string>
	writeStdin(data: string): void
	kill(signal?: NodeJS.Signals): void
	readonly exitCode: Promise<number>
}

export type CommandRunner = (
	command: string,
	timeoutSeconds: number,
	opts: {
		onOutputLine?: (line: string) => void
		abortSignal?: AbortSignal
		useBackgroundExecution?: boolean
		suppressUserInteraction?: boolean
	},
) => Promise<[boolean, string]>

export class EnvironmentError extends Error {
	constructor(
		readonly op: string,
		readonly targetPath: string | undefined,
		override readonly cause: unknown,
	) {
		super(`environment ${op} failed${targetPath ? ` for ${targetPath}` : ""}: ${String(cause)}`)
		this.name = "EnvironmentError"
	}
}

export interface Environment {
	readonly id: string
	readonly cwd: string
	readFile(path: string): Promise<string>
	writeFile(path: string, content: string): Promise<void>
	exists(path: string): Promise<boolean>
	stat(path: string): Promise<EnvStat>
	list(path: string, opts?: { recursive?: boolean }): Promise<DirEntry[]>
	mkdir(path: string, opts?: { recursive?: boolean }): Promise<void>
	delete(path: string, opts?: { recursive?: boolean }): Promise<void>
	rename(from: string, to: string): Promise<void>
	search(pattern: string, opts?: SearchOpts): Promise<Match[]>
	exec(cmd: string, opts?: ExecOpts): ExecHandle
	runCommand: CommandRunner
	listFilesNative(path: string, recursive: boolean, limit: number, abortSignal?: AbortSignal): Promise<[FileInfo[], boolean]>
	searchFormatted(
		directoryPath: string,
		regex: string,
		opts?: SearchOpts & { isaacIgnoreController?: unknown; taskId?: string },
	): Promise<string>
	dispose(): Promise<void>
}
