// ailiance-agent fork: cross-task memory store
//
// Persists user-level knowledge (preferences, repo conventions, gotchas)
// across sessions. Modeled on Claude Code's memory system at
// ~/.claude/projects/<slug>/memory/. Each memory is a markdown file with
// YAML frontmatter; an index `MEMORY.md` at the root lists them all.
//
// Storage layout:
//   ~/.ailiance-agent/memory/
//   ├── MEMORY.md                   # one-line index, human-readable
//   ├── user_role.md                # individual memory files
//   ├── feedback_no_amend.md
//   └── project_<slug>/             # optional per-project scope
//       └── ...
//
// Each memory file:
//   ---
//   name: short-kebab-case-slug
//   description: one-line summary, used for relevance lookup
//   type: user | feedback | project | reference
//   scope: global | project:<repo-name>
//   created: ISO timestamp
//   ---
//   body in markdown
//
// This module ships the CRUD layer + listing + filtering. The auto-injection
// at turn-1 of new tasks is deferred to a follow-up PR — it touches the
// system prompt assembly and warrants its own focused review. The slash
// commands `/remember`, `/forget`, `/memories` are wired through
// `cli/src/commands/memory.ts`.

import * as fs from "fs/promises"
import * as path from "path"
import * as os from "os"

export type MemoryType = "user" | "feedback" | "project" | "reference"
export type MemoryScope = "global" | `project:${string}`

export interface MemoryFrontmatter {
	name: string
	description: string
	type: MemoryType
	scope: MemoryScope
	created: string
}

export interface Memory extends MemoryFrontmatter {
	body: string
	filePath: string
}

const MEMORY_ROOT = path.join(os.homedir(), ".ailiance-agent", "memory")
const INDEX_FILE = path.join(MEMORY_ROOT, "MEMORY.md")

/**
 * Ensure the memory directory exists. Idempotent.
 */
async function ensureMemoryRoot(): Promise<void> {
	await fs.mkdir(MEMORY_ROOT, { recursive: true })
}

/**
 * Build the canonical file path for a memory by its name + scope.
 * Project-scoped memories live in a subdirectory so listing/filtering
 * by scope is a directory scan rather than a content scan.
 */
function memoryFilePath(name: string, scope: MemoryScope): string {
	if (scope === "global") {
		return path.join(MEMORY_ROOT, `${name}.md`)
	}
	const projectSlug = scope.slice("project:".length)
	return path.join(MEMORY_ROOT, `project_${projectSlug}`, `${name}.md`)
}

/**
 * Parse a memory markdown file into its frontmatter + body.
 * Returns null when the file is missing, malformed, or missing required fields.
 */
async function parseMemory(filePath: string): Promise<Memory | null> {
	try {
		const raw = await fs.readFile(filePath, "utf-8")
		const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
		if (!match) return null
		const [, frontmatterRaw, body] = match
		const fm: Partial<MemoryFrontmatter> = {}
		for (const line of frontmatterRaw.split("\n")) {
			const colonIdx = line.indexOf(":")
			if (colonIdx === -1) continue
			const key = line.slice(0, colonIdx).trim()
			const value = line.slice(colonIdx + 1).trim()
			if (!key || !value) continue
			if (key === "name") fm.name = value
			else if (key === "description") fm.description = value
			else if (key === "type") fm.type = value as MemoryType
			else if (key === "scope") fm.scope = value as MemoryScope
			else if (key === "created") fm.created = value
		}
		if (!fm.name || !fm.description || !fm.type || !fm.scope || !fm.created) {
			return null
		}
		return {
			name: fm.name,
			description: fm.description,
			type: fm.type,
			scope: fm.scope,
			created: fm.created,
			body: body.trim(),
			filePath,
		}
	} catch {
		return null
	}
}

/**
 * Save a new memory (or overwrite an existing one with the same name+scope).
 * Returns the absolute path to the written file.
 */
