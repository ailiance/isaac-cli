export type ConflictDecision = "keep-local" | "keep-remote" | "side-dir"

export interface ConflictContext {
	localDir: string
	remoteDir: string
	host: string
	sessionId: string
}

export type ConflictResolver = (conflicts: string[], ctx: ConflictContext) => Promise<Map<string, ConflictDecision>>

/** Default headless-safe resolver: never overwrite a locally-changed file; remote copy goes to a side-dir. */
export const sideDirResolver: ConflictResolver = async (conflicts) => {
	const m = new Map<string, ConflictDecision>()
	for (const c of conflicts) {
		m.set(c, "side-dir")
	}
	return m
}
