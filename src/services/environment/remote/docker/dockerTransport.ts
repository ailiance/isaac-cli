import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process"
import { subprocessTransport, type Transport } from "../transport"
import { buildDockerExecArgs } from "./bootstrap"

export function dockerTransport(container: string, daemonPath: string, wsPath: string): Transport {
	const child = spawn("docker", buildDockerExecArgs(container, daemonPath, wsPath)) as ChildProcessWithoutNullStreams
	return subprocessTransport(child)
}