export async function saveMemory(input: {
	name: string
	description: string
	type: MemoryType
	scope?: MemoryScope
	body: string
}): Promise<string> {
	await ensureMemoryRoot()
	const scope: MemoryScope = input.scope ?? "global"
	if (!/^[a-z0-9][a-z0-9_-]*$/i.test(input.name)) {
		throw new Error(`memory name must be kebab/snake-case ASCII, got: ${input.name}`)
	}
	const filePath = memoryFilePath(input.name, scope)
	await fs.mkdir(path.dirname(filePath), { recursive: true })
	const frontmatter = [
		"---",
		`name: ${input.name}`,
		`description: ${input.description.replace(/\n/g, " ")}`,
		`type: ${input.type}`,
		`scope: ${scope}`,
		`created: ${new Date().toISOString()}`,
		"---",
		"",
		input.body.trim(),
		"",
	].join("\n")
	await fs.writeFile(filePath, frontmatter, "utf-8")
	await rebuildIndex()
	return filePath
}

/**
 * List all memories, optionally filtered by scope and/or type.
 * Returns them sorted by created (newest first).
 */
export async function listMemories(filter?: {
	scope?: MemoryScope
	type?: MemoryType
}): Promise<Memory[]> {
	await ensureMemoryRoot()
	const memories: Memory[] = []
	// Top-level (global) memories.
	try {
		const entries = await fs.readdir(MEMORY_ROOT)
		for (const entry of entries) {
			if (!entry.endsWith(".md") || entry === "MEMORY.md") continue
			const m = await parseMemory(path.join(MEMORY_ROOT, entry))
			if (m) memories.push(m)
		}
	} catch {
		// directory doesn't exist or is unreadable; treat as empty
	}
	// Project-scoped memories live in project_<slug>/ subdirectories.
	try {
		const entries = await fs.readdir(MEMORY_ROOT, { withFileTypes: true })
		for (const entry of entries) {
			if (!entry.isDirectory() || !entry.name.startsWith("project_")) continue
			const subdir = path.join(MEMORY_ROOT, entry.name)
			const subEntries = await fs.readdir(subdir)
			for (const sub of subEntries) {
				if (!sub.endsWith(".md")) continue
				const m = await parseMemory(path.join(subdir, sub))
				if (m) memories.push(m)
			}
		}
	} catch {
		// best-effort
	}
	let filtered = memories
	if (filter?.scope) filtered = filtered.filter((m) => m.scope === filter.scope)
	if (filter?.type) filtered = filtered.filter((m) => m.type === filter.type)
	filtered.sort((a, b) => (a.created < b.created ? 1 : -1))
	return filtered
}

/**
 * Delete a memory by exact name (matching across scopes).
 * Returns the number of files removed.
 */
export async function deleteMemory(name: string): Promise<number> {
	const memories = await listMemories()
	const matches = memories.filter((m) => m.name === name)
	for (const m of matches) {
		try {
			await fs.unlink(m.filePath)
		} catch {
			// already gone; best-effort
		}
	}
	if (matches.length > 0) await rebuildIndex()
	return matches.length
}

/**
 * Find memories whose name or description contains the query (case-insensitive
 * substring). Used by `/forget <topic>` to disambiguate before delete.
 */
export async function findMemories(query: string): Promise<Memory[]> {
	const q = query.toLowerCase().trim()
	if (!q) return []
	const memories = await listMemories()
	return memories.filter(
		(m) => m.name.toLowerCase().includes(q) || m.description.toLowerCase().includes(q),
	)
}

