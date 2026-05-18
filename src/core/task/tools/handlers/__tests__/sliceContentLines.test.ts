import { expect } from "chai"
import { sliceContentLines } from "../readFilePagination"

/**
 * Unit coverage for the pure pagination slicer extracted from
 * ReadFileToolHandler. Exercises both pagination styles, their bounds
 * clamping, and the no-pagination passthrough — without touching the
 * filesystem or the handler's dependency graph.
 *
 * The end-to-end handler behaviour is covered separately in
 * ReadFileToolHandler.pagination.test.ts.
 */
describe("sliceContentLines — read_file pagination", () => {
	const content = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join("\n")

	it("returns the content unchanged when no pagination params are given", () => {
		expect(sliceContentLines(content, {})).to.equal(content)
	})

	it("slices a 1-based inclusive line range", () => {
		// start_line=3, end_line=5 → line3, line4, line5
		expect(sliceContentLines(content, { startLineNum: 3, endLineNum: 5 })).to.equal("line3\nline4\nline5")
	})

	it("treats a line range with only start_line as running to the end", () => {
		expect(sliceContentLines(content, { startLineNum: 8 })).to.equal("line8\nline9\nline10")
	})

	it("treats a line range with only end_line as running from the start", () => {
		expect(sliceContentLines(content, { endLineNum: 2 })).to.equal("line1\nline2")
	})

	it("slices a 0-based offset/limit window", () => {
		// offset=5, limit=3 → line6, line7, line8
		expect(sliceContentLines(content, { offsetNum: 5, limitNum: 3 })).to.equal("line6\nline7\nline8")
	})

	it("treats offset without limit as running to the end", () => {
		expect(sliceContentLines(content, { offsetNum: 7 })).to.equal("line8\nline9\nline10")
	})

	it("clamps an offset past the end of the file to an empty slice", () => {
		expect(sliceContentLines(content, { offsetNum: 100, limitNum: 10 })).to.equal("")
	})

	it("clamps a limit that overruns the file to the available lines", () => {
		expect(sliceContentLines(content, { offsetNum: 8, limitNum: 999 })).to.equal("line9\nline10")
	})

	it("clamps a negative offset to the start of the file", () => {
		expect(sliceContentLines(content, { offsetNum: -5, limitNum: 2 })).to.equal("line1\nline2")
	})

	it("prefers the line range when both pagination styles are present", () => {
		// Mutual-exclusion is enforced upstream in the handler; the slicer
		// itself deterministically falls back to the line range.
		const result = sliceContentLines(content, { startLineNum: 1, endLineNum: 2, offsetNum: 5, limitNum: 3 })
		expect(result).to.equal("line1\nline2")
	})
})
