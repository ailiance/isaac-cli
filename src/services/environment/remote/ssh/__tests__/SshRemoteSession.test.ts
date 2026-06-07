import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import { SshRemoteSession } from "../SshRemoteSession"

describe("SshRemoteSession", () => {
	it("bootstraps + seeds before the first op, pulls + cleans on dispose", async () => {
		const calls: string[] = []
		const env = SshRemoteSession.create("studio", "/local/wd", {
			gc: async () => {
				calls.push("gc")
			},
			bootstrap: async () => {
				calls.push("bootstrap")
			},
			push: async () => {
				calls.push("push")
			},
			pull: async () => {
				calls.push("pull")
			},
			cleanup: async () => {
				calls.push("cleanup")
			},
			makeEnv: () =>
				({
					id: "remote",
					cwd: "/remote/wd",
					readFile: async () => {
						calls.push("readFile")
						return "data"
					},
					dispose: async () => {
						calls.push("env.dispose")
					},
				}) as any,
		})
		const data = await env.readFile("a.txt")
		assert.equal(data, "data")
		assert.deepEqual(calls, ["gc", "bootstrap", "push", "readFile"])
		await env.dispose()
		assert.deepEqual(calls.slice(-3), ["env.dispose", "pull", "cleanup"])
	})
})
