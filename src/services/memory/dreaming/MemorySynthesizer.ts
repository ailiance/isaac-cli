// src/services/memory/dreaming/MemorySynthesizer.ts
import type { MemoryCandidate } from "./types"

export interface SynthDeps {
	createMessage: (systemPrompt: string, content: string) => AsyncIterable<{ type: string; text?: string }>
}

/**
 * Result of synthesizing a transcript:
 *   - `created`: brand-new candidates whose (slugified) name did not match
 *     any existing memory — to be saved.
 *   - `reobserved`: slugified names that matched an existing memory. These
 *     are no longer silently skipped; the caller bumps their `lastSeenAt`
 *     so re-confirmed memories stay fresh under the TTL sweep.
 */
export interface SynthResult {
	created: MemoryCandidate[]
	reobserved: string[]
}

const SYSTEM_PROMPT =
	"You distill durable memory from a coding session transcript. Output ONLY a JSON array of " +
	'{scope,type,name,description,body}. scope is "global" (about the user) or "project:<slug>" ' +
	"(about this repo). type in [project,user,feedback,reference]. name is a short kebab-slug. " +
	"Keep entries durable and general; skip ephemeral details. Empty array if nothing worth remembering."

export async function synthesizeMemories(
	condensed: string,
	existing: Array<{ name: string }>,
	deps: SynthDeps,
): Promise<SynthResult> {
	let text = ""
	try {
		for await (const chunk of deps.createMessage(SYSTEM_PROMPT, condensed)) {
			if (chunk.type === "text" && chunk.text) text += chunk.text
		}
	} catch {
		return { created: [], reobserved: [] }
	}
	const arr = parseJsonArray(text)
	if (!arr) return { created: [], reobserved: [] }
	const existingNames = new Set(existing.map((e) => e.name))
	const created: MemoryCandidate[] = []
	const reobserved: string[] = []
	const seenReobserved = new Set<string>()
	for (const c of arr) {
		if (!c || typeof c.name !== "string" || typeof c.body !== "string") continue
		// Slugify so the name always satisfies saveMemory's /^[a-z0-9][a-z0-9_-]*$/i.
		// A non-conforming name (spaces, accents) makes saveMemory throw, which —
		// caught per-run without advancing the cursor — re-synthesizes that run forever.
		const name = slugifyName(c.name)
		if (!name) continue
		// A candidate whose name matches an existing memory is "re-observed":
		// surface it (deduped) so the worker can bump its freshness instead of
		// dropping it silently. New names are collected for saving.
		if (existingNames.has(name)) {
			if (!seenReobserved.has(name)) {
				seenReobserved.add(name)
				reobserved.push(name)
			}
			continue
		}
		existingNames.add(name)
		created.push({
			scope: c.scope === "global" || String(c.scope).startsWith("project:") ? c.scope : "global",
			type: ["project", "user", "feedback", "reference"].includes(c.type) ? c.type : "project",
			name,
			description: typeof c.description === "string" ? c.description : "",
			body: c.body,
		})
	}
	return { created, reobserved }
}

/** Coerce an LLM-proposed name into a safe kebab slug accepted by saveMemory. */
export function slugifyName(raw: string): string {
	return raw
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "") // strip diacritics
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 64)
		.replace(/-+$/g, "")
}

function parseJsonArray(text: string): any[] | null {
	try {
		const start = text.indexOf("[")
		const end = text.lastIndexOf("]")
		if (start === -1 || end < start) return null
		const parsed = JSON.parse(text.slice(start, end + 1))
		return Array.isArray(parsed) ? parsed : null
	} catch {
		return null
	}
}
