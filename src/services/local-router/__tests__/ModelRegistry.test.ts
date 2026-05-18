import * as assert from "assert"
import { getToolProfile, listKnownPatterns } from "../ModelRegistry"

describe("ModelRegistry", () => {
	it("maps gemma-3-4b-it to markdown_fence non-native", () => {
		const p = getToolProfile("gemma-3-4b-it")
		assert.strictEqual(p.format, "markdown_fence")
		assert.strictEqual(p.isNative, false)
	})

	it("maps claude-opus-4-7 to anthropic_native", () => {
		const p = getToolProfile("claude-opus-4-7")
		assert.strictEqual(p.format, "anthropic_native")
		assert.strictEqual(p.isNative, true)
	})

	it("matches case-insensitively for Devstral-Small-2505", () => {
		const p = getToolProfile("Devstral-Small-2505")
		assert.strictEqual(p.format, "xml")
		assert.strictEqual(p.isNative, false)
	})

	it("maps eurollm-22b to openai_native", () => {
		const p = getToolProfile("eurollm-22b")
		assert.strictEqual(p.format, "openai_native")
		assert.strictEqual(p.isNative, true)
	})

	it("maps mistral-medium-3.5-128b to openai_native (special case)", () => {
		const p = getToolProfile("mistral-medium-3.5-128b")
		assert.strictEqual(p.format, "openai_native")
		assert.strictEqual(p.isNative, true)
	})

	it("maps generic mistral-7b to json_inline non-native", () => {
		const p = getToolProfile("mistral-7b-instruct")
		assert.strictEqual(p.format, "json_inline")
		assert.strictEqual(p.isNative, false)
	})

	it("maps qwen3-next-80b to xml non-native", () => {
		const p = getToolProfile("qwen3-next-80b")
		assert.strictEqual(p.format, "xml")
		assert.strictEqual(p.isNative, false)
	})

	it("maps gpt-4o to openai_native", () => {
		const p = getToolProfile("gpt-4o")
		assert.strictEqual(p.format, "openai_native")
		assert.strictEqual(p.isNative, true)
	})

	it("maps deepseek-v3 to openai_native", () => {
		const p = getToolProfile("deepseek-v3")
		assert.strictEqual(p.format, "openai_native")
		assert.strictEqual(p.isNative, true)
	})

	it("maps llama-3.3-70b to markdown_fence non-native", () => {
		const p = getToolProfile("llama-3.3-70b")
		assert.strictEqual(p.format, "markdown_fence")
		assert.strictEqual(p.isNative, false)
	})

	it("maps apertus-70b to markdown_fence non-native", () => {
		const p = getToolProfile("apertus-70b")
		assert.strictEqual(p.format, "markdown_fence")
		assert.strictEqual(p.isNative, false)
	})

	it("falls back to markdown_fence non-native for unknown models", () => {
		const p = getToolProfile("unknown-model-xyz")
		assert.strictEqual(p.format, "markdown_fence")
		assert.strictEqual(p.isNative, false)
	})

	it("listKnownPatterns returns all registered patterns", () => {
		const all = listKnownPatterns()
		assert.ok(all.length >= 10, `expected >= 10 patterns, got ${all.length}`)
		const patterns = all.map((e) => e.pattern)
		for (const expected of ["gpt-", "claude", "gemma", "devstral", "eurollm", "mistral-medium", "mistral", "qwen"]) {
			assert.ok(patterns.includes(expected), `missing pattern ${expected}`)
		}
	})

	it("mistral-medium is matched before generic mistral (specificity order)", () => {
		// If ordering breaks, mistral-medium would resolve to json_inline.
		const p = getToolProfile("mistral-medium-2502")
		assert.strictEqual(p.format, "openai_native")
	})
})
