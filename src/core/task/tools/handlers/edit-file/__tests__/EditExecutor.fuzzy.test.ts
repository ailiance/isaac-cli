import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import { ANCHOR_DELIMITER } from "@utils/line-hashing"
import { EditExecutor, FUZZY_MATCH_THRESHOLD } from "../EditExecutor"
import type { FuzzyCandidate } from "../types"

const D = ANCHOR_DELIMITER

describe("EditExecutor — fuzzy fallback (Sprint 3 task D)", () => {
	const exec = new EditExecutor()

	describe("resolveAnchor — fuzzy candidate detection", () => {
		it("emits a fuzzy candidate when content differs by 1–2 chars (≥ threshold)", () => {
			// Levenshtein("return banana()", "return banana();") / 16 ≈ 0.06 → sim ≈ 0.94
			const lines = ["function f() {", "  return banana()", "}"]
			const hashes = ["A", "B", "C"]
			const r = exec.resolveAnchor("anchor", `B${D}  return banana();`, hashes, lines)
			assert.equal(r.index, -1)
			assert.ok(r.fuzzyCandidate, "expected fuzzyCandidate to be populated")
			assert.equal(r.fuzzyCandidate?.anchorName, "B")
			assert.equal(r.fuzzyCandidate?.actualLineIdx, 1)
			assert.equal(r.fuzzyCandidate?.actualContent, "  return banana()")
			assert.ok((r.fuzzyCandidate?.similarity ?? 0) >= FUZZY_MATCH_THRESHOLD)
		})

		it("does NOT emit a fuzzy candidate below threshold", () => {
			const lines = ["function foo() {", "  const x = 1", "}"]
			const hashes = ["A", "B", "C"]
			// Provided content shares almost nothing with the actual line.
			const r = exec.resolveAnchor("anchor", `B${D}xyzzy plugh frobnicate`, hashes, lines)
			assert.equal(r.index, -1)
			assert.equal(r.fuzzyCandidate, undefined)
		})

		it("does NOT emit a fuzzy candidate when normalized match already succeeds", () => {
			const lines = ["function f() {", "\tconst x = 1", "}"]
			const hashes = ["A", "B", "C"]
			const r = exec.resolveAnchor("anchor", `B${D}    const x = 1`, hashes, lines)
			assert.equal(r.index, 1)
			assert.equal(r.fuzzyCandidate, undefined)
		})
	})

	describe("resolveEdits — fuzzy candidates flow through to FailedEdit", () => {
		it("attaches fuzzyCandidates on the failed edit when score ≥ threshold", () => {
			const lines = ["function f() {", "  return banana()", "}"]
			const hashes = ["A", "B", "C"]
			const block: any = {
				params: {
					edits: [
						{
							anchor: `B${D}  return banana();`,
							edit_type: "insert_after",
							text: "  // hi",
						},
					],
				},
			}
			const { resolvedEdits, failedEdits } = exec.resolveEdits([block], lines, hashes)
			assert.equal(resolvedEdits.length, 0)
			assert.equal(failedEdits.length, 1)
			assert.equal(failedEdits[0].fuzzyCandidates?.length, 1)
			assert.equal(failedEdits[0].fuzzyCandidates?.[0].type, "anchor")
		})

		it("does not attach fuzzyCandidates when no candidate clears the threshold", () => {
			const lines = ["function f() {", "  const x = 1", "}"]
			const hashes = ["A", "B", "C"]
			const block: any = {
				params: {
					edits: [
						{
							anchor: `B${D}totally unrelated content`,
							edit_type: "insert_after",
							text: "x",
						},
					],
				},
			}
			const { failedEdits } = exec.resolveEdits([block], lines, hashes)
			assert.equal(failedEdits.length, 1)
			assert.equal(failedEdits[0].fuzzyCandidates, undefined)
		})

		it("collects candidates for both anchor and end_anchor on a replace edit", () => {
			const lines = [
				"function f() {",
				"  return banana()",
				"  console.log('done')",
				"}",
			]
			const hashes = ["A", "B", "C", "D"]
			const block: any = {
				params: {
					edits: [
						{
							anchor: `B${D}  return banana();`,
							end_anchor: `C${D}  console.log('done!')`,
							edit_type: "replace",
							text: "  return apple()",
						},
					],
				},
			}
			const { failedEdits } = exec.resolveEdits([block], lines, hashes)
			assert.equal(failedEdits.length, 1)
			const cands = failedEdits[0].fuzzyCandidates
			assert.equal(cands?.length, 2)
			assert.deepEqual(
				cands?.map((c: FuzzyCandidate) => c.type).sort(),
				["anchor", "end_anchor"],
			)
		})

		it("leaves sibling edits unaffected when one anchor fuzzy-fails", () => {
			const lines = ["function f() {", "  return banana()", "  const y = 2", "}"]
			const hashes = ["A", "B", "C", "D"]
			const block: any = {
				params: {
					edits: [
						{
							anchor: `B${D}  return banana();`, // fuzzy
							edit_type: "insert_after",
							text: "  // hi",
						},
						{
							anchor: `C${D}  const y = 2`, // exact
							edit_type: "insert_after",
							text: "  // ok",
						},
					],
				},
			}
			const { resolvedEdits, failedEdits } = exec.resolveEdits([block], lines, hashes)
			assert.equal(resolvedEdits.length, 1)
			assert.equal(resolvedEdits[0].lineIdx, 2)
			assert.equal(failedEdits.length, 1)
			assert.ok(failedEdits[0].fuzzyCandidates)
		})
	})

	describe("resolveFuzzyEdit — promotion after approval", () => {
		it("promotes an insert_after edit when the anchor candidate is approved", () => {
			const lines = ["function f() {", "  return banana()", "}"]
			const hashes = ["A", "B", "C"]
			const normHashes = hashes.map((h) => h.trim())
			const block: any = {
				params: {
					edits: [
						{ anchor: `B${D}  return banana();`, edit_type: "insert_after", text: "  // hi" },
					],
				},
			}
			const { failedEdits } = exec.resolveEdits([block], lines, hashes)
			const failed = failedEdits[0]
			const approved = new Map<"anchor" | "end_anchor", FuzzyCandidate>([
				["anchor", failed.fuzzyCandidates![0]],
			])
			const promoted = exec.resolveFuzzyEdit(failed, approved, normHashes, lines)
			assert.ok(promoted)
			assert.equal(promoted?.lineIdx, 1)
		})

		it("returns null when end_anchor of a replace is not approved", () => {
			const lines = [
				"function start() {",
				"  return banana()",
				"  console.log('done')",
				"}",
			]
			const hashes = ["A", "B", "C", "D"]
			const normHashes = hashes.map((h) => h.trim())
			const block: any = {
				params: {
					edits: [
						{
							anchor: `B${D}  return banana();`,
							end_anchor: `C${D}  console.log('done!')`,
							edit_type: "replace",
							text: "  return apple()",
						},
					],
				},
			}
			const { failedEdits } = exec.resolveEdits([block], lines, hashes)
			const failed = failedEdits[0]
			// Sanity: both sides produced fuzzy candidates.
			assert.equal(failed.fuzzyCandidates?.length, 2)
			// Approve only the start anchor.
			const startCand = failed.fuzzyCandidates!.find((c) => c.type === "anchor")!
			const approved = new Map<"anchor" | "end_anchor", FuzzyCandidate>([["anchor", startCand]])
			const promoted = exec.resolveFuzzyEdit(failed, approved, normHashes, lines)
			assert.equal(promoted, null)
		})
	})
})
