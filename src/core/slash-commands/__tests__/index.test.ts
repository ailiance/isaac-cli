import { expect } from "chai"
import { parseSlashCommands } from "../index"

describe("slash-commands", () => {
	it("should return original text if no slash command is found", async () => {
		const text = "Hello world"
		const result = await parseSlashCommands(text, {}, {}, "test-ulid")
		expect(result.processedText).to.equal(text)
		expect(result.needsIsaacrulesFileCheck).to.equal(false)
	})

	it("should process builtin slash command", async () => {
		const text = "<task>" + "/newtask" + "</task>"
		const result = await parseSlashCommands(text, {}, {}, "test-ulid", {
			providerId: "anthropic",
			model: { id: "claude-3-5-sonnet-20240620", info: {} as any },
			mode: "act",
		})
		expect(result.processedText).to.include("help them create a new task with preloaded context")
	})

	it("should return a direct response for snapshot commands via runDirectCommand", async () => {
		const text = "<feedback>" + "/snapshot hello" + "</feedback>"
		const result = await parseSlashCommands(
			text,
			{},
			{},
			"test-ulid",
			undefined,
			[],
			undefined,
			undefined,
			undefined,
			async (_name, _arg) => "OK snap",
		)
		expect(result.isDirectResponse).to.equal(true)
		expect(result.directResponseText).to.equal("OK snap")
	})

	it("should pass the command name and trimmed argument to runDirectCommand", async () => {
		const captured: Array<{ name: string; arg: string }> = []
		const stub = async (name: string, arg: string) => {
			captured.push({ name, arg })
			return "ok"
		}
		const run = (inner: string) =>
			parseSlashCommands(`<task>${inner}</task>`, {}, {}, "test-ulid", undefined, [], undefined, undefined, undefined, stub)

		await run("/snapshot my label")
		await run("/restore snap_x")
		await run("/sessions")

		expect(captured).to.deep.equal([
			{ name: "snapshot", arg: "my label" },
			{ name: "restore", arg: "snap_x" },
			{ name: "sessions", arg: "" },
		])
	})
})
