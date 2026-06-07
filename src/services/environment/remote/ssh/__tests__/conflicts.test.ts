import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import { sideDirResolver } from "../conflicts"

describe("sideDirResolver", () => {
	it("routes every conflict to side-dir", async () => {
		const d = await sideDirResolver(["a.txt", "b.txt"], { sessionId: "s1" } as any)
		assert.equal(d.get("a.txt"), "side-dir")
		assert.equal(d.get("b.txt"), "side-dir")
	})
	it("empty conflicts -> empty map", async () => {
		assert.equal((await sideDirResolver([], {} as any)).size, 0)
	})
})
