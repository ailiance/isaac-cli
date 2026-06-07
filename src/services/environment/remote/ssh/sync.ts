import { spawn } from "node:child_process"

export const DEFAULT_EXCLUDES = [".git", "node_modules", "dist", "build", ".isaac", ".ailiance-agent", "*.vsix"]

function excludeArgs(excludes: string[]): string[] {
	return excludes.map((e) => `--exclude=${e}`)
}

/** rsync local dir -> remote dir (seed). Trailing slashes sync contents. */
export function buildRsyncPush(host: string, localDir: string, remoteDir: string, excludes: string[]): string[] {
	return ["-az", "--delete", "-e", "ssh", ...excludeArgs(excludes), `${localDir}/`, `${host}:${remoteDir}/`]
}

/** rsync remote dir -> local dir (pull back). No --delete (remote authoritative for content, not deletions). */
export function buildRsyncPull(host: string, remoteDir: string, localDir: string, excludes: string[]): string[] {
	return ["-az", "-e", "ssh", ...excludeArgs(excludes), `${host}:${remoteDir}/`, `${localDir}/`]
}

/** rsync a single file (the daemon bundle) to a remote path. */
export function buildBootstrap(host: string, localFile: string, remotePath: string): string[] {
	return ["-az", "-e", "ssh", localFile, `${host}:${remotePath}`]
}

export function runRsync(args: string[]): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn("rsync", args)
		let stderr = ""
		child.stderr.on("data", (d: Buffer) => {
			stderr += d.toString("utf8")
		})
		child.on("error", reject)
		child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`rsync exited ${code}: ${stderr}`))))
	})
}

export function runSsh(host: string, command: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn("ssh", [host, command])
		child.on("error", reject)
		child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ssh ${host} exited ${code}`))))
	})
}
