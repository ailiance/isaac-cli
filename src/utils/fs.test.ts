import * as fs from "fs/promises"
import { after, describe, it } from "mocha"
import * as os from "os"
import * as path from "path"
import "should"
import {
	atomicWriteFile,
	createDirectoriesForFile,
	ensureParentDirectory,
	fileExistsAtPath,
	isDirectory,
	MKDIR_MAX_DEPTH,
	readDirectory,
} from "./fs"

describe("Filesystem Utilities", () => {
	const tmpDir = path.join(os.tmpdir(), "dirac-test-" + Math.random().toString(36).slice(2))

	// Clean up after tests
	after(async () => {
		try {
			await fs.rm(tmpDir, { recursive: true, force: true })
		} catch {
			// Ignore cleanup errors
		}
	})

	describe("fileExistsAtPath", () => {
		it("should return true for existing paths", async () => {
			await fs.mkdir(tmpDir, { recursive: true })
			const testFile = path.join(tmpDir, "test.txt")
			await fs.writeFile(testFile, "test")

			const exists = await fileExistsAtPath(testFile)
			exists.should.be.true()
		})

		it("should return false for non-existing paths", async () => {
			const nonExistentPath = path.join(tmpDir, "does-not-exist.txt")
			const exists = await fileExistsAtPath(nonExistentPath)
			exists.should.be.false()
		})
	})

	describe("createDirectoriesForFile", () => {
		it("should create all necessary directories", async () => {
			const deepPath = path.join(tmpDir, "deep", "nested", "dir", "file.txt")
			const createdDirs = await createDirectoriesForFile(deepPath)

			// Verify directories were created
			createdDirs.length.should.be.greaterThan(0)
			for (const dir of createdDirs) {
				const exists = await fileExistsAtPath(dir)
				exists.should.be.true()
			}
		})

		it("should handle existing directories", async () => {
			const existingDir = path.join(tmpDir, "existing")
			await fs.mkdir(existingDir, { recursive: true })

			const filePath = path.join(existingDir, "file.txt")
			const createdDirs = await createDirectoriesForFile(filePath)

			// Should not create any new directories
			createdDirs.length.should.equal(0)
		})

		it("should normalize paths", async () => {
			const unnormalizedPath = path.join(tmpDir, "a", "..", "b", ".", "file.txt")
			const createdDirs = await createDirectoriesForFile(unnormalizedPath)

			// Should create only the necessary directory
			createdDirs.length.should.equal(1)
			const exists = await fileExistsAtPath(path.join(tmpDir, "b"))
			exists.should.be.true()
		})
	})
	describe("isDirectory", () => {
		it("should return true for directories", async () => {
			await fs.mkdir(tmpDir, { recursive: true })
			const isDir = await isDirectory(tmpDir)
			isDir.should.be.true()
		})

		it("should return false for files", async () => {
			const testFile = path.join(tmpDir, "test.txt")
			await fs.writeFile(testFile, "test")
			const isDir = await isDirectory(testFile)
			isDir.should.be.false()
		})

		it("should return false for non-existent paths", async () => {
			const nonExistentPath = path.join(tmpDir, "does-not-exist")
			const isDir = await isDirectory(nonExistentPath)
			isDir.should.be.false()
		})
	})

	describe("readDirectory", () => {
		it("should list files in a directory", async () => {
			// Create test directory with files
			const testDir = path.join(tmpDir, "read-test")
			await fs.mkdir(testDir, { recursive: true })
			await fs.writeFile(path.join(testDir, "file1.txt"), "content")
			await fs.writeFile(path.join(testDir, "file2.txt"), "content")

			// Get files
			const files = await readDirectory(testDir)
			files.length.should.equal(2)
			files.should.containDeep([path.resolve(testDir, "file1.txt"), path.resolve(testDir, "file2.txt")])
		})

		it("should exclude specified directories", async () => {
			// Create test directory with files and an excluded directory
			const testDir = path.join(tmpDir, "exclude-test")
			const excludeDir = path.join(testDir, "exclude-me")
			await fs.mkdir(excludeDir, { recursive: true })
			await fs.writeFile(path.join(testDir, "include.txt"), "content")
			await fs.writeFile(path.join(excludeDir, "excluded.txt"), "content")

			// Get files, excluding the "exclude-me" directory
			const files = await readDirectory(testDir, [["exclude-me"]])
			files.length.should.equal(1)
			files.should.containDeep([path.resolve(testDir, "include.txt")])
			files.should.not.containDeep([path.resolve(excludeDir, "excluded.txt")])
		})
	})

	it("should correctly handle complex nested directory structures", async () => {
		// Create a complex directory structure
		const complexDir = path.join(tmpDir, "complex-test")

		// Create main dir
		await fs.mkdir(complexDir, { recursive: true })
		await fs.writeFile(path.join(complexDir, "root.txt"), "content")

		// Create first branch
		await fs.mkdir(path.join(complexDir, "dir1"), { recursive: true })
		await fs.writeFile(path.join(complexDir, "dir1", "file1.txt"), "content")

		// Create second branch with nested structure
		await fs.mkdir(path.join(complexDir, "dir2", "subdir1"), { recursive: true })
		await fs.writeFile(path.join(complexDir, "dir2", "file2.txt"), "content")
		await fs.writeFile(path.join(complexDir, "dir2", "subdir1", "file3.txt"), "content")

		// Create third branch with deep nesting
		await fs.mkdir(path.join(complexDir, "dir3", "subdir2", "deepdir"), { recursive: true })
		await fs.writeFile(path.join(complexDir, "dir3", "file4.txt"), "content")
		await fs.writeFile(path.join(complexDir, "dir3", "subdir2", "file5.txt"), "content")
		await fs.writeFile(path.join(complexDir, "dir3", "subdir2", "deepdir", "file6.txt"), "content")

		// Get all files
		const files = await readDirectory(complexDir)

		const expectedFiles = [
			path.resolve(complexDir, "root.txt"),
			path.resolve(complexDir, "dir1", "file1.txt"),
			path.resolve(complexDir, "dir2", "file2.txt"),
			path.resolve(complexDir, "dir2", "subdir1", "file3.txt"),
			path.resolve(complexDir, "dir3", "file4.txt"),
			path.resolve(complexDir, "dir3", "subdir2", "file5.txt"),
			path.resolve(complexDir, "dir3", "subdir2", "deepdir", "file6.txt"),
		]

		files.length.should.equal(expectedFiles.length)

		files.sort().should.deepEqual(expectedFiles.sort())
	})

	it("should correctly exclude multiple directories in complex structures", async () => {
		// Use the same complex directory structure
		const complexDir = path.join(tmpDir, "complex-exclude-test")

		// Create main dir
		await fs.mkdir(complexDir, { recursive: true })
		await fs.writeFile(path.join(complexDir, "root.txt"), "content")

		// Create first branch
		await fs.mkdir(path.join(complexDir, "dir1"), { recursive: true })
		await fs.writeFile(path.join(complexDir, "dir1", "file1.txt"), "content")

		// Create second branch with nested structure
		await fs.mkdir(path.join(complexDir, "dir2", "subdir1"), { recursive: true })
		await fs.writeFile(path.join(complexDir, "dir2", "file2.txt"), "content")
		await fs.writeFile(path.join(complexDir, "dir2", "subdir1", "file3.txt"), "content")

		// Create third branch with deep nesting
		await fs.mkdir(path.join(complexDir, "dir3", "subdir2", "deepdir"), { recursive: true })
		await fs.writeFile(path.join(complexDir, "dir3", "file4.txt"), "content")
		await fs.writeFile(path.join(complexDir, "dir3", "subdir2", "file5.txt"), "content")
		await fs.writeFile(path.join(complexDir, "dir3", "subdir2", "deepdir", "file6.txt"), "content")

		// Get files excluding multiple directories
		const files = await readDirectory(complexDir, [["dir1"], ["subdir2"]])

		const expectedFiles = [
			path.resolve(complexDir, "root.txt"),
			path.resolve(complexDir, "dir2", "file2.txt"),
			path.resolve(complexDir, "dir2", "subdir1", "file3.txt"),
			path.resolve(complexDir, "dir3", "file4.txt"),
		]

		files.length.should.equal(expectedFiles.length)

		files.sort().should.deepEqual(expectedFiles.sort())
	})

	it("should exclude .diracrules/workflows directory specifically", async () => {
		// Create a test directory structure
		const diracrulesDirTest = path.join(tmpDir, "diracrules-test")
		const diracrulesDirPath = path.join(diracrulesDirTest, ".diracrules")

		// Create .diracrules directory and root files
		await fs.mkdir(diracrulesDirPath, { recursive: true })
		await fs.writeFile(path.join(diracrulesDirPath, "config.json"), "{}")
		await fs.writeFile(path.join(diracrulesDirPath, "settings.js"), "// settings")

		// Create .diracrules/other directory and files
		const otherDirPath = path.join(diracrulesDirPath, "other")
		await fs.mkdir(otherDirPath, { recursive: true })
		await fs.writeFile(path.join(otherDirPath, "helper.js"), "// helper code")
		await fs.writeFile(path.join(otherDirPath, "util.js"), "// util functions")

		// Create .diracrules/workflows directory and files
		const workflowsDirPath = path.join(diracrulesDirPath, "workflows")
		await fs.mkdir(workflowsDirPath, { recursive: true })
		await fs.writeFile(path.join(workflowsDirPath, "workflow1.js"), "// workflow1")
		await fs.writeFile(path.join(workflowsDirPath, "workflow2.js"), "// workflow2")

		// Get all files WITHOUT exclusion
		const allFiles = await readDirectory(diracrulesDirPath)

		// Verify all files are included
		allFiles.length.should.equal(6) // 2 in root + 2 in other + 2 in workflows
		allFiles.some((file) => file.includes("workflow1.js")).should.be.true()
		allFiles.some((file) => file.includes("workflow2.js")).should.be.true()

		// Get files WITH workflows directory excluded
		const filteredFiles = await readDirectory(diracrulesDirPath, [[".diracrules", "workflows"]])

		// Verify workflows files are excluded but others remain
		filteredFiles.length.should.equal(4) // 2 in root + 2 in other

		const expectedFiles = [
			path.resolve(diracrulesDirPath, "config.json"),
			path.resolve(diracrulesDirPath, "settings.js"),
			path.resolve(otherDirPath, "helper.js"),
			path.resolve(otherDirPath, "util.js"),
		]

		filteredFiles.sort().should.deepEqual(expectedFiles.sort())

		// Test with multiple exclusions
		const multiExcludeFiles = await readDirectory(diracrulesDirPath, [
			[".diracrules", "workflows"],
			[".diracrules", "other"],
		])

		// Verify both workflows and other directories are excluded
		multiExcludeFiles.length.should.equal(2) // only the 2 files in root

		const rootOnlyFiles = [path.resolve(diracrulesDirPath, "config.json"), path.resolve(diracrulesDirPath, "settings.js")]

		multiExcludeFiles.sort().should.deepEqual(rootOnlyFiles.sort())
	})

	it("should exclude .diracrules/hooks directory specifically", async () => {
		// Create a test directory structure
		const diracrulesDirTest = path.join(tmpDir, "diracrules-hooks-test")
		const diracrulesDirPath = path.join(diracrulesDirTest, ".diracrules")

		// Create .diracrules directory and root files
		await fs.mkdir(diracrulesDirPath, { recursive: true })
		await fs.writeFile(path.join(diracrulesDirPath, "config.json"), "{}")
		await fs.writeFile(path.join(diracrulesDirPath, "settings.js"), "// settings")

		// Create .diracrules/workflows directory and files
		const workflowsDirPath = path.join(diracrulesDirPath, "workflows")
		await fs.mkdir(workflowsDirPath, { recursive: true })
		await fs.writeFile(path.join(workflowsDirPath, "workflow1.js"), "// workflow1")

		// Create .diracrules/hooks directory and files
		const hooksDirPath = path.join(diracrulesDirPath, "hooks")
		await fs.mkdir(hooksDirPath, { recursive: true })
		await fs.writeFile(path.join(hooksDirPath, "PreToolUse"), "#!/usr/bin/env bash")
		await fs.writeFile(path.join(hooksDirPath, "PostToolUse"), "#!/usr/bin/env bash")

		// Get all files WITHOUT exclusion
		const allFiles = await readDirectory(diracrulesDirPath)

		// Verify all files are included
		allFiles.length.should.equal(5) // 2 in root + 1 in workflows + 2 in hooks
		allFiles.some((file) => file.includes("PreToolUse")).should.be.true()
		allFiles.some((file) => file.includes("PostToolUse")).should.be.true()

		// Get files WITH hooks directory excluded
		const filteredFiles = await readDirectory(diracrulesDirPath, [[".diracrules", "hooks"]])

		// Verify hooks files are excluded but others remain
		filteredFiles.length.should.equal(3) // 2 in root + 1 in workflows

		const expectedFiles = [
			path.resolve(diracrulesDirPath, "config.json"),
			path.resolve(diracrulesDirPath, "settings.js"),
			path.resolve(workflowsDirPath, "workflow1.js"),
		]

		filteredFiles.sort().should.deepEqual(expectedFiles.sort())

		// Test with multiple exclusions (both workflows and hooks)
		const multiExcludeFiles = await readDirectory(diracrulesDirPath, [
			[".diracrules", "workflows"],
			[".diracrules", "hooks"],
		])

		// Verify both workflows and hooks directories are excluded
		multiExcludeFiles.length.should.equal(2) // only the 2 files in root

		const rootOnlyFiles = [path.resolve(diracrulesDirPath, "config.json"), path.resolve(diracrulesDirPath, "settings.js")]

		multiExcludeFiles.sort().should.deepEqual(rootOnlyFiles.sort())
	})

	describe("atomicWriteFile", () => {
		it("should write content to a new file", async () => {
			await fs.mkdir(tmpDir, { recursive: true })
			const target = path.join(tmpDir, "atomic-new.txt")
			await atomicWriteFile(target, "hello atomic")

			const written = await fs.readFile(target, "utf8")
			written.should.equal("hello atomic")
		})

		it("should overwrite an existing file", async () => {
			await fs.mkdir(tmpDir, { recursive: true })
			const target = path.join(tmpDir, "atomic-overwrite.txt")
			await fs.writeFile(target, "old content")

			await atomicWriteFile(target, "new content")

			const written = await fs.readFile(target, "utf8")
			written.should.equal("new content")
		})

		it("should support Uint8Array content", async () => {
			await fs.mkdir(tmpDir, { recursive: true })
			const target = path.join(tmpDir, "atomic-bytes.bin")
			await atomicWriteFile(target, new Uint8Array([1, 2, 3, 4]))

			const written = await fs.readFile(target)
			Array.from(written).should.deepEqual([1, 2, 3, 4])
		})

		it("should not leave a temp file behind on success", async () => {
			await fs.mkdir(tmpDir, { recursive: true })
			const target = path.join(tmpDir, "atomic-clean.txt")
			await atomicWriteFile(target, "clean")

			const entries = await fs.readdir(tmpDir)
			entries.some((e) => e.startsWith("atomic-clean.txt.tmp.")).should.be.false()
		})

		it("should clean up the temp file and throw when the rename target is invalid", async () => {
			await fs.mkdir(tmpDir, { recursive: true })
			// A path whose parent does not exist makes the final rename fail.
			const target = path.join(tmpDir, "missing-dir", "atomic-fail.txt")

			let threw = false
			try {
				await atomicWriteFile(target, "should fail")
			} catch {
				threw = true
			}
			threw.should.be.true()

			// The temp file is created next to the (missing) target, so its
			// directory also does not exist — no orphan temp file leaks.
			const exists = await fileExistsAtPath(target)
			exists.should.be.false()
		})
	})

	describe("ensureParentDirectory", () => {
		it("should create a missing parent directory", async () => {
			await fs.mkdir(tmpDir, { recursive: true })
			const target = path.join(tmpDir, "ensure-parent", "file.txt")

			await ensureParentDirectory(target)

			const parentExists = await isDirectory(path.dirname(target))
			parentExists.should.be.true()
		})

		it("should be a no-op when the parent already exists", async () => {
			await fs.mkdir(tmpDir, { recursive: true })
			const target = path.join(tmpDir, "already-here.txt")

			// Should not throw and should leave the existing directory intact.
			await ensureParentDirectory(target)

			const parentExists = await isDirectory(tmpDir)
			parentExists.should.be.true()
		})

		it("should reject when the missing depth exceeds MKDIR_MAX_DEPTH", async () => {
			await fs.mkdir(tmpDir, { recursive: true })
			const segments = Array.from({ length: MKDIR_MAX_DEPTH + 2 }, (_, i) => `d${i}`)
			const target = path.join(tmpDir, ...segments, "file.txt")

			let threw = false
			try {
				await ensureParentDirectory(target)
			} catch (error) {
				threw = true
				;(error as Error).message.should.match(/nested directories/)
			}
			threw.should.be.true()
		})
	})
})
