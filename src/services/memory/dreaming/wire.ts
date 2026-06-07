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
import { deleteMemoryExact, listMemories, projectScopeFromCwd, saveMemory } from "@/utils/ailiance-memory"
import { embedText } from "../embeddings/embedClient"
import { embedConfigFromEnv } from "../embeddings/embedEnvConfig"
import { EMBEDDINGS_INDEX_FILE, loadIndex, saveIndex } from "../embeddings/vectorIndex"
import type { DreamDeps, RunRef } from "./DreamWorker"
import { isStale } from "./decay"
import { synthesizeMemories } from "./MemorySynthesizer"
import { condenseRun } from "./transcriptReader"

/**
 * Injectable embedding hooks for `buildDreamDeps`. Defaults wire the real
 * gateway embed + sidecar index; tests inject fakes so the indexing path is
 * exercised without network or real filesystem. Gating is unchanged: when
 * `embedConfigFromEnv()` returns null (default, ISAAC_MEM_EMBEDDINGS !== "1")
 * none of these are ever called and `save` is byte-identical to before.
 */
export interface EmbedHooks {
	embed: typeof embedText
	loadIndex: typeof loadIndex
	saveIndex: typeof saveIndex
	indexFile: string
	env: NodeJS.ProcessEnv
}

const DEFAULT_EMBED_HOOKS: EmbedHooks = {
	embed: embedText,
	loadIndex,
	saveIndex,
	indexFile: EMBEDDINGS_INDEX_FILE,
	env: process.env,
}

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
export function buildDreamDeps(
	getApiConfig: () => ApiConfiguration,
	getMode: () => Mode,
	searchRoots: string[],
	embedHooks: EmbedHooks = DEFAULT_EMBED_HOOKS,
): DreamDeps {
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
			// Best-effort index-on-save, gated behind ISAAC_MEM_EMBEDDINGS.
			// Default OFF ⇒ embedConfigFromEnv() === null ⇒ no embed, no index
			// write — identical to before. A failure here never aborts the save.
			const cfg = embedConfigFromEnv(embedHooks.env)
			if (cfg) {
				try {
					const v = await embedHooks.embed(c.body, cfg)
					if (v) {
						const idx = await embedHooks.loadIndex(embedHooks.indexFile)
						idx[c.name] = { vector: v, scope: String(c.scope) }
						await embedHooks.saveIndex(embedHooks.indexFile, idx)
					}
				} catch {
					// indexing is best-effort; the memory was already saved
				}
			}
		},
		// Re-save an existing memory with a fresh lastSeenAt so re-confirmed
		// entries survive the TTL sweep. Re-uses saveMemory (overwrites by name+scope).
		bump: async (name) => {
			const all = await listMemories({})
			const m = all.find((x) => x.name === name)
			if (!m) {
				return
			}
			await saveMemory({
				name: m.name,
				description: m.description,
				type: m.type,
				scope: m.scope,
				body: m.body,
				source: m.source,
				lastSeenAt: new Date().toISOString(),
			})
		},
		// TTL sweep: delete memories whose freshness exceeds MEMORY_TTL_DAYS.
		expire: async () => {
			const all = await listMemories({})
			for (const m of all) {
				if (isStale(m)) {
					// Scope-precise delete: a stale entry in one scope must not
					// clobber a fresh same-name entry in another scope.
					await deleteMemoryExact(m.name, m.scope)
				}
			}
		},
	}
}
