// ailiance-agent: trace rotation policy.
//
// The tracer writes one directory per task under <cwd>/.ailiance-agent/runs/.
// Without a prune step, that directory grows unbounded over months of
// use. We apply a "whichever is more permissive" policy:
//
//   - keep everything younger than `maxAgeDays` (default 30), AND
//   - keep enough recent runs that the total stays under
//     `maxTotalSizeBytes` (default 1 GiB).
//
// A run is removed only when BOTH thresholds say it can go (older than
// the cutoff AND not part of the most-recent set that fits within the
// size budget). This way users with sparse usage keep ~30 days, and
// users hammering the agent cap at ~1 GiB.

import * as fs from "node:fs"
import * as path from "node:path"

export interface PruneOptions {
	dir: string
	maxAgeDays?: number
	maxTotalSizeBytes?: number
}

export interface PruneResult {
	kept: string[]
	removed: string[]
	freedBytes: number
}

const DEFAULT_MAX_AGE_DAYS = 30
const DEFAULT_MAX_TOTAL_SIZE_BYTES = 1 * 1024 * 1024 * 1024 // 1 GiB

interface RunEntry {
	name: string
	full: string
	mtimeMs: number
	sizeBytes: number
}

function dirSizeBytes(p: string): number {
	let total = 0
	const stack: string[] = [p]
	while (stack.length > 0) {
		const cur = stack.pop()!
		let entries: fs.Dirent[]
		try {
			entries = fs.readdirSync(cur, { withFileTypes: true })
		} catch {
			continue
		}
		for (const ent of entries) {
			const child = path.join(cur, ent.name)
			if (ent.isDirectory()) {
				stack.push(child)
			} else if (ent.isFile() || ent.isSymbolicLink()) {
				try {
					total += fs.statSync(child).size
				} catch {
					// ignore unreadable files
				}
			}
		}
	}
	return total
}

export async function prune(opts: PruneOptions): Promise<PruneResult> {
	const dir = opts.dir
	const maxAgeDays = opts.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS
	const maxTotalSizeBytes = opts.maxTotalSizeBytes ?? DEFAULT_MAX_TOTAL_SIZE_BYTES
	const result: PruneResult = { kept: [], removed: [], freedBytes: 0 }

	let entries: fs.Dirent[]
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true })
	} catch {
		return result // dir does not exist yet — nothing to prune
	}

	const runs: RunEntry[] = []
	for (const ent of entries) {
		if (!ent.isDirectory()) continue
		const full = path.join(dir, ent.name)
		let stat: fs.Stats
		try {
			stat = fs.statSync(full)
		} catch {
			continue
		}
		runs.push({
			name: ent.name,
			full,
			mtimeMs: stat.mtimeMs,
			sizeBytes: dirSizeBytes(full),
		})
	}

	if (runs.length === 0) return result

	// Sort newest-first so the size budget keeps the most recent runs.
	runs.sort((a, b) => b.mtimeMs - a.mtimeMs)

	const ageCutoffMs = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000
	let cumulative = 0
	const sizeKeepSet = new Set<string>()
	for (const r of runs) {
		if (cumulative + r.sizeBytes <= maxTotalSizeBytes) {
			sizeKeepSet.add(r.name)
			cumulative += r.sizeBytes
		}
	}

	for (const r of runs) {
		const keepByAge = r.mtimeMs >= ageCutoffMs
		const keepBySize = sizeKeepSet.has(r.name)
		if (keepByAge || keepBySize) {
			result.kept.push(r.name)
			continue
		}
		try {
			fs.rmSync(r.full, { recursive: true, force: true })
			result.removed.push(r.name)
			result.freedBytes += r.sizeBytes
		} catch {
			// best-effort: leave entry alone if rm fails
			result.kept.push(r.name)
		}
	}

	return result
}
