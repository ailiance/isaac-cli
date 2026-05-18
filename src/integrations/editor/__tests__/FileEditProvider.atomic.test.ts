import * as assert from "assert"
import * as fs from "fs/promises"
import { afterEach, beforeEach, describe, it } from "mocha"
import * as os from "os"
import * as path from "path"
import { FileEditProvider } from "../FileEditProvider"

/**
 * Integration coverage for the edit-reliability hardening: FileEditProvider
 * (the standalone/CLI save path) must persist edits through the atomic
 * tmp + rename helper and create any missing parent directories first.
 *
 * `saveDocument` is `protected`; this subclass exposes it and lets the test
 * inject `absolutePath` / `documentContent` directly so the save can be
 * exercised without standing up a full HostProvider / workspace mock.
 */
class TestFileEditProvider extends FileEditProvider {
	setTarget(absolutePath: string, content: string): void {
		// `absolutePath` and `documentContent` are protected on the base /
		// FileEditProvider — reachable from this subclass.
		;(this as unknown as { absolutePath?: string }).absolutePath = absolutePath
		this.documentContent = content
	}

	saveNow(): Promise<boolean> {
		return this.saveDocument()
	}
}

describe("FileEditProvider – atomic save integration", () => {
	let tmpDir: string

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "aki-fileedit-atomic-"))
	})

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
	})

	it("writes new file content and leaves no temp file behind", async () => {
		const target = path.join(tmpDir, "new-file.txt")
		const provider = new TestFileEditProvider()
		provider.setTarget(target, "hello atomic world")

		const ok = await provider.saveNow()

		assert.equal(ok, true)
		assert.equal(await fs.readFile(target, "utf8"), "hello atomic world")
		const remaining = await fs.readdir(tmpDir)
		assert.deepEqual(
			remaining.filter((f) => f.startsWith("new-file.txt.tmp.")),
			[],
			"atomic tmp file must be renamed away on success",
		)
	})

	it("overwrites an existing file in place", async () => {
		const target = path.join(tmpDir, "existing.txt")
		await fs.writeFile(target, "stale contents")

		const provider = new TestFileEditProvider()
		provider.setTarget(target, "fresh contents")
		const ok = await provider.saveNow()

		assert.equal(ok, true)
		assert.equal(await fs.readFile(target, "utf8"), "fresh contents")
	})

	it("creates missing parent directories before writing", async () => {
		const target = path.join(tmpDir, "deep", "nested", "dir", "file.txt")
		const provider = new TestFileEditProvider()
		provider.setTarget(target, "content under fresh dirs")

		const ok = await provider.saveNow()

		assert.equal(ok, true)
		const parentStat = await fs.stat(path.dirname(target))
		assert.ok(parentStat.isDirectory())
		assert.equal(await fs.readFile(target, "utf8"), "content under fresh dirs")
	})

	it("does not corrupt the previous file when the write target is invalid", async () => {
		// Point at a path whose parent is an existing *file*, not a directory.
		// ensureParentDirectory / atomicWriteFile must fail without having
		// replaced any real file. saveDocument swallows the error and reports
		// failure rather than leaving a half-written buffer.
		const blocker = path.join(tmpDir, "iam-a-file")
		await fs.writeFile(blocker, "do not touch me")
		const target = path.join(blocker, "child.txt")

		const provider = new TestFileEditProvider()
		provider.setTarget(target, "should never land")
		const ok = await provider.saveNow()

		assert.equal(ok, false, "save through an invalid path must report failure")
		// The pre-existing sibling file is untouched.
		assert.equal(await fs.readFile(blocker, "utf8"), "do not touch me")
	})

	it("returns false without writing when there is nothing to save", async () => {
		const provider = new TestFileEditProvider()
		// No target / content set.
		const ok = await provider.saveNow()
		assert.equal(ok, false)
	})
})
