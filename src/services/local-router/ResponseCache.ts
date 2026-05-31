import { createHash } from "node:crypto"
import type { ChatRequest, ChatResponse } from "./types"

interface CacheEntry {
	value: ChatResponse
	expiresAt: number
}

export class ResponseCache {
	private map = new Map<string, CacheEntry>()
	private maxSize: number
	private ttlMs: number

	constructor(opts: { maxSize?: number; ttlMs?: number } = {}) {
		this.maxSize = opts.maxSize ?? 100
		this.ttlMs = opts.ttlMs ?? 3_600_000 // 1h
	}

	static keyOf(req: ChatRequest, workerId: string): string {
		const h = createHash("sha256")
		h.update(workerId)
		h.update(req.model ?? "")
		h.update(String(req.temperature ?? 1))
		h.update(String(req.max_tokens ?? 0))
		for (const m of req.messages) {
			h.update(m.role)
			h.update(m.content)
		}
		return h.digest("hex")
	}

	get(key: string): ChatResponse | null {
		const e = this.map.get(key)
		if (!e) return null
		if (e.expiresAt < Date.now()) {
			this.map.delete(key)
			return null
		}
		// refresh LRU order
		this.map.delete(key)
		this.map.set(key, e)
		return e.value
	}

	set(key: string, value: ChatResponse): void {
		if (this.map.size >= this.maxSize && !this.map.has(key)) {
			// First reclaim expired entries — otherwise a full cache of stale
			// entries would evict a fresh one by LRU while the stale ones linger.
			const now = Date.now()
			for (const [k, e] of this.map) {
				if (e.expiresAt < now) this.map.delete(k)
			}
			// Still at capacity? evict the oldest (LRU).
			if (this.map.size >= this.maxSize) {
				const firstKey = this.map.keys().next().value
				if (firstKey) this.map.delete(firstKey)
			}
		}
		this.map.set(key, { value, expiresAt: Date.now() + this.ttlMs })
	}

	clear(): void {
		this.map.clear()
	}

	size(): number {
		return this.map.size
	}
}
