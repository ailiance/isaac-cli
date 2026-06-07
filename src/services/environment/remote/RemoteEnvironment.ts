import type { CommandRunner, DirEntry, Environment, EnvStat, ExecHandle, ExecOpts, FileInfo, SearchOpts } from "../types"
import { NOTIFY, RPC_METHODS } from "./protocol"
import { RpcPeer } from "./RpcPeer"
import type { Transport } from "./transport"

export class RemoteEnvironment implements Environment {
	readonly id: string
	private peer: RpcPeer
	private onClose?: () => void
	// Per-call output routing. The client owns the streamId so concurrent
	// runCommand calls never cross-route their output. The output handler is
	// registered ONCE in the constructor and demultiplexes on params.streamId.
	private streamCounter = 0
	private outputSinks = new Map<string, (line: string) => void>()
	constructor(
		transport: Transport,
		readonly cwd: string,
		opts?: { id?: string; onClose?: () => void },
	) {
		this.id = opts?.id ?? "remote"
		this.onClose = opts?.onClose
		this.peer = new RpcPeer(transport)
		this.peer.onNotify(NOTIFY.output, (params: any) => {
			if (params?.stream === "stdout" && typeof params?.streamId === "string") {
				this.outputSinks.get(params.streamId)?.(params.chunk)
			}
		})
	}

	readFile(p: string): Promise<string> {
		return this.peer.request(RPC_METHODS.readFile, { path: p })
	}
	writeFile(p: string, content: string): Promise<void> {
		return this.peer.request(RPC_METHODS.writeFile, { path: p, content })
	}
	exists(p: string): Promise<boolean> {
		return this.peer.request(RPC_METHODS.exists, { path: p })
	}
	stat(p: string): Promise<EnvStat> {
		return this.peer.request(RPC_METHODS.stat, { path: p })
	}
	list(p: string, o?: { recursive?: boolean }): Promise<DirEntry[]> {
		return this.peer.request(RPC_METHODS.list, { path: p, opts: o })
	}
	mkdir(p: string, o?: { recursive?: boolean }): Promise<void> {
		return this.peer.request(RPC_METHODS.mkdir, { path: p, opts: o })
	}
	delete(p: string, o?: { recursive?: boolean }): Promise<void> {
		return this.peer.request(RPC_METHODS.delete, { path: p, opts: o })
	}
	rename(from: string, to: string): Promise<void> {
		return this.peer.request(RPC_METHODS.rename, { from, to })
	}
	listFilesNative(p: string, recursive: boolean, limit: number): Promise<[FileInfo[], boolean]> {
		return this.peer.request(RPC_METHODS.listFilesNative, { path: p, recursive, limit })
	}
	searchFormatted(
		directoryPath: string,
		regex: string,
		opts?: SearchOpts & { taskId?: string; cwd?: string },
	): Promise<string> {
		// isaacIgnoreController is intentionally NOT serialized; the daemon applies ignore locally.
		const o: any = opts ?? {}
		return this.peer.request(RPC_METHODS.searchFormatted, {
			directoryPath,
			regex,
			opts: {
				filePattern: o.filePattern,
				glob: o.glob,
				contextLines: o.contextLines,
				excludeFilePatterns: o.excludeFilePatterns,
				cwd: o.cwd,
				taskId: o.taskId,
			},
		})
	}

	runCommand: CommandRunner = (command, timeoutSeconds, opts) => {
		const streamId = `c${++this.streamCounter}`
		if (opts?.onOutputLine) {
			this.outputSinks.set(streamId, opts.onOutputLine)
		}
		let onAbort: (() => void) | undefined
		if (opts?.abortSignal) {
			onAbort = () => this.peer.notify(NOTIFY.abort, { streamId })
			opts.abortSignal.addEventListener("abort", onAbort, { once: true })
		}
		return this.peer
			.request(RPC_METHODS.runCommand, {
				command,
				timeoutSeconds,
				streamId,
				opts: {
					useBackgroundExecution: opts?.useBackgroundExecution,
					suppressUserInteraction: opts?.suppressUserInteraction,
				},
			})
			.then((r) => r as [boolean, any])
			.finally(() => {
				this.outputSinks.delete(streamId)
				if (onAbort) {
					opts?.abortSignal?.removeEventListener("abort", onAbort)
				}
			})
	}

	exec(_cmd: string, _opts?: ExecOpts): ExecHandle {
		// No in-tree consumer in #2 MVP (agent uses runCommand). Streaming exec over
		// the wire is a #2.x addition; throw rather than ship a half-streaming handle.
		throw new Error("RemoteEnvironment.exec is not implemented in #2 MVP; use runCommand")
	}

	async dispose(): Promise<void> {
		try {
			await this.peer.request(RPC_METHODS.dispose, {})
		} catch {}
		this.peer.dispose()
		this.onClose?.()
	}
}
