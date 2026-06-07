import { strict as assert } from "node:assert"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, it } from "mocha"
import {
	buildBootstrap,
	buildGcCommand,
	buildRsyncPull,
	buildRsyncPullExcept,
	buildRsyncPullInto,
	buildRsyncPush,
	DEFAULT_EXCLUDES,
	gitignoreExcludes,
	mergeExcludes,
} from "../sync"

describe("ssh sync arg builders", () => {
	it("buildGcCommand removes workspace dirs older than ttl", () => {
		const cmd = buildGcCommand(7)
		assert.match(cmd, /find ~\/\.isaac\/workspaces/)
		assert.match(cmd, /-mtime \+7/)
		assert.match(cmd, /rm -rf/)
	})

	it("push: rsync -az --delete -e ssh with excludes and trailing slashes", () => {
		const args = buildRsyncPush("studio", "/local/wd", "~/.isaac/workspaces/w1", DEFAULT_EXCLUDES)
		assert.ok(args.includes("-az") && args.includes("--delete"))
		assert.equal(args[args.indexOf("-e") + 1], "ssh")
		assert.ok(args.some((a) => a === "--exclude=.git"))
		assert.equal(args.at(-2), "/local/wd/")
		assert.equal(args.at(-1), "studio:~/.isaac/workspaces/w1/")
	})
	it("pull: remote -> local (no --delete by default)", () => {
		const args = buildRsyncPull("studio", "~/.isaac/workspaces/w1", "/local/wd", DEFAULT_EXCLUDES)
		assert.equal(args.at(-2), "studio:~/.isaac/workspaces/w1/")
		assert.equal(args.at(-1), "/local/wd/")
		assert.ok(!args.includes("--delete"))
	})
	it("bootstrap: copies a single file to the remote path", () => {
		const args = buildBootstrap("studio", "/repo/dist/lisael-daemon.js", "~/.isaac/lisael-daemon.js")
		assert.equal(args.at(-2), "/repo/dist/lisael-daemon.js")
		assert.equal(args.at(-1), "studio:~/.isaac/lisael-daemon.js")
	})

	it("reads .gitignore into excludes (skips comments/blanks)", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "gi-"))
		await fs.writeFile(path.join(tmp, ".gitignore"), "dist\n*.log\n# comment\n\n")
		const ex = await gitignoreExcludes(tmp)
		assert.ok(ex.includes("dist") && ex.includes("*.log"))
		assert.ok(!ex.some((e) => e.startsWith("#") || e === ""))
		await fs.rm(tmp, { recursive: true, force: true })
	})
	it("gitignoreExcludes: missing file -> empty", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "gi-"))
		assert.deepEqual(await gitignoreExcludes(tmp), [])
		await fs.rm(tmp, { recursive: true, force: true })
	})
	it("mergeExcludes: union, de-duplicated", () => {
		assert.deepEqual(mergeExcludes([".git", "node_modules"], ["node_modules", "dist"]), [".git", "node_modules", "dist"])
	})

	it("pullExcept: excludes base excludes + except paths (anchored)", () => {
		const args = buildRsyncPullExcept("studio", "~/.isaac/workspaces/w1", "/local/wd", DEFAULT_EXCLUDES, [
			"a.txt",
			"src/b.ts",
		])
		assert.ok(args.some((a) => a === "--exclude=.git"))
		assert.ok(args.some((a) => a === "--exclude=/a.txt"))
		assert.ok(args.some((a) => a === "--exclude=/src/b.ts"))
		assert.equal(args.at(-2), "studio:~/.isaac/workspaces/w1/")
		assert.equal(args.at(-1), "/local/wd/")
		assert.ok(!args.includes("--delete"))
	})
	it("pullInto: -R fetch of specific relpaths into side dir", () => {
		const args = buildRsyncPullInto("studio", "~/.isaac/workspaces/w1", "/local/wd/.isaac/pulled-s1", ["a.txt", "src/b.ts"])
		assert.ok(args.includes("-R"))
		assert.ok(args.includes("studio:~/.isaac/workspaces/w1/./a.txt"))
		assert.ok(args.includes("studio:~/.isaac/workspaces/w1/./src/b.ts"))
		assert.equal(args.at(-1), "/local/wd/.isaac/pulled-s1/")
	})
})
