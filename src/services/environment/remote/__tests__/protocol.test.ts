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

	// C2: a framed-but-malformed body must not throw out of the data listener
	// (an uncaughtException would crash the daemon). The frame is dropped and a
	// subsequent valid frame is still decoded.
	it("drops a malformed body without throwing and keeps decoding", () => {
		const out: any[] = []
		const decoder = decodeMessages((m) => out.push(m))
		const bad = Buffer.from("not-json{", "utf8")
		const badFrame = Buffer.concat([Buffer.from(`Content-Length: ${bad.length}\r\n\r\n`, "ascii"), bad])
		assert.doesNotThrow(() => decoder.push(badFrame))
		assert.equal(out.length, 0)
		const good = encodeMessage({ jsonrpc: "2.0", id: 7, method: "env/exists", params: { path: "x" } })
		assert.doesNotThrow(() => decoder.push(good))
		assert.equal(out.length, 1)
		assert.equal(out[0].method, "env/exists")
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

	// I3: a transport close (e.g. daemon spawn failure / crash) must reject any
	// in-flight request rather than leave the promise pending forever.
	it("rejects pending requests when the transport closes", async () => {
		const [clientT] = inProcessTransportPair()
		const client = new RpcPeer(clientT)
		const p = client.request("env/never", {})
		clientT.close()
		await assert.rejects(() => p, /transport closed/)
	})
})
