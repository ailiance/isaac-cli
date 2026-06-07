import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import { DockerSession } from "../DockerSession"

describe("DockerSession", () => {
	it("bootstraps (docker cp) before the first op, closes env on dispose (no pull)", async () => {
		const calls: string[] = []
		const session = DockerSession.create("c1", "/workspace", {
			bootstrap: async () => {
				calls.push("bootstrap")
			},
			makeEnv: () =>
				({
					id: "docker:c1",
					cwd: "/workspace",
					readFile: async () => {
						calls.push("readFile")
						return "data"
					},
					dispose: async () => {
						calls.push("env.dispose")
					},
				}) as any,
		})
		const data = await session.readFile("a.txt")
		assert.equal(data, "data")
		// The whole point: cp (bootstrap) must complete before the first exec/read.
		assert.deepEqual(calls, ["bootstrap", "readFile"])

		await session.dispose()
		// Bind-mount: dispose closes the env only — no pull, no remote cleanup.
		assert.deepEqual(calls, ["bootstrap", "readFile", "env.dispose"])
	})

	it("delays makeEnv until bootstrap resolves (race guard)", async () => {
		const order: string[] = []
		let releaseBootstrap: () => void = () => {}
		const bootstrapGate = new Promise<void>((r) => {
			releaseBootstrap = r
		})
		const session = DockerSession.create("c1", "/workspace", {
			bootstrap: async () => {
				await bootstrapGate
				order.push("bootstrap")
			},
			makeEnv: () => {
				order.push("makeEnv")
				return {
					id: "docker:c1",
					cwd: "/workspace",
					readFile: async () => "data",
					dispose: async () => {},
				} as any
			},
		})
		const read = session.readFile("a.txt")
		// makeEnv (which spawns docker exec) must not run while bootstrap is pending.
		assert.deepEqual(order, [])
		releaseBootstrap()
		await read
		assert.deepEqual(order, ["bootstrap", "makeEnv"])
		await session.dispose()
	})

	it("dispose is idempotent and disposes the env at most once", async () => {
		let disposeCount = 0
		const session = DockerSession.create("c1", "/workspace", {
			bootstrap: async () => {},
			makeEnv: () =>
				({
					id: "docker:c1",
					cwd: "/workspace",
					readFile: async () => "data",
					dispose: async () => {
						disposeCount++
					},
				}) as any,
		})
		await session.readFile("a.txt")
		await session.dispose()
		await session.dispose()
		assert.equal(disposeCount, 1)
	})
})
