import { strict as assert } from "node:assert"
import path from "node:path"
import { describe, it } from "mocha"

const C = process.env.ISAAC_E2E_DOCKER
;(C ? describe : describe.skip)("docker integration", () => {
	it("writes a file in the container workspace", async function () {
		this.timeout(60_000)
		const { RemoteEnvironment } = await import("../../RemoteEnvironment")
		const { dockerTransport } = await import("../dockerTransport")
		const { bootstrapDaemonToContainer } = await import("../bootstrap")
		await bootstrapDaemonToContainer(C!, path.resolve("dist/lisael-daemon.js"), "/tmp/lisael-daemon.js")
		const env = new RemoteEnvironment(dockerTransport(C!, "/tmp/lisael-daemon.js", "/workspace"), "/workspace")
		await env.writeFile("docker-made.txt", "FROM_DOCKER")
		assert.equal(await env.readFile("docker-made.txt"), "FROM_DOCKER")
		await env.dispose()
	})
})
