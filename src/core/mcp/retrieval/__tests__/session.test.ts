import { describe, it } from "mocha"
import "should"
import { getActiveMcpToolSet, setActiveMcpToolSet } from "../session"

describe("active mcp tool set session", () => {
	it("stores and returns the current set; undefined by default after clear", () => {
		setActiveMcpToolSet(undefined)
		;(getActiveMcpToolSet() === undefined).should.equal(true)
		const fake = { snapshot: () => new Set(["mcp__x__y"]) } as any
		setActiveMcpToolSet(fake)
		getActiveMcpToolSet()!.snapshot().has("mcp__x__y").should.equal(true)
	})
})
