import { EnvironmentError } from "../types"

export const RPC_METHODS = {
	readFile: "env/readFile",
	writeFile: "env/writeFile",
	exists: "env/exists",
	stat: "env/stat",
	list: "env/list",
	mkdir: "env/mkdir",
	delete: "env/delete",
	rename: "env/rename",
	listFilesNative: "env/listFilesNative",
	searchFormatted: "env/searchFormatted",
	runCommand: "env/runCommand",
	dispose: "env/dispose",
} as const

export const NOTIFY = {
	output: "env/output", // server -> client: { streamId, stream, chunk }
	stdin: "env/stdin",
	kill: "env/kill",
	abort: "env/abort",
} as const

export interface RpcRequest {
	jsonrpc: "2.0"
	id: number
	method: string
	params?: any
}
export interface RpcResponse {
	jsonrpc: "2.0"
	id: number
	result?: any
	error?: RpcError
}
export interface RpcNotification {
	jsonrpc: "2.0"
	method: string
	params?: any
}
export type RpcMessage = RpcRequest | RpcResponse | RpcNotification
export interface RpcError {
	code: number
	message: string
	data?: { op?: string; errno?: number; code?: string }
}

export function encodeMessage(msg: RpcMessage): Buffer {
	const json = Buffer.from(JSON.stringify(msg), "utf8")
	const header = Buffer.from(`Content-Length: ${json.length}\r\n\r\n`, "ascii")
	return Buffer.concat([header, json])
}

/** Stateful decoder: feed chunks via push(); calls onMessage per complete frame. */
export function decodeMessages(onMessage: (m: RpcMessage) => void) {
	let buffer = Buffer.alloc(0)
	return {
		push(chunk: Buffer) {
			buffer = Buffer.concat([buffer, chunk])
			while (true) {
				const headerEnd = buffer.indexOf("\r\n\r\n")
				if (headerEnd === -1) {
					return
				}
				const header = buffer.subarray(0, headerEnd).toString("ascii")
				const match = header.match(/Content-Length:\s*(\d+)/i)
				if (!match) {
					buffer = buffer.subarray(headerEnd + 4)
					continue
				}
				const len = Number(match[1])
				const start = headerEnd + 4
				if (buffer.length < start + len) {
					return
				}
				const body = buffer.subarray(start, start + len).toString("utf8")
				buffer = buffer.subarray(start + len)
				onMessage(JSON.parse(body))
			}
		},
	}
}

export function toRpcError(e: unknown): RpcError {
	if (e instanceof EnvironmentError) {
		const cause: any = e.cause
		return { code: -32000, message: e.message, data: { op: e.op, errno: cause?.errno, code: cause?.code } }
	}
	const any: any = e
	return { code: -32000, message: String(any?.message ?? e), data: { code: any?.code } }
}

export function fromRpcError(err: RpcError): Error {
	const e: any = new EnvironmentError(err.data?.op ?? "remote", undefined, new Error(err.message))
	if (err.data?.code) {
		e.cause = { code: err.data.code, errno: err.data.errno, message: err.message }
	}
	return e
}
