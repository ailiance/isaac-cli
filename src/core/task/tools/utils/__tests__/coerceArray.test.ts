import { describe, it } from "mocha"
import "should"
import { coerceFirstStringArray, coerceToStringArray } from "../coerceArray"

describe("coerceToStringArray", () => {
	it("passes through real arrays, stringifying members", () => {
		coerceToStringArray(["README.md", "src/index.ts"]).should.deepEqual(["README.md", "src/index.ts"])
		coerceToStringArray([1, 2]).should.deepEqual(["1", "2"])
	})

	it("parses a JSON-stringified array back into a real array", () => {
		coerceToStringArray('["README.md"]').should.deepEqual(["README.md"])
		coerceToStringArray('["ls -la"]').should.deepEqual(["ls -la"])
		coerceToStringArray('["."]').should.deepEqual(["."])
		coerceToStringArray('["a", "b", "c"]').should.deepEqual(["a", "b", "c"])
	})

	it("tolerates surrounding whitespace around a stringified array", () => {
		coerceToStringArray('  ["README.md"]  ').should.deepEqual(["README.md"])
	})

	it("wraps a plain (non-bracketed) string as a single-element array", () => {
		coerceToStringArray("README.md").should.deepEqual(["README.md"])
		coerceToStringArray("ls -la").should.deepEqual(["ls -la"])
	})

	it("treats a bracketed-but-invalid-JSON string as a single value", () => {
		coerceToStringArray("[not json]").should.deepEqual(["[not json]"])
	})

	it("returns an empty array for empty / whitespace strings and nullish values", () => {
		coerceToStringArray("").should.deepEqual([])
		coerceToStringArray("   ").should.deepEqual([])
		coerceToStringArray(undefined).should.deepEqual([])
		coerceToStringArray(null).should.deepEqual([])
	})

	it("returns an empty array for a stringified empty array", () => {
		coerceToStringArray("[]").should.deepEqual([])
	})
})

describe("coerceFirstStringArray", () => {
	it("returns the first non-empty candidate", () => {
		coerceFirstStringArray(["a", "b"], "ignored").should.deepEqual(["a", "b"])
		coerceFirstStringArray(undefined, "fallback").should.deepEqual(["fallback"])
		coerceFirstStringArray(null, ["x"]).should.deepEqual(["x"])
	})

	it("preserves a singular fallback when the plural form is absent", () => {
		// plural `paths` undefined, singular `path` provided
		coerceFirstStringArray(undefined, "src/index.ts").should.deepEqual(["src/index.ts"])
	})

	it("parses a stringified array in any candidate position", () => {
		coerceFirstStringArray('["a"]', "b").should.deepEqual(["a"])
		coerceFirstStringArray("", '["b"]').should.deepEqual(["b"])
	})

	it("skips empty candidates", () => {
		coerceFirstStringArray("", "   ", [], "real").should.deepEqual(["real"])
	})

	it("returns an empty array when all candidates are empty", () => {
		coerceFirstStringArray(undefined, null, "", []).should.deepEqual([])
	})
})
