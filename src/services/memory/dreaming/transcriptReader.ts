// src/services/memory/dreaming/transcriptReader.ts
import fs from "node:fs/promises"
import path from "node:path"

export async function condenseRun(runDir: string): Promise<string> {
	const lines: string[] = []
	try {
		const meta = JSON.parse(await fs.readFile(path.join(runDir, "meta.json"), "utf8"))
		lines.push(`TASK: ${meta.task ?? "(unknown)"}`)
		if (meta.cwd) lines.push(`CWD: ${meta.cwd}`)
		if (meta.exit_reason) lines.push(`OUTCOME: ${meta.exit_reason}`)
	} catch {
		// no/corrupt meta
	}
	try {
		const jsonl = await fs.readFile(path.join(runDir, "trace.jsonl"), "utf8")
		for (const raw of jsonl.split("\n")) {
			if (!raw.trim()) continue
			let t: any
			try {
				t = JSON.parse(raw)
			} catch {
				continue
			}
			const tool = t.tool_execution?.tool_name
			if (tool) lines.push(`turn ${t.turn}: tool ${tool}${t.tool_execution.success === false ? " (failed)" : ""}`)
			if (Array.isArray(t.errors) && t.errors.length) lines.push(`turn ${t.turn}: errors ${t.errors.join("; ")}`)
		}
	} catch {
		// no trace
	}
	return lines.join("\n")
}
