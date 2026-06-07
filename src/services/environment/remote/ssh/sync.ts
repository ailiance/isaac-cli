import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"

export const DEFAULT_EXCLUDES = [".git", "node_modules", "dist", "build", ".isaac", ".ailiance-agent", "*.vsix"]

/** Read `<localDir>/.gitignore` into rsync exclude entries (skips comments/blanks). */
export async function gitignoreExcludes(localDir: string): Promise<string[]> {
	try {
		const raw = await fs.readFile(path.join(localDir, ".gitignore"), "utf8")
		return raw
			.split("\n")
			.map((l) => l.trim())
			.filter((l) => l && !l.startsWith("#"))
	} catch {
		return []
	}
}

/** Union several exclude lists, de-duplicated, preserving first-seen order. */
export function mergeExcludes(...lists: string[][]): string[] {
	return [...new Set(lists.flat())]
}

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

/** Pull remote->local but exclude specific relpaths (protect local edits). */
export function buildRsyncPullExcept(
	host: string,
	remoteDir: string,
	localDir: string,
	excludes: string[],
	exceptPaths: string[],
): string[] {
	return [
		"-az",
		"-e",
		"ssh",
		...excludeArgs(excludes),
		...exceptPaths.map((p) => `--exclude=/${p}`),
		`${host}:${remoteDir}/`,
		`${localDir}/`,
	]
}

/** Fetch only specific relpaths into a side directory, preserving structure. */
export function buildRsyncPullInto(host: string, remoteDir: string, sideDir: string, paths: string[]): string[] {
	return ["-az", "-R", "-e", "ssh", ...paths.map((p) => `${host}:${remoteDir}/./${p}`), `${sideDir}/`]
}

/** rsync a single file (the daemon bundle) to a remote path. */
export function buildBootstrap(host: string, localFile: string, remotePath: string): string[] {
	return ["-az", "-e", "ssh", localFile, `${host}:${remotePath}`]
}

/** Remote shell command that GCs orphan workspace dirs older than ttlDays. */
export function buildGcCommand(ttlDays: number): string {
	return `find ~/.isaac/workspaces -mindepth 1 -maxdepth 1 -type d -mtime +${ttlDays} -exec rm -rf {} +`
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
