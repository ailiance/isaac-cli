import { fromRpcError, type RpcMessage, type RpcRequest, type RpcResponse, toRpcError } from "./protocol"
import type { Transport } from "./transport"

type Handler = (params: any) => Promise<any>
type NotifyHandler = (params: any) => void

export class RpcPeer {
	private nextId = 1
	private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>()
	private notifyHandlers = new Map<string, NotifyHandler>()

	constructor(
		private transport: Transport,
		private handlers: Record<string, Handler> = {},
	) {
		transport.onMessage((m) => this.onMessage(m))
	}

	request(method: string, params?: any): Promise<any> {
		const id = this.nextId++
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject })
			this.transport.send({ jsonrpc: "2.0", id, method, params } satisfies RpcRequest)
		})
	}
	notify(method: string, params?: any): void {
		this.transport.send({ jsonrpc: "2.0", method, params })
	}
	onNotify(method: string, cb: NotifyHandler): void {
		this.notifyHandlers.set(method, cb)
	}

	private onMessage(m: RpcMessage): void {
		if ("id" in m && "method" in m) {
			const req = m as RpcRequest
			const handler = this.handlers[req.method]
			if (!handler) {
				this.transport.send({
					jsonrpc: "2.0",
					id: req.id,
					error: { code: -32601, message: `no handler: ${req.method}` },
				})
				return
			}
			handler(req.params)
				.then((result) => this.transport.send({ jsonrpc: "2.0", id: req.id, result }))
				.catch((e) => this.transport.send({ jsonrpc: "2.0", id: req.id, error: toRpcError(e) }))
		} else if ("id" in m) {
			const res = m as RpcResponse
			const p = this.pending.get(res.id)
			if (!p) {
				return
			}
			this.pending.delete(res.id)
			if (res.error) {
				p.reject(fromRpcError(res.error))
			} else {
				p.resolve(res.result)
			}
		} else if ("method" in m) {
			this.notifyHandlers.get(m.method)?.(m.params)
		}
	}

	dispose(): void {
		for (const p of this.pending.values()) {
			p.reject(new Error("RpcPeer disposed"))
		}
		this.pending.clear()
		this.transport.close()
	}
}
