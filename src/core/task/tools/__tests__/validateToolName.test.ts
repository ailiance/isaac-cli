import * as assert from "assert"
import { validateToolName } from "../validateToolName"

const KNOWN = new Set([
	"read_file",
	"write_to_file",
	"execute_command",
	"search_files",
	"list_files",
	"edit_file",
	"attempt_completion",
	"ask_followup_question",
])

describe("validateToolName", () => {
	it("accepts a name present in the whitelist", () => {
		const r = validateToolName("read_file", KNOWN)
		assert.strictEqual(r.valid, true)
	})

	it("rejects an empty string", () => {
		const r = validateToolName("", KNOWN)
		assert.strictEqual(r.valid, false)
		if (!r.valid) {
			assert.match(r.reason, /empty/i)
			assert.strictEqual(typeof r.hint, "string")
		}
	})

	it("rejects null / non-string input", () => {
		// biome-ignore lint/suspicious/noExplicitAny: testing runtime guard
		const r = validateToolName(null as any, KNOWN)
		assert.strictEqual(r.valid, false)
		// biome-ignore lint/suspicious/noExplicitAny: testing runtime guard
		const r2 = validateToolName(42 as any, KNOWN)
		assert.strictEqual(r2.valid, false)
	})

	it("rejects names containing ':' with a hint mentioning forbidden characters", () => {
		const r = validateToolName("digikey:search", KNOWN)
		assert.strictEqual(r.valid, false)
		if (!r.valid) {
			assert.match(r.reason, /forbidden|':'|\.'/)
			assert.match(r.hint, /cannot contain/i)
			assert.match(r.hint, /read_file/)
		}
	})

	it("rejects names containing '.' with a forbidden-character hint", () => {
		const r = validateToolName("kicad.new_project", KNOWN)
		assert.strictEqual(r.valid, false)
		if (!r.valid) {
			assert.match(r.reason, /forbidden/)
			assert.match(r.hint, /cannot contain/i)
		}
	})

	it("rejects valid-shape but unknown names with a known-tool hint", () => {
		const r = validateToolName("oscilloscope", KNOWN)
		assert.strictEqual(r.valid, false)
		if (!r.valid) {
			assert.match(r.reason, /not a known tool/)
			// Hint should suggest some real tools to recover from.
			assert.match(r.hint, /read_file/)
		}
	})

	it("forbidden-char rule fires before unknown-name rule", () => {
		// `bom:search` is both forbidden-char AND unknown — we want the
		// shape error first because the hint is more actionable.
		const r = validateToolName("bom:search", KNOWN)
		assert.strictEqual(r.valid, false)
		if (!r.valid) {
			assert.match(r.reason, /forbidden/)
		}
	})
})
