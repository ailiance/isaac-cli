import type { ChildProcessWithoutNullStreams } from "node:child_process"
import { decodeMessages, encodeMessage, type RpcMessage } from "./protocol"

export interface Transport {
	send(msg: RpcMessage): void
	onMessage(cb: (m: RpcMessage) => void): void
	close(): void
}

export function inProcessTransportPair(): [Transport, Transport] {
	let aCb: ((m: RpcMessage) => void) | null = null
	let bCb: ((m: RpcMessage) => void) | null = null
	const a: Transport = {
		send: (m) => queueMicrotask(() => bCb?.(structuredClone(m))),
		onMessage: (cb) => {
			aCb = cb
		},
		close: () => {
			aCb = null
		},
	}
	const b: Transport = {
		send: (m) => queueMicrotask(() => aCb?.(structuredClone(m))),
		onMessage: (cb) => {
			bCb = cb
		},
		close: () => {
			bCb = null
		},
	}
	return [a, b]
}

export function subprocessTransport(child: ChildProcessWithoutNullStreams): Transport {
	let cb: ((m: RpcMessage) => void) | null = null
	const decoder = decodeMessages((m) => cb?.(m))
	child.stdout.on("data", (d: Buffer) => decoder.push(d))
	return {
		send: (m) => child.stdin.write(encodeMessage(m)),
		onMessage: (c) => {
			cb = c
		},
		close: () => {
			try {
				child.kill()
			} catch {}
		},
	}
}

/** Daemon side: frame over the current process's own stdio. */
export function stdioTransport(): Transport {
	let cb: ((m: RpcMessage) => void) | null = null
	const decoder = decodeMessages((m) => cb?.(m))
	process.stdin.on("data", (d: Buffer) => decoder.push(d))
	return {
		send: (m) => process.stdout.write(encodeMessage(m)),
		onMessage: (c) => {
			cb = c
		},
		close: () => {},
	}
}
