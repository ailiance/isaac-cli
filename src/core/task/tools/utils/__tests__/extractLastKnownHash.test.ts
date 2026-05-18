import { expect } from "chai"
import type { DiracStorageMessage } from "@/shared/messages"
import { DiracDefaultTool } from "@/shared/tools"
import { extractLastKnownHashFromHistory } from "../extractLastKnownHash"

/**
 * Builds a minimal assistant/user message pair representing a `read_file`
 * tool call against `targetPath` whose result carries `[File Hash: ...]`.
 */
function readFilePair(toolUseId: string, targetPath: string, resultText: string): DiracStorageMessage[] {
	return [
		{
			role: "assistant",
			content: [
				{
					type: "tool_use",
					id: toolUseId,
					name: DiracDefaultTool.FILE_READ,
					input: { path: targetPath },
				},
			],
		} as unknown as DiracStorageMessage,
		{
			role: "user",
			content: [
				{
					type: "tool_result",
					tool_use_id: toolUseId,
					content: resultText,
				},
			],
		} as unknown as DiracStorageMessage,
	]
}

describe("extractLastKnownHashFromHistory — stale anchor detection", () => {
	it("returns undefined when the history is empty", () => {
		expect(extractLastKnownHashFromHistory([], "src/a.ts")).to.equal(undefined)
	})

	it("returns undefined when the path was never read", () => {
		const history = readFilePair("t1", "src/other.ts", "[File Hash: abc123]\nline1")
		expect(extractLastKnownHashFromHistory(history, "src/a.ts")).to.equal(undefined)
	})

	it("extracts the hash from the most recent read of the path", () => {
		const history = readFilePair("t1", "src/a.ts", "[File Hash: deadbeef]\nconst x = 1")
		expect(extractLastKnownHashFromHistory(history, "src/a.ts")).to.equal("deadbeef")
	})

	it("returns the latest hash when a path was read more than once", () => {
		const history = [
			...readFilePair("t1", "src/a.ts", "[File Hash: aaaaaa]\nold"),
			...readFilePair("t2", "src/a.ts", "[File Hash: bbbbbb]\nnew"),
		]
		expect(extractLastKnownHashFromHistory(history, "src/a.ts")).to.equal("bbbbbb")
	})

	it("matches paths that differ only by normalization", () => {
		const history = readFilePair("t1", "./src/a.ts", "[File Hash: cafe01]\nline")
		expect(extractLastKnownHashFromHistory(history, "src/a.ts")).to.equal("cafe01")
	})

	it("extracts the per-file section hash from a multi-file read result", () => {
		const multiResult =
			"--- src/a.ts ---\n[File Hash: 111aaa]\ncontent a\n" + "--- src/b.ts ---\n[File Hash: 222bbb]\ncontent b"
		const history = [
			{
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: "t1",
						name: DiracDefaultTool.FILE_READ,
						input: { paths: ["src/a.ts", "src/b.ts"] },
					},
				],
			} as unknown as DiracStorageMessage,
			{
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "t1", content: multiResult }],
			} as unknown as DiracStorageMessage,
		]
		expect(extractLastKnownHashFromHistory(history, "src/b.ts")).to.equal("222bbb")
	})

	it("ignores a result block whose tool_use_id does not match", () => {
		const history: DiracStorageMessage[] = [
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "t1", name: DiracDefaultTool.FILE_READ, input: { path: "src/a.ts" } }],
			} as unknown as DiracStorageMessage,
			{
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "MISMATCH", content: "[File Hash: zzzzzz]" }],
			} as unknown as DiracStorageMessage,
		]
		expect(extractLastKnownHashFromHistory(history, "src/a.ts")).to.equal(undefined)
	})

	it("ignores tool calls whose name is not read_file", () => {
		const history: DiracStorageMessage[] = [
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "t1", name: DiracDefaultTool.EDIT_FILE, input: { path: "src/a.ts" } }],
			} as unknown as DiracStorageMessage,
			{
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "t1", content: "[File Hash: 999999]" }],
			} as unknown as DiracStorageMessage,
		]
		expect(extractLastKnownHashFromHistory(history, "src/a.ts")).to.equal(undefined)
	})
})
