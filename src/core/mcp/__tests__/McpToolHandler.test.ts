import { expect } from "chai"
import { afterEach, beforeEach, describe, it } from "vitest"
import sinon from "sinon"

import { formatMcpContent, McpToolHandler } from "../McpToolHandler"
import type { McpToolMetadata } from "../types"

describe("formatMcpContent", () => {
	it("returns string as-is", () => {
		expect(formatMcpContent("hello")).to.equal("hello")
	})

	it("extracts text from array of text blocks", () => {
		const content = [
			{ type: "text", text: "first" },
			{ type: "text", text: "second" },
		]
		expect(formatMcpContent(content)).to.equal("first\nsecond")
	})

	it("handles image block in array", () => {
		const content = [{ type: "image" }]
		expect(formatMcpContent(content)).to.equal("[image]")
	})

	it("JSON-stringifies unknown objects", () => {
		const content = { foo: "bar" }
		expect(formatMcpContent(content)).to.equal(JSON.stringify(content))
	})

	it("JSON-stringifies resource block", () => {
		const item = { type: "resource", uri: "file://x" }
		expect(formatMcpContent([item])).to.equal(JSON.stringify(item))
	})
})

describe("McpToolHandler", () => {
	let mcpClientManagerModule: typeof import("../McpClientManager")
	const sampleMeta: McpToolMetadata = {
		qualifiedName: "mcp__plg_srv__do_it",
		serverId: "srv",
		pluginName: "plg",
		rawName: "do_it",
		inputSchema: {},
	}

	beforeEach(async () => {
		mcpClientManagerModule = await import("../McpClientManager")
	})

	afterEach(() => {
		sinon.restore()
	})

	it("execute happy path returns success output", async () => {
		sinon.stub(mcpClientManagerModule.mcpClientManager, "callTool").resolves({
			qualifiedName: "mcp__plg_srv__do_it",
			isError: false,
			content: [{ type: "text", text: "done!" }],
		})

		const handler = new McpToolHandler(sampleMeta)
		const block = { name: "mcp__plg_srv__do_it", params: { arg1: "val" } } as any
		const result = await handler.execute({} as any, block)

		expect(result).to.equal("done!")
	})

	it("execute with isError:true returns error-prefixed string", async () => {
		sinon.stub(mcpClientManagerModule.mcpClientManager, "callTool").resolves({
			qualifiedName: "mcp__plg_srv__do_it",
			isError: true,
			content: [{ type: "text", text: "bad thing happened" }],
		})

		const handler = new McpToolHandler(sampleMeta)
		const block = { name: "mcp__plg_srv__do_it", params: {} } as any
		const result = await handler.execute({} as any, block)

		expect(result).to.equal("[mcp error] bad thing happened")
	})

	it("execute swallows thrown exception and returns error string", async () => {
		sinon.stub(mcpClientManagerModule.mcpClientManager, "callTool").rejects(new Error("connection refused"))

		const handler = new McpToolHandler(sampleMeta)
		const block = { name: "mcp__plg_srv__do_it", params: {} } as any
		const result = await handler.execute({} as any, block)

		expect(result).to.equal("[mcp error] connection refused")
	})

	it("name equals the qualifiedName cast", () => {
		const handler = new McpToolHandler(sampleMeta)
		expect(handler.name as string).to.equal("mcp__plg_srv__do_it")
	})

	it("handlePartialBlock resolves without error", async () => {
		const handler = new McpToolHandler(sampleMeta)
		let threw = false
		try {
			await handler.handlePartialBlock({} as any, {} as any)
		} catch {
			threw = true
		}
		expect(threw).to.be.false
	})
})
