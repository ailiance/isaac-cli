import type { WorkerEndpoint, WorkerHealth } from "./types"

export class HealthMonitor {
	private health = new Map<string, WorkerHealth>()
	private timers = new Map<string, NodeJS.Timeout>()
	private workers: Map<string, WorkerEndpoint>

	constructor(workers: Map<string, WorkerEndpoint>) {
		this.workers = workers
		for (const id of workers.keys()) this.health.set(id, "unknown")
	}

	/**
	 * Start periodic health checks (30s). Also performs an initial ping
	 * which serves as wake-up / preheat for each worker.
	 */
	start(): void {
		for (const [id, w] of this.workers) {
			// Initial ping (preheat) + recurring
			this.check(id, w).catch(() => {})
			const t = setInterval(() => this.check(id, w).catch(() => {}), 30_000)
			this.timers.set(id, t)
		}
	}

	stop(): void {
		for (const t of this.timers.values()) clearInterval(t)
		this.timers.clear()
	}

	getHealth(id: string): WorkerHealth {
		return this.health.get(id) ?? "unknown"
	}

	isUp(id: string): boolean {
		return this.health.get(id) === "up"
	}

	private async check(id: string, w: WorkerEndpoint): Promise<void> {
		try {
			// Try a lightweight /health endpoint first; fall back to /v1/models.
			// Each attempt gets its OWN controller + timeout: a shared one meant the
			// fallback fetch could start with an already-fired 5s timer and abort
			// instantly, hiding a worker that was actually up.
			const base = w.url.replace(/\/v1\/?$/, "").replace(/\/$/, "")
			try {
				this.health.set(id, (await HealthMonitor.pingOnce(`${base}/health`)) ? "up" : "down")
			} catch {
				this.health.set(id, (await HealthMonitor.pingOnce(`${base}/v1/models`)) ? "up" : "down")
			}
		} catch {
			this.health.set(id, "down")
		}
	}

	private static async pingOnce(url: string): Promise<boolean> {
		const ctrl = new AbortController()
		const timeout = setTimeout(() => ctrl.abort(), 5_000)
		try {
			const r = await fetch(url, { signal: ctrl.signal })
			return r.ok
		} finally {
			clearTimeout(timeout)
		}
	}
}
