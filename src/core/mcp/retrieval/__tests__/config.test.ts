import { afterEach, describe, it } from "mocha"
import "should"
import { getRetrievalConfig } from "../config"

describe("getRetrievalConfig", () => {
	afterEach(() => {
		delete process.env.AILIANCE_MCP_TOP_K
		delete process.env.AILIANCE_MCP_FIND_K
		delete process.env.AILIANCE_MCP_THRESHOLD
	})

	it("returns sane defaults", () => {
		getRetrievalConfig().should.deepEqual({ baseK: 8, findK: 5, threshold: 0.3 })
	})

	it("honors env overrides and ignores invalid ones", () => {
		process.env.AILIANCE_MCP_TOP_K = "12"
		process.env.AILIANCE_MCP_THRESHOLD = "0.45"
		process.env.AILIANCE_MCP_FIND_K = "not-a-number"
		getRetrievalConfig().should.deepEqual({ baseK: 12, findK: 5, threshold: 0.45 })
	})
})
