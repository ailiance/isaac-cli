import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process"
import path from "node:path"
import { LocalEnvironment } from "./LocalEnvironment"
import { RemoteEnvironment } from "./remote/RemoteEnvironment"
import { SshRemoteSession } from "./remote/ssh/SshRemoteSession"
import { subprocessTransport } from "./remote/transport"
import type { CommandRunner, Environment } from "./types"

export interface ResolveEnvironmentOptions {
	cwd: string
	commandRunner?: CommandRunner
}

export function resolveEnvironment(opts: ResolveEnvironmentOptions): Environment {
	// Opt-in SSH path: run tool I/O on a remote host over an ssh-spawned daemon,
	// with rsync workspace seed/pull. Default callers are unaffected.
	const isaacEnv = process.env.ISAAC_ENV
	if (isaacEnv?.startsWith("ssh:")) {
		return SshRemoteSession.create(isaacEnv.slice("ssh:".length), opts.cwd)
	}
	// Opt-in remote path: spawn the bundled daemon and talk to it over stdio.
	// Default (and every existing caller) stays on LocalEnvironment, unchanged.
	if (isaacEnv === "remote-local") {
		const daemonPath = path.join(__dirname, "lisael-daemon.js")
		// Use process.execPath (the running Node binary), not a bare "node" that may
		// be absent from PATH. The transport is wired before listeners so a spawn
		// failure surfaces as a transport close that rejects pending requests.
		const child = spawn(process.execPath, [daemonPath, opts.cwd]) as ChildProcessWithoutNullStreams
		const transport = subprocessTransport(child)
		child.on("error", () => transport.close())
		child.on("exit", () => transport.close())
		return new RemoteEnvironment(transport, opts.cwd, { onClose: () => child.kill() })
	}
	return new LocalEnvironment(opts.cwd, opts.commandRunner)
}
