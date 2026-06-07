// src/services/memory/dreaming/DreamWorker.ts
import { isProcessed, loadCursor, markProcessed, saveCursor } from "./corpusCursor"
import type { SynthResult } from "./MemorySynthesizer"
import type { MemoryCandidate } from "./types"

export interface RunRef {
	projectKey: string
	taskId: string
	runDir: string
}

export interface DreamDeps {
	cursorFile: string
	listRuns: () => Promise<RunRef[]>
	condense: (runDir: string) => Promise<string>
	listExisting: (scope?: string) => Promise<Array<{ name: string }>>
	synthesize: (condensed: string, existing: Array<{ name: string }>) => Promise<SynthResult>
	save: (c: MemoryCandidate) => Promise<void>
	/** Refresh `lastSeenAt` of a re-observed memory so it stays fresh. Optional/injectable. */
	bump?: (name: string) => Promise<void>
	/** Sweep TTL-stale memories (deleteMemory). Runs once per pass. Optional/injectable. */
	expire?: () => Promise<void>
}

export async function runDreamOnce(deps: DreamDeps): Promise<void> {
	let cursor = await loadCursor(deps.cursorFile)
	// Cap runs per pass so a large backlog can't fire an unbounded burst of LLM calls.
	const MAX_RUNS_PER_PASS = 25
	const pending = (await deps.listRuns())
		.filter((r) => !isProcessed(cursor, r.projectKey, r.taskId))
		.slice(0, MAX_RUNS_PER_PASS)
	for (const run of pending) {
		try {
			const condensed = await deps.condense(run.runDir)
			if (condensed.trim()) {
				const existing = await deps.listExisting()
				const { created, reobserved } = await deps.synthesize(condensed, existing)
				for (const c of created) {
					// Drop a bad candidate (e.g. saveMemory rejects an odd name) without
					// aborting the run — otherwise the cursor never advances and this run
					// is re-synthesized (a full LLM call) on every tick forever.
					try {
						await deps.save(c)
					} catch {
						// skip this candidate
					}
				}
				// Bump freshness of re-observed memories so they survive the TTL sweep.
				// Best-effort: a failing bump must not block cursor advance.
				if (deps.bump) {
					for (const name of reobserved) {
						try {
							await deps.bump(name)
						} catch {
							// skip this bump
						}
					}
				}
			}
			cursor = markProcessed(cursor, run.projectKey, run.taskId)
			await saveCursor(deps.cursorFile, cursor)
		} catch {
			// run-level failure (e.g. condense/list) — do not advance cursor; retry next pass
		}
	}
	// TTL sweep once per pass, after all runs. Best-effort: never throws out.
	if (deps.expire) {
		try {
			await deps.expire()
		} catch {
			// best-effort sweep
		}
	}
}

export class DreamWorker {
	private timer?: NodeJS.Timeout
	private running = false
	constructor(
		private deps: DreamDeps,
		private intervalMs = 5 * 60_000,
	) {}
	start(): void {
		if (this.timer) return
		this.timer = setInterval(() => this.tick(), this.intervalMs)
		this.timer.unref?.()
	}
	isProcessing(): boolean {
		return this.running
	}
	unref(): void {
		this.timer?.unref?.()
	}
	private async tick(): Promise<void> {
		if (this.running) return
		this.running = true
		try {
			await runDreamOnce(this.deps)
		} catch {
			/* best-effort */
		} finally {
			this.running = false
		}
	}
	stop(): void {
		if (this.timer) clearInterval(this.timer)
		this.timer = undefined
	}
}