// Minimal bilingual (EN + FR) stop-word list for memory relevance scoring.
// Kept short on purpose: aggressive stop-word filtering throws away signal
// on a small corpus. Tokens shorter than 3 chars are also dropped by the
// tokenizer, so most function words ("a", "an", "le", "la", "de") never
// reach the filter — this list catches the longer ones.
const MEMORY_STOPWORDS = new Set<string>([
	// English
	"the", "and", "for", "with", "from", "this", "that", "these", "those",
	"are", "was", "were", "have", "has", "had", "but", "not", "you", "your",
	"yours", "they", "them", "their", "what", "when", "where", "which",
	"who", "whom", "how", "why", "into", "over", "under", "than", "then",
	"there", "here", "about", "would", "could", "should", "will", "shall",
	// French
	"les", "des", "une", "aux", "que", "qui", "quoi", "dont", "pour", "par",
	"mais", "donc", "car", "avec", "sans", "sous", "sur", "vers", "chez",
	"être", "etre", "avoir", "fait", "faire", "cette", "cela", "ceux",
	"leur", "leurs", "nous", "vous", "ils", "elles", "elle",
])

/**
 * Tokenize a string for memory relevance scoring: lowercase, split on
 * non-alphanumeric (Unicode letters + digits), drop tokens shorter than
 * 3 chars and stop-words. Pure / no side effects.
 */
export function tokenizeForRelevance(text: string): string[] {
	if (!text) return []
	const lowered = text.toLowerCase()
	// \p{L}+ catches accented French letters; \d+ catches digits.
	const raw = lowered.split(/[^\p{L}\d]+/u).filter(Boolean)
	const out: string[] = []
	for (const tok of raw) {
		if (tok.length < 3) continue
		if (MEMORY_STOPWORDS.has(tok)) continue
		out.push(tok)
	}
	return out
}

/**
 * Score a memory against a tokenized user prompt. Returns a value in
 * [0, 1]: the number of distinct prompt tokens that appear in the
 * memory's (description + body), normalized by the prompt token count.
 * Returns 0 when the prompt is empty (caller should fall back to date
 * sort in that case).
 */
export function scoreMemoryRelevance(memory: Memory, promptTokens: string[]): number {
	if (promptTokens.length === 0) return 0
	const memTokens = new Set(tokenizeForRelevance(memory.description + " " + memory.body))
	if (memTokens.size === 0) return 0
	let hits = 0
	const seen = new Set<string>()
	for (const tok of promptTokens) {
		if (seen.has(tok)) continue
		seen.add(tok)
		if (memTokens.has(tok)) hits += 1
	}
	// Normalize by distinct prompt tokens; gives a clean [0, 1] score
	// that's comparable across memories of different sizes.
	return hits / seen.size
}

/**
 * Rebuild the human-readable MEMORY.md index. One line per memory:
 * `- [name](relative-path) — description (type, scope)`.
 * Called after every save/delete so the index never drifts.
 */
async function rebuildIndex(): Promise<void> {
	const memories = await listMemories()
	const lines: string[] = [
		"# Memory Index",
		"",
		`_Generated ${new Date().toISOString()} — do not edit by hand._`,
		"",
	]
	if (memories.length === 0) {
		lines.push("_No memories yet. Use `/remember <topic>` to add one._")
	} else {
		for (const m of memories) {
			const rel = path.relative(MEMORY_ROOT, m.filePath)
			lines.push(`- [${m.name}](${rel}) — ${m.description} (${m.type}, ${m.scope})`)
		}
	}
	lines.push("")
	await fs.writeFile(INDEX_FILE, lines.join("\n"), "utf-8")
}

/**
 * Return the root memory directory. Exposed for testing + tooling.
 */
export function getMemoryRoot(): string {
	return MEMORY_ROOT
}

/**
 * Derive a project-scope slug from a working directory path. Strategy:
 * basename(cwd) lowercased, non-alphanumeric → "-", trimmed. Same
 * algorithm as Claude Code's project memory layout, so a user who runs
 * `ailiance-agent` from /Users/x/Documents/my-app gets scope
 * `project:my-app` regardless of whether they ran it from a subdirectory.
 *
 * Returns null when cwd is empty / unparseable — caller should fall back
 * to global-only memory injection.
 */
export function projectScopeFromCwd(cwd: string | undefined): MemoryScope | null {
	if (!cwd) return null
	const base = path.basename(cwd).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "")
	if (!base) return null
	return `project:${base}` as MemoryScope
}

