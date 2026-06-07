// src/services/memory/dreaming/__tests__/decay.test.ts
import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import { isStale, MEMORY_TTL_DAYS } from "../decay"

describe("isStale", () => {
	const now = Date.parse("2026-06-07T00:00:00.000Z")
	const daysAgo = (d: number) => new Date(now - d * 86_400_000).toISOString()

	it("old memory (> TTL) -> true", () => {
		assert.equal(isStale({ lastSeenAt: daysAgo(MEMORY_TTL_DAYS + 1) }, MEMORY_TTL_DAYS, now), true)
	})
	it("fresh memory (< TTL) -> false", () => {
		assert.equal(isStale({ lastSeenAt: daysAgo(1) }, MEMORY_TTL_DAYS, now), false)
	})
	it("falls back to created when lastSeenAt absent", () => {
		assert.equal(isStale({ created: daysAgo(MEMORY_TTL_DAYS + 5) }, MEMORY_TTL_DAYS, now), true)
		assert.equal(isStale({ created: daysAgo(2) }, MEMORY_TTL_DAYS, now), false)
	})
	it("unparseable timestamp -> false (never delete)", () => {
		assert.equal(isStale({ lastSeenAt: "not-a-date" }, MEMORY_TTL_DAYS, now), false)
		assert.equal(isStale({}, MEMORY_TTL_DAYS, now), false)
	})
})
