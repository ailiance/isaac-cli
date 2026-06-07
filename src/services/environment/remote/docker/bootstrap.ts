import { spawn } from "node:child_process"

export function buildDockerExecArgs(container: string, daemonPath: string, wsPath: string): string[] {
	return ["exec", "-i", container, "node", daemonPath, wsPath]
}

export function buildDockerCp(container: string, localFile: string, remotePath: string): string[] {
	return ["cp", localFile, `${container}:${remotePath}`]
}

export function bootstrapDaemonToContainer(container: string, localBundle: string, remotePath: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn("docker", buildDockerCp(container, localBundle, remotePath))
		let stderr = ""
		child.stderr.on("data", (d: Buffer) => {
			stderr += d.toString("utf8")
		})
		child.on("error", reject)
		child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`docker cp exited ${code}: ${stderr}`))))
	})
}
