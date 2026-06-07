// src/services/memory/dreaming/wire.ts
//
// Factory that assembles the real DreamDeps from production services:
//   - run scanning over <root>/.ailiance-agent/runs/ (TRACING_DIR_NAME)
//   - transcript condensation (condenseRun)
//   - existing-memory listing + saving (ailiance-memory)
//   - LLM synthesis via buildApiHandler with thinking disabled
//
// Lives in core (src/services/) so it must not import CLI code. `disableThinking`
// is a private helper in cli/src/agent/review.ts; we replicate its trivial body
// here (set both thinking budgets to 0) rather than reach across the layer.

import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { buildApiHandler } from "@/core/api"
import { TRACING_DIR_NAME } from "@/core/tracing/JsonlTracer"
import type { ApiConfiguration } from "@/shared/api"
import type { Mode } from "@/shared/storage/types"
import type { MemoryType } from "@/utils/ailiance-memory"
import { listMemories, projectScopeFromCwd, saveMemory } from "@/utils/ailiance-memory"
import type { DreamDeps, RunRef } from "./DreamWorker"
import { synthesizeMemories } from "./MemorySynthesizer"
import { condenseRun } from "./transcriptReader"

const CURSOR_FILE = path.join(os.homedir(), ".ailiance-agent", "memory", ".dream-cursor.json")

/** Replicates cli/src/agent/review.ts:disableThinking (private there). */
function disableThinking(apiConfiguration: ApiConfiguration): ApiConfiguration {
	return {
		...apiConfiguration,
		actModeThinkingBudgetTokens: 0,
		planModeThinkingBudgetTokens: 0,
	}
}

/** Scan one root's `.ailiance-agent/runs/` directory into RunRefs. */
async function listRunsForRoot(root: string): Promise<RunRef[]> {
	const scope = projectScopeFromCwd(root)
	// projectScopeFromCwd returns `project:<slug>`; the cursor keys on the bare slug.
	const projectKey = scope ? scope.replace(/^project:/, "") : path.basename(root)
	const runsRoot = path.join(root, TRACING_DIR_NAME)
	let entries: string[] = []
	try {
		const dirents = await fs.readdir(runsRoot, { withFileTypes: true })
		entries = dirents.filter((d) => d.isDirectory()).map((d) => d.name)
	} catch {
		// no runs directory for this root yet
		return []
	}
	return entries.map((taskId) => ({
		projectKey,
		taskId,
		runDir: path.join(runsRoot, taskId),
	}))
}

/**
 * Build the production DreamDeps.
 *
 * @param getApiConfig lazily resolves the current API configuration
 * @param getMode lazily resolves the current mode ("plan" | "act")
 * @param searchRoots directories whose `.ailiance-agent/runs/` are scanned
 */
export function buildDreamDeps(getApiConfig: () => ApiConfiguration, getMode: () => Mode, searchRoots: string[]): DreamDeps {
	return {
		cursorFile: CURSOR_FILE,
		listRuns: async () => {
			const all: RunRef[] = []
			for (const root of searchRoots) {
				all.push(...(await listRunsForRoot(root)))
			}
			return all
		},
		condense: (runDir) => condenseRun(runDir),
		listExisting: () => listMemories({}),
		synthesize: async (condensed, existing) => {
			const handler = buildApiHandler(disableThinking(getApiConfig()), getMode())
			return synthesizeMemories(condensed, existing, {
				createMessage: (sys, content) => handler.createMessage(sys, [{ role: "user", content }]),
			})
		},
		save: async (c) => {
			await saveMemory({
				name: c.name,
				description: c.description,
				type: c.type as MemoryType,
				scope: c.scope === "global" ? "global" : (c.scope as `project:${string}`),
				body: c.body,
				source: "dreamed",
				lastSeenAt: new Date().toISOString(),
			})
		},
	}
}
