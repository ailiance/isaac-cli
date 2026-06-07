import type { ChildProcessWithoutNullStreams } from "node:child_process"
import { decodeMessages, encodeMessage, type RpcMessage } from "./protocol"

export interface Transport {
	send(msg: RpcMessage): void
	onMessage(cb: (m: RpcMessage) => void): void
	/** Register a callback fired when the transport is closed (locally or remotely). */
	onClose?(cb: () => void): void
	close(): void
}

export function inProcessTransportPair(): [Transport, Transport] {
	let aCb: ((m: RpcMessage) => void) | null = null
	let bCb: ((m: RpcMessage) => void) | null = null
	let aClose: (() => void) | null = null
	let bClose: (() => void) | null = null
	const a: Transport = {
		send: (m) => queueMicrotask(() => bCb?.(structuredClone(m))),
		onMessage: (cb) => {
			aCb = cb
		},
		onClose: (cb) => {
			aClose = cb
		},
		close: () => {
			aCb = null
			aClose?.()
		},
	}
	const b: Transport = {
		send: (m) => queueMicrotask(() => aCb?.(structuredClone(m))),
		onMessage: (cb) => {
			bCb = cb
		},
		onClose: (cb) => {
			bClose = cb
		},
		close: () => {
			bCb = null
			bClose?.()
		},
	}
	return [a, b]
}

export function subprocessTransport(child: ChildProcessWithoutNullStreams): Transport {
	let cb: ((m: RpcMessage) => void) | null = null
	let closeCb: (() => void) | null = null
	let closed = false
	const decoder = decodeMessages((m) => cb?.(m))
	child.stdout.on("data", (d: Buffer) => decoder.push(d))
	const fireClose = () => {
		if (closed) {
			return
		}
		closed = true
		closeCb?.()
	}
	// A spawn failure or premature exit must not leave requests pending forever.
	child.on("error", fireClose)
	child.on("exit", fireClose)
	return {
		send: (m) => child.stdin.write(encodeMessage(m)),
		onMessage: (c) => {
			cb = c
		},
		onClose: (c) => {
			closeCb = c
		},
		close: () => {
			try {
				child.kill()
			} catch {}
			fireClose()
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
