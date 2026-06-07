import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import { decodeMessages, encodeMessage } from "../protocol"
import { RpcPeer } from "../RpcPeer"
import { inProcessTransportPair } from "../transport"

describe("protocol framing", () => {
	it("round-trips a message through Content-Length framing, buffered in chunks", () => {
		const buf = encodeMessage({ jsonrpc: "2.0", id: 1, method: "env/readFile", params: { path: "a.txt" } })
		const out: any[] = []
		const decoder = decodeMessages((m) => out.push(m))
		decoder.push(buf.subarray(0, 10))
		decoder.push(buf.subarray(10))
		assert.equal(out.length, 1)
		assert.equal(out[0].method, "env/readFile")
		assert.equal(out[0].params.path, "a.txt")
	})
})

describe("RpcPeer over in-process transport", () => {
	it("routes a request to the server handler and returns the result", async () => {
		const [clientT, serverT] = inProcessTransportPair()
		const server = new RpcPeer(serverT, { "env/echo": async (p) => ({ echoed: p.value }) })
		const client = new RpcPeer(clientT)
		assert.deepEqual(await client.request("env/echo", { value: 42 }), { echoed: 42 })
		server.dispose()
		client.dispose()
	})
	it("propagates handler errors as rejections", async () => {
		const [clientT, serverT] = inProcessTransportPair()
		new RpcPeer(serverT, {
			"env/boom": async () => {
				throw new Error("nope")
			},
		})
		const client = new RpcPeer(clientT)
		await assert.rejects(() => client.request("env/boom", {}), /nope/)
	})
})
