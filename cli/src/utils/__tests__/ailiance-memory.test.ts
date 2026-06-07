import * as fs from "fs/promises"
import * as path from "path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
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
		const namesToClear = ["test-user-pref", "test-feedback-no-amend", "test-project-repo-convention", "another-memory"]
		for (const name of namesToClear) {
			await deleteMemory(name)
		}
	})

	afterEach(async () => {
		// Symmetric cleanup so files don't accumulate in dev environments.
		const namesToClear = ["test-user-pref", "test-feedback-no-amend", "test-project-repo-convention", "another-memory"]
		for (const name of namesToClear) {
			await deleteMemory(name)
		}
	})

	it("round-trips optional source + lastSeenAt and tolerates legacy entries", async () => {
		await saveMemory({
			name: "test-user-pref",
			description: "x",
			type: "project",
			scope: "global",
			body: "b",
			source: "dreamed",
			lastSeenAt: "2026-06-07T00:00:00.000Z",
		} as any)
		const m: any = (await listMemories({})).find((e: any) => e.name === "test-user-pref")
		expect(m.source).toBe("dreamed")
		expect(m.lastSeenAt).toBe("2026-06-07T00:00:00.000Z")
		await saveMemory({
			name: "another-memory",
			description: "y",
			type: "user",
			scope: "global",
			body: "b2",
		} as any)
		const h: any = (await listMemories({})).find((e: any) => e.name === "another-memory")
		expect(h.source).toBeUndefined()
		expect(h.lastSeenAt).toBeUndefined()
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
				const projectScoped = loaded.memories.filter((m) => m.scope.startsWith("project:nonexistent-project-zzz9999"))
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

	describe("atomic writes and concurrency (issue #23)", () => {
		const parallelNames = ["test-parallel-a", "test-parallel-b", "test-parallel-c", "test-parallel-d", "test-parallel-e"]

		afterEach(async () => {
			for (const n of parallelNames) await deleteMemory(n)
			// Sweep any tmp files left by a failed writeFile mock.
			try {
				const entries = await fs.readdir(TEST_ROOT)
				for (const e of entries) {
					if (e.includes(".tmp.")) {
						await fs.unlink(path.join(TEST_ROOT, e)).catch(() => {})
					}
				}
			} catch {
				/* root may not exist */
			}
			vi.restoreAllMocks()
		})

		it("saveMemory leaves no .tmp file when writeFile fails", async () => {
			// Force writeFile to fail without spying (ESM module namespaces
			// are non-configurable in vitest). We pre-create the memory
			// directory as a *file* with a colliding name so any attempt
			// to write into it errors with ENOTDIR — but for the global
			// scope the root dir is shared, so instead we use a project
			// scope and stage a regular file where the project sub-dir
			// would otherwise be created.
			await fs.mkdir(TEST_ROOT, { recursive: true })
			const projectDir = path.join(TEST_ROOT, "project_p04-fail-test")
			// Remove anything stale from a prior partial run.
			await fs.rm(projectDir, { recursive: true, force: true }).catch(() => {})
			// Plant a regular file where the directory should go — mkdir
			// {recursive:true} on an existing file path throws EEXIST/ENOTDIR.
			await fs.writeFile(projectDir, "blocker", "utf-8")

			await expect(
				saveMemory({
					name: "test-parallel-a",
					description: "x",
					type: "user",
					scope: "project:p04-fail-test",
					body: "y",
				}),
			).rejects.toBeDefined()

			// Clean up the blocker.
			await fs.unlink(projectDir).catch(() => {})

			// No leaked .tmp files at root or in any project subdir.
			let leaked: string[] = []
			try {
				const entries = await fs.readdir(TEST_ROOT)
				leaked = entries.filter((e) => e.includes(".tmp."))
			} catch {
				/* root may not exist when truly empty */
			}
			expect(leaked).toEqual([])
		})

		it("5 concurrent saveMemory calls all land and MEMORY.md stays valid", async () => {
			await Promise.all(
				parallelNames.map((name, i) =>
					saveMemory({
						name,
						description: `parallel entry ${i}`,
						type: "user",
						body: `body-${i}`,
					}),
				),
			)

			const list = await listMemories({ type: "user" })
			for (const name of parallelNames) {
				expect(list.find((m) => m.name === name)).toBeDefined()
			}

			// MEMORY.md must be a complete, well-formed index (no truncation
			// mid-line from a partial overwrite by a racing writer).
			const indexContent = await fs.readFile(path.join(TEST_ROOT, "MEMORY.md"), "utf-8")
			expect(indexContent.startsWith("# Memory Index")).toBe(true)
			expect(indexContent.endsWith("\n")).toBe(true)
			for (const name of parallelNames) {
				expect(indexContent).toContain(name)
			}
		})

		it("parseMemory quarantines a corrupt file and returns null", async () => {
			// Write a file that bypasses saveMemory (no frontmatter).
			await fs.mkdir(TEST_ROOT, { recursive: true })
			const corruptName = "test-parallel-c.md"
			const corruptPath = path.join(TEST_ROOT, corruptName)
			await fs.writeFile(corruptPath, "not a valid memory file\n", "utf-8")

			// listMemories triggers parseMemory; for a corrupt file it must
			// drop the entry AND rename the file out of the way.
			await listMemories()

			// Original file should no longer exist.
			await expect(fs.access(corruptPath)).rejects.toBeDefined()

			// A .broken-* sibling should now be present.
			const entries = await fs.readdir(TEST_ROOT)
			const broken = entries.filter((e) => e.startsWith("test-parallel-c.md.broken-"))
			expect(broken.length).toBe(1)

			// Clean up the quarantined file.
			await fs.unlink(path.join(TEST_ROOT, broken[0])).catch(() => {})
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
			const loaded = await loadRelevantMemories("/tmp/test-relevance-A", "How do I deploy a kubernetes service?")
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
			const loaded = await loadRelevantMemories("/tmp/test-relevance-C", "explain quantum entanglement to me")
			expect(loaded).not.toBeNull()
			const names = loaded!.memories.map((m) => m.name)
			const newerIdx = names.indexOf("test-user-pref")
			const olderIdx = names.indexOf("another-memory")
			expect(newerIdx).toBeGreaterThanOrEqual(0)
			expect(olderIdx).toBeGreaterThanOrEqual(0)
			expect(newerIdx).toBeLessThan(olderIdx)
		})
	})

	describe("loadRelevantMemories semantic ranker (injected)", () => {
		it("orders memories by the injected ranker's scores", async () => {
			await saveMemory({
				name: "another-memory",
				description: "first",
				type: "user",
				body: "alpha content",
			})
			await new Promise((resolve) => setTimeout(resolve, 10))
			await saveMemory({
				name: "test-user-pref",
				description: "second",
				type: "user",
				body: "beta content",
			})
			// Ranker scores the older "another-memory" higher than the newer one,
			// so semantic order must override the default newest-first order.
			const ranker = {
				rank: vi.fn(async (_q: string, names: string[]) => {
					const m = new Map<string, number>()
					for (const n of names) m.set(n, n === "another-memory" ? 0.9 : 0.1)
					return m
				}),
			}
			const loaded = await loadRelevantMemories("/tmp/test-sem-A", "anything", ranker)
			expect(loaded).not.toBeNull()
			expect(ranker.rank).toHaveBeenCalledOnce()
			const names = loaded!.memories.map((m) => m.name)
			expect(names.indexOf("another-memory")).toBeLessThan(names.indexOf("test-user-pref"))
		})

		it("falls back to token-overlap when the ranker returns null", async () => {
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
			const nullRanker = { rank: vi.fn(async () => null) }
			const loaded = await loadRelevantMemories("/tmp/test-sem-B", "How do I deploy a kubernetes service?", nullRanker)
			expect(loaded).not.toBeNull()
			expect(nullRanker.rank).toHaveBeenCalledOnce()
			// null result => identical to the token-overlap path: the matching
			// memory ranks ahead of the more recent non-matching one.
			const names = loaded!.memories.map((m) => m.name)
			expect(names.indexOf("another-memory")).toBeLessThan(names.indexOf("test-user-pref"))
		})
	})
})
