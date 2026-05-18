import { render } from "ink-testing-library"
import React from "react"
import { describe, expect, it } from "vitest"
import { DiffView } from "./DiffView"

describe("DiffView header", () => {
	it("renders +/- summary header for a SEARCH/REPLACE diff", () => {
		const content = [
			"------- SEARCH",
			"old line",
			"=======",
			"new line",
			"+++++++ REPLACE",
		].join("\n")

		const { lastFrame } = render(React.createElement(DiffView, { content }))
		const frame = lastFrame() || ""

		expect(frame).toContain("+1 line")
		expect(frame).toContain("-1 line")
	})

	it("uses plural for multi-line additions/deletions", () => {
		const content = [
			"------- SEARCH",
			"a",
			"b",
			"=======",
			"x",
			"y",
			"z",
			"+++++++ REPLACE",
		].join("\n")

		const { lastFrame } = render(React.createElement(DiffView, { content }))
		const frame = lastFrame() || ""

		expect(frame).toContain("+3 lines")
		expect(frame).toContain("-2 lines")
	})

	it("returns null for empty content", () => {
		const { lastFrame } = render(React.createElement(DiffView, { content: "" }))
		expect(lastFrame() || "").toBe("")
	})
})
