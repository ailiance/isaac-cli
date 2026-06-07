import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe } from "mocha"
import { runEnvironmentConformance } from "../../__tests__/conformance"
import { createDaemonServer } from "../daemon"
import { RemoteEnvironment } from "../RemoteEnvironment"
import { inProcessTransportPair } from "../transport"

describe("RemoteEnvironment (in-process daemon)", () => {
	runEnvironmentConformance(async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "isaac-remote-"))
		const [clientT, serverT] = inProcessTransportPair()
		createDaemonServer(serverT, dir)
		return new RemoteEnvironment(clientT, dir)
	})
})
