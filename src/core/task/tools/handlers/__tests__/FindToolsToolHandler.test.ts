import { afterEach, describe, it } from "mocha"
import "should"
import { setActiveMcpToolSet } from "@core/mcp/retrieval/session"
import { FindToolsToolHandler } from "../FindToolsToolHandler"

describe("FindToolsToolHandler", () => {
	afterEach(() => setActiveMcpToolSet(undefined))

	it("expands the active set and reports activated tools", async () => {
		const calls: string[] = []
		setActiveMcpToolSet({
			expand: async (q: string) => {
				calls.push(q)
				return ["mcp__git__issues"]
			},
			available: () => true,
		} as any)
		const handler = new FindToolsToolHandler()
		const res = await handler.execute({} as any, { params: { query: "github issues" } } as any)
		calls.should.deepEqual(["github issues"])
		JSON.stringify(res).should.match(/mcp__git__issues/)
	})

	it("reports unavailability when retrieval is disabled", async () => {
		setActiveMcpToolSet(undefined)
		const handler = new FindToolsToolHandler()
		const res = await handler.execute({} as any, { params: { query: "x" } } as any)
		JSON.stringify(res).should.match(/unavailable|not available/i)
	})
})
