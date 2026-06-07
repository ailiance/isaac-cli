import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process"
import { subprocessTransport, type Transport } from "../transport"

/**
 * Spawns the daemon on `host` over SSH and frames JSON-RPC over its stdio.
 *
 * Runs through a login shell (`bash -lc`) so the remote PATH is sourced — a bare
 * `ssh host node …` uses a non-login PATH that typically misses user-level Node
 * installs (e.g. MacStudio's Node in ~/.local/bin). `~` expands on the remote.
 */
export function sshTransport(host: string, remoteDaemonPath: string, remoteCwd: string): Transport {
	const remoteCmd = `node ${remoteDaemonPath} ${remoteCwd}`
	const child = spawn("ssh", [host, "bash", "-lc", remoteCmd]) as ChildProcessWithoutNullStreams
	return subprocessTransport(child)
}
