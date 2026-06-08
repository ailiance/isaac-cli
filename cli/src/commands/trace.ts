// ailiance-agent: `isaac trace` subcommand.
//
// Subcommands:
//   - isaac trace list                    : list all run directories
//   - isaac trace prune [--max-age N]     : apply rotation policy now
//                     [--max-size 1G]
//
// The prune policy lives in src/core/tracing/pruner.ts; this file is
// just CLI plumbing.

import * as fs from "node:fs"
import * as path from "node:path"
import { exit } from "node:process"

const TRACING_DIR_NAME = ".ailiance-agent/runs"

function resolveRunsDir(cwd?: string): string {
	const base = cwd ?? process.cwd()
	return path.resolve(base, TRACING_DIR_NAME)
}

/** Parse "1G", "500M", "100K", or a raw byte count into bytes. */
export function parseSize(input: string): number {
	const m = input.trim().match(/^(\d+(?:\.\d+)?)\s*([KMG]i?B?)?$/i)
	if (!m) throw new Error(`invalid --max-size value: ${input}`)
	const n = Number.parseFloat(m[1])
	const unit = (m[2] || "").toUpperCase().replace("IB", "").replace("B", "")
	const factor: Record<string, number> = { "": 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3 }
	const f = factor[unit]
	if (f === undefined) throw new Error(`invalid --max-size unit: ${input}`)
	return Math.floor(n * f)
}

export async function runTraceList(options: { cwd?: string }): Promise<void> {
	const dir = resolveRunsDir(options.cwd)
	if (!fs.existsSync(dir)) {
		console.log(`(no traces yet at ${dir})`)
		return
	}
	const entries = fs.readdirSync(dir, { withFileTypes: true })
	const runs = entries
		.filter((e) => e.isDirectory())
		.map((e) => {
			const full = path.join(dir, e.name)
			const stat = fs.statSync(full)
			return { name: e.name, mtime: stat.mtime }
		})
		.sort((a, b) => b.mtime.getTime() - a.mtime.getTime())

	if (runs.length === 0) {
		console.log(`(no traces in ${dir})`)
		return
	}
	for (const r of runs) {
		console.log(`${r.mtime.toISOString()}  ${r.name}`)
	}
}

export async function runTracePrune(options: { cwd?: string; maxAge?: string; maxSize?: string }): Promise<void> {
	const { prune } = await import("@core/tracing/pruner")
	const dir = resolveRunsDir(options.cwd)
	const maxAgeDays = options.maxAge ? Number(options.maxAge) : undefined
	if (maxAgeDays !== undefined && (!Number.isFinite(maxAgeDays) || maxAgeDays < 0)) {
		console.error(`invalid --max-age: ${options.maxAge}`)
		exit(2)
	}
	let maxTotalSizeBytes: number | undefined
	if (options.maxSize) {
		try {
			maxTotalSizeBytes = parseSize(options.maxSize)
		} catch (err) {
			console.error((err as Error).message)
			exit(2)
		}
	}
	const result = await prune({ dir, maxAgeDays, maxTotalSizeBytes })
	console.log(`pruned: kept ${result.kept.length}, removed ${result.removed.length}, freed ${result.freedBytes} bytes`)
	if (result.removed.length > 0) {
		for (const name of result.removed) {
			console.log(`  - ${name}`)
		}
	}
}
