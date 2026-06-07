// src/services/memory/dreaming/decay.ts
export const MEMORY_TTL_DAYS = 60

export function isStale(m: { lastSeenAt?: string; created?: string }, ttlDays = MEMORY_TTL_DAYS, now = Date.now()): boolean {
	const ts = Date.parse(m.lastSeenAt ?? m.created ?? "")
	if (Number.isNaN(ts)) {
		return false
	}
	return now - ts > ttlDays * 86_400_000
}
