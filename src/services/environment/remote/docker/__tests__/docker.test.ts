import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import { buildDockerCp, buildDockerExecArgs } from "../bootstrap"

describe("docker arg builders", () => {
	it("docker exec args: -i <container> node <daemon> <ws>", () => {
		assert.deepEqual(buildDockerExecArgs("c1", "/tmp/lisael-daemon.js", "/workspace"), [
			"exec",
			"-i",
			"c1",
			"node",
			"/tmp/lisael-daemon.js",
			"/workspace",
		])
	})
	it("docker cp args: <local> <container>:<remote>", () => {
		assert.deepEqual(buildDockerCp("c1", "/repo/dist/lisael-daemon.js", "/tmp/lisael-daemon.js"), [
			"cp",
			"/repo/dist/lisael-daemon.js",
			"c1:/tmp/lisael-daemon.js",
		])
	})
})
