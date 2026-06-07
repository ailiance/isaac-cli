// src/services/memory/dreaming/__tests__/wireExpireScope.test.ts
//
// Regression for scope-aware TTL expiry. The expire hook in buildDreamDeps()
// must only delete the stale memory matching BOTH name and scope - a fresh
// memory sharing the same name in a different scope must survive. Exercises the
// real memory store (saveMemory is not injectable) then cleans up.
import { strict as assert } from "node:assert"
import { afterEach, describe, it } from "mocha"
import { deleteMemory, listMemories, saveMemory } from "@/utils/ailiance-memory"
// Two standalone relative `import type` statements keep ts-node resolving this
// spec via the CJS require chain (so the @/ alias resolves via tsconfig-paths);
// the sibling wireIndexOnSave test relies on the same import shape. Dropping
// them flips the file to Node's ESM loader, which ignores tsconfig-paths.
import type { DreamDeps } from "../DreamWorker"
import { MEMORY_TTL_DAYS } from "../decay"
import type { MemoryCandidate } from "../types"
import { buildDreamDeps } from "../wire"

const NAME: MemoryCandidate["name"] = "wire-expire-scope-test-mem"
const FRESH_SCOPE = "project:wire-expire-scope-test-repo"

describe("buildDreamDeps expire: scope-aware TTL sweep", () => {
	afterEach(async () => {
		await deleteMemory(NAME)
	})

	const noopApi = () => ({}) as any
	const mode = () => "act" as any

	it("deletes only the stale scope, keeping a fresh same-name memory in another scope", async () => {
		const staleAt = new Date(Date.now() - (MEMORY_TTL_DAYS + 5) * 86_400_000).toISOString()
		const freshAt = new Date().toISOString()
		// Same name, two scopes: global is stale, project is fresh.
		await saveMemory({
			name: NAME,
			description: "stale global",
			type: "user",
			scope: "global",
			body: "g",
			lastSeenAt: staleAt,
		})
		await saveMemory({
			name: NAME,
			description: "fresh project",
			type: "project",
			scope: FRESH_SCOPE,
			body: "p",
			lastSeenAt: freshAt,
		})

		const deps: DreamDeps = buildDreamDeps(noopApi, mode, [])
		await deps.expire?.()

		const after = (await listMemories({})).filter((m) => m.name === NAME)
		assert.equal(after.length, 1, "the fresh project memory must survive the sweep")
		assert.equal(after[0].scope, FRESH_SCOPE)
	})
})
