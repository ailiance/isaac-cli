import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import { ANCHOR_DELIMITER } from "@utils/line-hashing"
import { EditExecutor } from "../EditExecutor"

const D = ANCHOR_DELIMITER

describe("EditExecutor — anchor match modes", () => {
	const lines = ["function foo() {", "\tconst x = 1", "}"]
	const lineHashes = ["Apple", "Banana", "Cherry"]

	describe("normalized mode (default)", () => {
		const exec = new EditExecutor()

		it("matches on exact byte equality", () => {
			const r = exec.resolveAnchor("anchor", `Banana${D}\tconst x = 1`, lineHashes, lines)
			assert.equal(r.index, 1)
			assert.equal(r.error, undefined)
		})

		it("ignores leading whitespace differences (tabs vs spaces)", () => {
			const r = exec.resolveAnchor("anchor", `Banana${D}    const x = 1`, lineHashes, lines)
			assert.equal(r.index, 1, r.error)
		})

		it("ignores trailing whitespace", () => {
			const r = exec.resolveAnchor("anchor", `Banana${D}\tconst x = 1   `, lineHashes, lines)
			assert.equal(r.index, 1, r.error)
		})

		it("ignores indent removal entirely", () => {
			const r = exec.resolveAnchor("anchor", `Banana${D}const x = 1`, lineHashes, lines)
			assert.equal(r.index, 1, r.error)
		})

		it("ignores CRLF on the provided content", () => {
			// Note: the resolveAnchor code rejects providedContent containing
			// \n or \r outright, but a trailing \r in the file's actual line
			// (CRLF input) must still match a clean LF provided content.
			const crlfLines = ["function foo() {\r", "\tconst x = 1\r", "}\r"]
			const r = exec.resolveAnchor("anchor", `Banana${D}\tconst x = 1`, lineHashes, crlfLines)
			assert.equal(r.index, 1, r.error)
		})

		it("fails with actionable diagnostic when content is genuinely different", () => {
			const r = exec.resolveAnchor("anchor", `Banana${D}const x = 999`, lineHashes, lines)
			assert.equal(r.index, -1)
			assert.match(r.error || "", /does not match/)
			assert.match(r.error || "", /Expected:/)
			assert.match(r.error || "", /Provided:/)
		})

		it("suggests closest other match line when one exists", () => {
			// Anchor B points at "alpha beta", but the model provided
			// "alpha beta gamma" which is much closer to line 3 → similarity hint.
			const f = ["something different", "alpha beta", "alpha beta gamma delta", "unrelated"]
			const h = ["A", "B", "G", "D"]
			const r = exec.resolveAnchor("anchor", `B${D}alpha beta gamma delta`, h, f)
			assert.equal(r.index, -1)
			assert.match(r.error || "", /Closest other match/)
		})

		it("emits 'no close match' hint when nothing is similar", () => {
			const r = exec.resolveAnchor("anchor", `Banana${D}xyzzy plugh`, lineHashes, lines)
			assert.equal(r.index, -1)
			assert.match(r.error || "", /No close match|Closest other match/)
		})
	})

	describe("strict mode (regression / opt-in)", () => {
		const exec = new EditExecutor("strict")

		it("matches on exact byte equality", () => {
			const r = exec.resolveAnchor("anchor", `Banana${D}\tconst x = 1`, lineHashes, lines)
			assert.equal(r.index, 1, r.error)
		})

		it("rejects whitespace differences", () => {
			const r = exec.resolveAnchor("anchor", `Banana${D}    const x = 1`, lineHashes, lines)
			assert.equal(r.index, -1)
			assert.match(r.error || "", /does not match/)
		})

		it("rejects trailing whitespace", () => {
			const r = exec.resolveAnchor("anchor", `Banana${D}\tconst x = 1 `, lineHashes, lines)
			assert.equal(r.index, -1)
		})
	})

	describe("normalized mode preserves correctness of applyEdits", () => {
		it("uses the file's actual line as anchor reference, not the provided one", () => {
			const exec = new EditExecutor()
			const block: any = {
				params: {
					edits: [
						{
							anchor: `Banana${D}    const x = 1`, // wrong indent on input
							edit_type: "insert_after",
							text: "\tconst y = 2",
						},
					],
				},
			}
			const { resolvedEdits, failedEdits } = exec.resolveEdits([block], lines, lineHashes)
			assert.equal(failedEdits.length, 0, JSON.stringify(failedEdits))
			assert.equal(resolvedEdits.length, 1)
			assert.equal(resolvedEdits[0].lineIdx, 1)

			const { finalLines } = exec.applyEdits(lines, resolvedEdits)
			assert.deepEqual(finalLines, ["function foo() {", "\tconst x = 1", "\tconst y = 2", "}"])
		})
	})
})
