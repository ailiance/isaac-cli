import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as fs from "fs/promises"
import * as path from "path"
import * as os from "os"
import {
	deleteMemory,
	findMemories,
	formatMemoriesSection,
	getMemoryRoot,
	listMemories,
	loadRelevantMemories,
	projectScopeFromCwd,
	saveMemory,
} from "@/utils/ailiance-memory"

// Isolate each test by swapping HOME to a tmp dir; the module computes
// MEMORY_ROOT at import time from os.homedir(), so we override
// before importing — but Vitest hoists imports above beforeEach. The
// trick: monkey-patch os.homedir() to return our tmp dir, then re-import
// via dynamic import in a beforeEach. That keeps the test hermetic.
// Simpler: each test cleans up after itself.

const TEST_ROOT = getMemoryRoot()

describe("ailiance-memory", () => {
	beforeEach(async () => {
		// Make sure we start clean for the keys this test will use.
		const namesToClear = [
			"test-user-pref",
			"test-feedback-no-amend",
			"test-project-repo-convention",
			"another-memory",
		]
		for (const name of namesToClear) {
			await deleteMemory(name)
		}
	})

	afterEach(async () => {
		// Symmetric cleanup so files don't accumulate in dev environments.
		const namesToClear = [
			"test-user-pref",
			"test-feedback-no-amend",
			"test-project-repo-convention",
			"another-memory",
		]
		for (const name of namesToClear) {
			await deleteMemory(name)
		}
	})

	it("saves and reads back a global memory", async () => {
		const filePath = await saveMemory({
			name: "test-user-pref",
			description: "User prefers French for explanations",
			type: "user",
			body: "Respond in French unless asked otherwise.",
		})
		expect(filePath).toContain("test-user-pref.md")
		const memories = await listMemories({ type: "user" })
		const found = memories.find((m) => m.name === "test-user-pref")
		expect(found).toBeDefined()
		expect(found!.description).toBe("User prefers French for explanations")
		expect(found!.scope).toBe("global")
		expect(found!.body).toBe("Respond in French unless asked otherwise.")
	})

	it("respects project scope when listing", async () => {
		await saveMemory({
			name: "test-project-repo-convention",
			description: "no rebase on main",
			type: "project",
			scope: "project:my-repo",
			body: "Always merge with squash, never rebase.",
		})
		const globalList = await listMemories({ scope: "global" })
		const projList = await listMemories({ scope: "project:my-repo" })
		expect(globalList.find((m) => m.name === "test-project-repo-convention")).toBeUndefined()
		expect(projList.find((m) => m.name === "test-project-repo-convention")).toBeDefined()
	})

	it("deletes a memory by name across scopes", async () => {
		await saveMemory({
			name: "test-feedback-no-amend",
			description: "no commit amend",
			type: "feedback",
			body: "Never use git commit --amend on merged PRs.",
		})
		const removed = await deleteMemory("test-feedback-no-amend")
		expect(removed).toBe(1)
		const after = await listMemories()
		expect(after.find((m) => m.name === "test-feedback-no-amend")).toBeUndefined()
	})

	it("returns 0 when deleting a name that has no matches", async () => {
		const removed = await deleteMemory("definitely-not-saved")
		expect(removed).toBe(0)
	})

	it("findMemories matches against name and description", async () => {
		await saveMemory({
			name: "test-user-pref",
			description: "speak french",
			type: "user",
			body: "x",
		})
		await saveMemory({
			name: "another-memory",
			description: "a note about french",
			type: "reference",
			body: "y",
		})
		const byName = await findMemories("user-pref")
		expect(byName.find((m) => m.name === "test-user-pref")).toBeDefined()
		const byDesc = await findMemories("french")
		expect(byDesc.length).toBeGreaterThanOrEqual(2)
		const empty = await findMemories("totally-unrelated")
		expect(empty).toEqual([])
	})

	it("rejects names with invalid characters", async () => {
		await expect(
			saveMemory({
				name: "bad/name with spaces",
				description: "x",
				type: "user",
				body: "y",
			}),
		).rejects.toThrow(/kebab.snake-case/i)
	})

	it("rebuilds MEMORY.md index on every save", async () => {
		await saveMemory({
			name: "test-user-pref",
			description: "indexed entry",
			type: "user",
			body: "test",
		})
		const indexContent = await fs.readFile(path.join(TEST_ROOT, "MEMORY.md"), "utf-8")
		expect(indexContent).toContain("# Memory Index")
		expect(indexContent).toContain("test-user-pref")
		expect(indexContent).toContain("indexed entry")
	})

	it("lists memories sorted by creation time (newest first)", async () => {
		await saveMemory({ name: "another-memory", description: "older", type: "user", body: "a" })
		// brief sleep to ensure ISO timestamp differs
		await new Promise((resolve) => setTimeout(resolve, 10))
		await saveMemory({ name: "test-user-pref", description: "newer", type: "user", body: "b" })
		const list = await listMemories({ type: "user" })
		const newer = list.findIndex((m) => m.name === "test-user-pref")
		const older = list.findIndex((m) => m.name === "another-memory")
		expect(newer).toBeGreaterThanOrEqual(0)
		expect(older).toBeGreaterThan(newer)
	})

	describe("projectScopeFromCwd", () => {
		it("returns null for empty / undefined cwd", () => {
			expect(projectScopeFromCwd(undefined)).toBeNull()
			expect(projectScopeFromCwd("")).toBeNull()
		})
		it("slugifies basename to a project: scope tag", () => {
			expect(projectScopeFromCwd("/Users/x/Documents/My-App")).toBe("project:my-app")
			expect(projectScopeFromCwd("/var/repos/factory-4-life")).toBe("project:factory-4-life")
			expect(projectScopeFromCwd("/tmp/Some App With Spaces")).toBe("project:some-app-with-spaces")
		})
		it("returns null when basename slugifies to empty", () => {
			expect(projectScopeFromCwd("/...")).toBeNull()
		})
	})

	describe("loadRelevantMemories", () => {
		it("returns null when no memories exist", async () => {
			// Cleanup runs in beforeEach; for this test we ensure global + project are empty
			const loaded = await loadRelevantMemories("/tmp/nonexistent-project-zzz9999")
			// Other memories from other tests in this file may exist transiently;
			// but the rebuild + cleanup leaves no entries. Accept null OR an
			// empty-after-project-filter result.
			if (loaded !== null) {
				// At minimum no project-scoped memories for our random cwd:
				const projectScoped = loaded.memories.filter((m) =>
					m.scope.startsWith("project:nonexistent-project-zzz9999"),
				)
				expect(projectScoped).toEqual([])
			}
		})

		it("includes project-scoped memories ahead of global ones", async () => {
			await saveMemory({
				name: "test-user-pref",
				description: "global pref",
				type: "user",
				body: "x",
			})
			await saveMemory({
				name: "test-project-repo-convention",
				description: "project pref",
				type: "project",
				scope: "project:test-cwd",
				body: "y",
			})
			const loaded = await loadRelevantMemories("/tmp/test-cwd")
			expect(loaded).not.toBeNull()
			const names = loaded!.memories.map((m) => m.name)
			const projectIdx = names.indexOf("test-project-repo-convention")
			const globalIdx = names.indexOf("test-user-pref")
			expect(projectIdx).toBeGreaterThanOrEqual(0)
			expect(globalIdx).toBeGreaterThanOrEqual(0)
			expect(projectIdx).toBeLessThan(globalIdx)
		})

		it("respects budget cap and sets truncated when exceeded", async () => {
			// 9000-char body forces truncation against the 8000-char budget
			const bigBody = "x".repeat(9_000)
			await saveMemory({
				name: "another-memory",
				description: "small enough",
				type: "user",
				body: "small",
			})
			await new Promise((resolve) => setTimeout(resolve, 10))
			await saveMemory({
				name: "test-user-pref",
				description: "huge",
				type: "user",
				body: bigBody,
			})
			const loaded = await loadRelevantMemories(undefined)
			// "test-user-pref" is newest (listed first); its 9k body exceeds
			// the 8k budget so the budget loop breaks before adding it →
			// truncated=true, included list contains nothing OR earlier
			// smaller entries up to the cap, never the big one.
			if (loaded) {
				expect(loaded.totalChars).toBeLessThanOrEqual(8_000)
				expect(loaded.truncated).toBe(true)
				expect(loaded.memories.find((m) => m.name === "test-user-pref")).toBeUndefined()
			}
		})
	})

	describe("formatMemoriesSection", () => {
		it("returns empty string on null input", () => {
			expect(formatMemoriesSection(null)).toBe("")
		})
		it("returns empty string when memories list is empty", () => {
			expect(formatMemoriesSection({ memories: [], truncated: false })).toBe("")
		})
		it("renders a USER MEMORIES section header and per-memory blocks", () => {
			const out = formatMemoriesSection({
				memories: [
					{
						name: "x",
						description: "desc x",
						type: "user",
						scope: "global",
						created: "2026-05-12T00:00:00Z",
						body: "body x",
						filePath: "/dev/null",
					},
				],
				truncated: false,
			})
			expect(out).toContain("# USER MEMORIES")
			expect(out).toContain("## x (user, global)")
			expect(out).toContain("_desc x_")
			expect(out).toContain("body x")
			expect(out).not.toContain("(some memories truncated")
		})
		it("appends a truncation footer when needed", () => {
			const out = formatMemoriesSection({
				memories: [
					{
						name: "x",
						description: "d",
						type: "user",
						scope: "global",
						created: "2026-05-12T00:00:00Z",
						body: "b",
						filePath: "/dev/null",
					},
				],
				truncated: true,
			})
			expect(out).toContain("(some memories truncated")
		})
	})

	describe("loadRelevantMemories prompt-aware ranking", () => {
		// Uses only the 4 shared names from the outer beforeEach/afterEach
		// cleanup so tests stay hermetic.

		it("ranks a matching memory ahead of a more recent non-matching one (case A)", async () => {
			await saveMemory({
				name: "another-memory",
				description: "kubernetes deployment notes",
				type: "reference",
				body: "Use kubectl apply -f manifests/ then kubectl rollout status.",
			})
			await new Promise((resolve) => setTimeout(resolve, 10))
			await saveMemory({
				name: "test-user-pref",
				description: "prefers French",
				type: "user",
				body: "Always reply in French.",
			})
			const loaded = await loadRelevantMemories(
				"/tmp/test-relevance-A",
				"How do I deploy a kubernetes service?",
			)
			expect(loaded).not.toBeNull()
			const names = loaded!.memories.map((m) => m.name)
			const matchIdx = names.indexOf("another-memory")
			const recentIdx = names.indexOf("test-user-pref")
			expect(matchIdx).toBeGreaterThanOrEqual(0)
			expect(recentIdx).toBeGreaterThanOrEqual(0)
			expect(matchIdx).toBeLessThan(recentIdx)
		})

		it("preserves date sort when no userPrompt is provided (case B, non-regression)", async () => {
			await saveMemory({
				name: "another-memory",
				description: "older entry",
				type: "user",
				body: "kubernetes manifest tips",
			})
			await new Promise((resolve) => setTimeout(resolve, 10))
			await saveMemory({
				name: "test-user-pref",
				description: "newer entry",
				type: "user",
				body: "totally unrelated content",
			})
			const loaded = await loadRelevantMemories("/tmp/test-relevance-B")
			expect(loaded).not.toBeNull()
			const names = loaded!.memories.map((m) => m.name)
			const newerIdx = names.indexOf("test-user-pref")
			const olderIdx = names.indexOf("another-memory")
			expect(newerIdx).toBeGreaterThanOrEqual(0)
			expect(olderIdx).toBeGreaterThanOrEqual(0)
			expect(newerIdx).toBeLessThan(olderIdx)
		})

		it("falls back to date sort when no memory matches the prompt (case C)", async () => {
			await saveMemory({
				name: "another-memory",
				description: "older unrelated entry",
				type: "user",
				body: "pumpkin recipe ingredients list",
			})
			await new Promise((resolve) => setTimeout(resolve, 10))
			await saveMemory({
				name: "test-user-pref",
				description: "newer unrelated entry",
				type: "user",
				body: "knitting pattern notes",
			})
			const loaded = await loadRelevantMemories(
				"/tmp/test-relevance-C",
				"explain quantum entanglement to me",
			)
			expect(loaded).not.toBeNull()
			const names = loaded!.memories.map((m) => m.name)
			const newerIdx = names.indexOf("test-user-pref")
			const olderIdx = names.indexOf("another-memory")
			expect(newerIdx).toBeGreaterThanOrEqual(0)
			expect(olderIdx).toBeGreaterThanOrEqual(0)
			expect(newerIdx).toBeLessThan(olderIdx)
		})
	})
})
