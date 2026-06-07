import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process"
import path from "node:path"
import { LocalEnvironment } from "./LocalEnvironment"
import { RemoteEnvironment } from "./remote/RemoteEnvironment"
import { subprocessTransport } from "./remote/transport"
import type { CommandRunner, Environment } from "./types"

export interface ResolveEnvironmentOptions {
	cwd: string
	commandRunner?: CommandRunner
}

export function resolveEnvironment(opts: ResolveEnvironmentOptions): Environment {
	// Opt-in remote path: spawn the bundled daemon and talk to it over stdio.
	// Default (and every existing caller) stays on LocalEnvironment, unchanged.
	if (process.env.ISAAC_ENV === "remote-local") {
		const daemonPath = path.join(__dirname, "lisael-daemon.js")
		const child = spawn("node", [daemonPath, opts.cwd]) as ChildProcessWithoutNullStreams
		return new RemoteEnvironment(subprocessTransport(child), opts.cwd, { onClose: () => child.kill() })
	}
	return new LocalEnvironment(opts.cwd, opts.commandRunner)
}
