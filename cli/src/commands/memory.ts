// ISAAC: /remember /forget /memories slash commands
//
// Surface the src/utils/ailiance-memory CRUD layer via CLI subcommands so
// the user can manage cross-task memory from the terminal. Auto-injection
// at turn-1 of new tasks is a separate concern (touches system prompt
// assembly) and deferred to a follow-up PR.
//
// Usage:
//   isaac memory remember "user role" "data scientist focused on observability"
//   isaac memory list
//   isaac memory list --type feedback
//   isaac memory show <name>
//   isaac memory forget <name>

import { exit } from "node:process"
import {
	deleteMemory,
	findMemories,
	getMemoryRoot,
	listMemories,
	type Memory,
	type MemoryType,
	saveMemory,
} from "@/utils/ailiance-memory"
import { printError, printInfo, printSuccess, printWarning } from "../utils/display"

const VALID_TYPES: MemoryType[] = ["user", "feedback", "project", "reference"]

function classifyTypeFromInput(raw: string | undefined): MemoryType {
	if (!raw) return "user"
	const lower = raw.toLowerCase()
	if ((VALID_TYPES as string[]).includes(lower)) return lower as MemoryType
	return "user"
}

function slugify(title: string): string {
	return (
		title
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 64) || `memory-${Date.now()}`
	)
}

export async function runMemoryRemember(args: { title: string; body?: string; type?: string; scope?: string }): Promise<void> {
	if (!args.title?.trim()) {
		printError("usage: isaac memory remember <title> [body]")
		exit(2)
	}
	const name = slugify(args.title)
	const description = args.title.trim()
	const body = (args.body || description).trim()
	const type = classifyTypeFromInput(args.type)
	const scope = (args.scope?.startsWith("project:") ? args.scope : "global") as "global" | `project:${string}`
	try {
		const filePath = await saveMemory({ name, description, type, scope, body })
		printSuccess(`Saved memory '${name}' (${type}, ${scope})`)
		printInfo(`  ${filePath}`)
	} catch (err) {
		printError(`Failed to save memory: ${err instanceof Error ? err.message : String(err)}`)
		exit(1)
	}
}

export async function runMemoryList(args: { type?: string; scope?: string }): Promise<void> {
	const filter: { type?: MemoryType; scope?: "global" | `project:${string}` } = {}
	if (args.type) {
		if (!(VALID_TYPES as string[]).includes(args.type)) {
			printError(`unknown --type '${args.type}'. Valid: ${VALID_TYPES.join(", ")}`)
			exit(2)
		}
		filter.type = args.type as MemoryType
	}
	if (args.scope) {
		filter.scope = args.scope.startsWith("project:") ? (args.scope as `project:${string}`) : "global"
	}
	const memories = await listMemories(filter)
	if (memories.length === 0) {
		printInfo("No memories yet. Use `isaac memory remember <title>` to add one.")
		printInfo(`Memory root: ${getMemoryRoot()}`)
		return
	}
	printInfo(`${memories.length} memor${memories.length === 1 ? "y" : "ies"} (${getMemoryRoot()}):`)
	for (const m of memories) {
		// Format: name (type, scope) — description
		process.stdout.write(`  ${m.name}  (${m.type}, ${m.scope}) — ${m.description}\n`)
	}
}

export async function runMemoryShow(args: { name: string }): Promise<void> {
	if (!args.name) {
		printError("usage: isaac memory show <name>")
		exit(2)
	}
	const matches = await findMemories(args.name)
	const exact = matches.find((m) => m.name === args.name)
	const m: Memory | undefined = exact ?? matches[0]
	if (!m) {
		printError(`No memory matching '${args.name}'.`)
		exit(1)
	}
	if (!exact && matches.length > 1) {
		printWarning(`Multiple matches; showing '${m.name}'. Disambiguate with the exact name.`)
	}
	process.stdout.write(`name: ${m.name}\n`)
	process.stdout.write(`type: ${m.type}\n`)
	process.stdout.write(`scope: ${m.scope}\n`)
	process.stdout.write(`created: ${m.created}\n`)
	process.stdout.write(`description: ${m.description}\n`)
	process.stdout.write(`\n${m.body}\n`)
}

export async function runMemoryForget(args: { name: string }): Promise<void> {
	if (!args.name) {
		printError("usage: isaac memory forget <name>")
		exit(2)
	}
	// Try exact delete first.
	const exact = await deleteMemory(args.name)
	if (exact > 0) {
		printSuccess(`Forgot ${exact} memor${exact === 1 ? "y" : "ies"} named '${args.name}'.`)
		return
	}
	// Otherwise look for fuzzy matches and report.
	const matches = await findMemories(args.name)
	if (matches.length === 0) {
		printWarning(`No memory matching '${args.name}'.`)
		exit(1)
	}
	printWarning(
		`No exact match for '${args.name}'. Did you mean:\n` + matches.map((m) => `  - ${m.name} — ${m.description}`).join("\n"),
	)
	exit(1)
}
