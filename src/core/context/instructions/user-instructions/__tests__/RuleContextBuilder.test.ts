import { expect } from "chai"
import sinon from "sinon"
import { RuleContextBuilder, RuleContextBuilderDeps } from "../RuleContextBuilder"

// Mock HostProvider to avoid actual VSCode API calls
const mockHostProvider = {
	window: {
		getVisibleTabs: sinon.stub().resolves({ paths: [] }),
		getOpenTabs: sinon.stub().resolves({ paths: [] }),
	},
}

describe("RuleContextBuilder", () => {
	let hostProviderStub: sinon.SinonStub

	beforeEach(() => {
		// Stub HostProvider to use mock
		hostProviderStub = sinon.stub(require("@/hosts/host-provider"), "HostProvider").value(mockHostProvider)
	})

	afterEach(() => {
		sinon.restore()
	})

	describe("getRulePathContext from ask='tool' messages", () => {
		it("extracts path from ask='tool' message with write_to_file", async () => {
			const deps: RuleContextBuilderDeps = {
				cwd: "/workspace",
				messageStateHandler: {
					getIsaacMessages: () => [
						{
							type: "ask",
							ask: "tool",
							text: JSON.stringify({
								tool: "write_to_file",
								path: "src/components/Button.tsx",
								content: "// new file",
							}),
						},
					],
				},
			}

			const context = await RuleContextBuilder.buildEvaluationContext(deps)
			expect(context.paths).to.include("src/components/Button.tsx")
		})

		it("extracts paths from multiple sequential tool requests", async () => {
			const deps: RuleContextBuilderDeps = {
				cwd: "/workspace",
				messageStateHandler: {
					getIsaacMessages: () => [
						{
							type: "ask",
							ask: "tool",
							text: JSON.stringify({
								tool: "write_to_file",
								path: "src/utils/helper.ts",
							}),
						},
						{
							type: "ask",
							ask: "tool",
							text: JSON.stringify({
								tool: "edit_file",
								path: "src/index.ts",
							}),
						},
					],
				},
			}

			const context = await RuleContextBuilder.buildEvaluationContext(deps)
			expect(context.paths).to.include("src/utils/helper.ts")
			expect(context.paths).to.include("src/index.ts")
		})

		it("handles malformed JSON gracefully", async () => {
			const deps: RuleContextBuilderDeps = {
				cwd: "/workspace",
				messageStateHandler: {
					getIsaacMessages: () => [
						{
							type: "ask",
							ask: "tool",
							text: "not valid json {{{",
						},
						{
							type: "ask",
							ask: "tool",
							text: JSON.stringify({
								tool: "write_to_file",
								path: "valid/path.ts",
							}),
						},
					],
				},
			}

			// Should not throw and should extract the valid path
			const context = await RuleContextBuilder.buildEvaluationContext(deps)
			expect(context.paths).to.include("valid/path.ts")
		})

		it("deduplicates paths from multiple sources", async () => {
			const deps: RuleContextBuilderDeps = {
				cwd: "/workspace",
				messageStateHandler: {
					getIsaacMessages: () => [
						{
							type: "say",
							say: "task",
							text: "Update src/index.ts",
						},
						{
							type: "ask",
							ask: "tool",
							text: JSON.stringify({
								tool: "write_to_file",
								path: "src/index.ts",
							}),
						},
						{
							type: "say",
							say: "tool",
							text: JSON.stringify({
								tool: "editedExistingFile",
								path: "src/index.ts",
							}),
						},
					],
				},
			}

			const context = await RuleContextBuilder.buildEvaluationContext(deps)
			// Should only appear once despite being in 3 messages
			const indexCount = (context.paths ?? []).filter((p) => p === "src/index.ts").length
			expect(indexCount).to.equal(1)
		})

		it("normalizes Windows-style paths to POSIX", async () => {
			const deps: RuleContextBuilderDeps = {
				cwd: "/workspace",
				messageStateHandler: {
					getIsaacMessages: () => [
						{
							type: "ask",
							ask: "tool",
							text: JSON.stringify({
								tool: "write_to_file",
								path: "src\\components\\Button.tsx",
							}),
						},
					],
				},
			}

			const context = await RuleContextBuilder.buildEvaluationContext(deps)
			expect(context.paths).to.include("src/components/Button.tsx")
		})

		it("respects MAX_RULE_PATH_CANDIDATES limit", async () => {
			// Create more messages than the limit
			const messages: Array<{ type: string; ask: string; text: string }> = []
			for (let i = 0; i < RuleContextBuilder.MAX_RULE_PATH_CANDIDATES + 50; i++) {
				messages.push({
					type: "ask",
					ask: "tool",
					text: JSON.stringify({
						tool: "write_to_file",
						path: `src/file${i}.ts`,
					}),
				})
			}

			const deps: RuleContextBuilderDeps = {
				cwd: "/workspace",
				messageStateHandler: {
					getIsaacMessages: () => messages,
				},
			}

			const context = await RuleContextBuilder.buildEvaluationContext(deps)
			expect((context.paths ?? []).length).to.be.at.most(RuleContextBuilder.MAX_RULE_PATH_CANDIDATES)
		})
	})
})
