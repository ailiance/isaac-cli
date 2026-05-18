import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import { ANCHOR_DELIMITER } from "@utils/line-hashing"
import { BatchProcessor } from "../BatchProcessor"
import { EditExecutor } from "../EditExecutor"
import type { FailedEdit } from "../types"

const D = ANCHOR_DELIMITER

/**
 * Builds a BatchProcessor wired to a real EditExecutor. Only the executor and
 * fuzzy-approval path are exercised here, so the other constructor deps are
 * stubbed and never reached.
 */
function makeProcessor(): BatchProcessor {
	const executor = new EditExecutor()
	return new BatchProcessor(
		{} as any, // validator — unused on this path
		executor,
		{} as any, // formatter — unused on this path
		false,
		0,
		0,
		"full",
	)
}

/**
 * Minimal TaskConfig stub: only the fields touched by requestFuzzyApprovals /
 * askFuzzyApproval. `ask` records each prompt and replies per the script.
 */
function makeConfig(opts: {
	autoApprove: boolean
	isSubagent?: boolean
	answers?: string[]
}): { config: any; prompts: string[] } {
	const prompts: string[] = []
	let answerIdx = 0
	const config = {
		isSubagentExecution: opts.isSubagent ?? false,
		callbacks: {
			shouldAutoApproveToolWithPath: async () => opts.autoApprove,
			ask: async (_type: string, text?: string) => {
				prompts.push(text ?? "")
				const answer = opts.answers?.[answerIdx++] ?? "noButtonClicked"
				return { response: answer }
			},
		},
	}
	return { config, prompts }
}

describe("BatchProcessor — fuzzy approval wiring", () => {
	const lines = ["function f() {", "  return banana()", "}"]
	const hashes = ["A", "B", "C"]
	const normHashes = hashes.map((h) => h.trim())

	/** A FailedEdit that carries one high-confidence fuzzy candidate. */
	function failedWithCandidate(): FailedEdit {
		const exec = new EditExecutor()
		const block: any = {
			params: {
				edits: [{ anchor: `B${D}  return banana();`, edit_type: "insert_after", text: "  // hi" }],
			},
		}
		const { failedEdits } = exec.resolveEdits([block], lines, hashes)
		assert.equal(failedEdits.length, 1, "fixture must produce exactly one failed edit")
		assert.equal(failedEdits[0].fuzzyCandidates?.length, 1, "fixture must carry one fuzzy candidate")
		return failedEdits[0]
	}

	it("promotes a failed edit to resolved when the user approves the fuzzy match", async () => {
		const proc = makeProcessor()
		const { config, prompts } = makeConfig({ autoApprove: false, answers: ["yesButtonClicked"] })
		const failed = failedWithCandidate()

		const { promotedEdits, remainingFailedEdits } = await (proc as any).requestFuzzyApprovals(
			config,
			"f.ts",
			[failed],
			normHashes,
			lines,
		)

		assert.equal(prompts.length, 1, "exactly one approval prompt should be shown")
		assert.ok(prompts[0].includes("fuzzyMatch"), "prompt payload must carry the fuzzyMatch block")
		assert.equal(promotedEdits.length, 1, "approved candidate must be promoted")
		assert.equal(remainingFailedEdits.length, 0, "no edit should remain failed")
		// The promoted edit pins the actual line index (1), not the bad anchor.
		assert.equal(promotedEdits[0].lineIdx, 1)
		assert.equal(promotedEdits[0].edit, failed.edit)
	})

	it("keeps the edit failed when the user refuses the fuzzy match", async () => {
		const proc = makeProcessor()
		const { config, prompts } = makeConfig({ autoApprove: false, answers: ["noButtonClicked"] })
		const failed = failedWithCandidate()

		const { promotedEdits, remainingFailedEdits } = await (proc as any).requestFuzzyApprovals(
			config,
			"f.ts",
			[failed],
			normHashes,
			lines,
		)

		assert.equal(prompts.length, 1)
		assert.equal(promotedEdits.length, 0, "refused candidate must not be promoted")
		assert.equal(remainingFailedEdits.length, 1, "edit must stay failed")
		assert.equal(remainingFailedEdits[0], failed)
	})

	it("auto-approves without prompting when the workspace auto-approves the path", async () => {
		const proc = makeProcessor()
		const { config, prompts } = makeConfig({ autoApprove: true })
		const failed = failedWithCandidate()

		const { promotedEdits } = await (proc as any).requestFuzzyApprovals(config, "f.ts", [failed], normHashes, lines)

		assert.equal(prompts.length, 0, "no prompt when the path is auto-approved")
		assert.equal(promotedEdits.length, 1, "edit must still be promoted under auto-approval")
	})

	it("leaves edits without fuzzy candidates untouched", async () => {
		const proc = makeProcessor()
		const { config, prompts } = makeConfig({ autoApprove: false })
		const plainFailure: FailedEdit = { edit: { anchor: `B${D}x`, text: "" }, error: "anchor not found" }

		const { promotedEdits, remainingFailedEdits } = await (proc as any).requestFuzzyApprovals(
			config,
			"f.ts",
			[plainFailure],
			normHashes,
			lines,
		)

		assert.equal(prompts.length, 0, "no prompt for an edit without fuzzy candidates")
		assert.equal(promotedEdits.length, 0)
		assert.equal(remainingFailedEdits.length, 1)
		assert.equal(remainingFailedEdits[0], plainFailure)
	})
})