const MEMORY_BUDGET_CHARS = 8_000 // ~2000 tokens at ~4 chars/token average

/**
 * Load global + project-scoped memories for a given cwd, sorted by
 * relevance (project memories first, then global, both newest-first
 * within each bucket). Truncates the combined output at
 * MEMORY_BUDGET_CHARS so an unbounded memory store cannot dominate the
 * system prompt.
 *
 * Returns null when no memories are present or the directory is empty.
 * Callers should treat null as "skip the section entirely" — the
 * placeholder mechanism in PromptBuilder leaves the section empty so
 * the system prompt does not show a stale "USER MEMORIES" header.
 */
export async function loadRelevantMemories(
	cwd?: string,
	userPrompt?: string,
): Promise<{
	memories: Memory[]
	totalChars: number
	truncated: boolean
} | null> {
	const projectScope = projectScopeFromCwd(cwd)
	const globalList = await listMemories({ scope: "global" })
	const projectList = projectScope ? await listMemories({ scope: projectScope }) : []
	// Project memories rank higher than global; both sub-lists are
	// already newest-first from listMemories().
	let combined = [...projectList, ...globalList]
	if (combined.length === 0) return null
	// When a user prompt is provided, re-rank by token-overlap relevance.
	// Project-vs-global bucket bias is preserved by adding a small bonus
	// to project-scoped memories so a barely-matching global doesn't jump
	// ahead of an equally-matching project memory. When no memory matches
	// at all (max score == 0), we fall back gracefully to the original
	// project-first / newest-first order.
	const promptTokens = userPrompt ? tokenizeForRelevance(userPrompt) : []
	if (promptTokens.length > 0) {
		const scored = combined.map((m, idx) => {
			const base = scoreMemoryRelevance(m, promptTokens)
			const projectBonus = m.scope !== "global" ? 0.05 : 0
			return { m, score: base + projectBonus, base, idx }
		})
		const anyHit = scored.some((s) => s.base > 0)
		if (anyHit) {
			scored.sort((a, b) => {
				if (b.score !== a.score) return b.score - a.score
				// Tie-break: keep the original combined-list order, which is
				// project-first then newest-first within each bucket.
				return a.idx - b.idx
			})
			combined = scored.map((s) => s.m)
		}
		// else: leave combined as-is (project-first, newest-first)
	}
	const included: Memory[] = []
	let totalChars = 0
	let truncated = false
	for (const m of combined) {
		// 64 chars overhead per entry for the markdown header line, scope
		// tag, separator. Approximation, not exact.
		const entrySize = 64 + m.description.length + m.body.length
		if (totalChars + entrySize > MEMORY_BUDGET_CHARS) {
			truncated = true
			break
		}
		included.push(m)
		totalChars += entrySize
	}
	if (included.length === 0) return null
	return { memories: included, totalChars, truncated }
}

/**
 * Render the loaded memories as a markdown section ready to splice into
 * the system prompt. Each memory becomes a `### <name>` heading with the
 * description as a sub-line and the body verbatim. Returns the empty
 * string when there is nothing to inject — the caller can drop the
 * placeholder cleanly.
 */
export function formatMemoriesSection(loaded: {
	memories: Memory[]
	truncated: boolean
} | null): string {
	if (!loaded || loaded.memories.length === 0) return ""
	const lines: string[] = [
		"",
		"====",
		"",
		"# USER MEMORIES",
		"",
		"The following memories were saved by the user across previous sessions.",
		"Treat them as durable user preferences and project context. Apply them",
		"silently when relevant; do not echo them back in responses.",
		"",
	]
	for (const m of loaded.memories) {
		lines.push(`## ${m.name} (${m.type}, ${m.scope})`)
		lines.push(`_${m.description}_`)
		lines.push("")
		lines.push(m.body)
		lines.push("")
	}
	if (loaded.truncated) {
		lines.push("_(some memories truncated to respect the system-prompt budget)_")
		lines.push("")
	}
	return lines.join("\n")
}
