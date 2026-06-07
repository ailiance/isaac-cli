import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import { buildBootstrap, buildGcCommand, buildRsyncPull, buildRsyncPush, DEFAULT_EXCLUDES } from "../sync"

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
})
