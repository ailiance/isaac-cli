import type { ActiveMcpToolSet } from "./ActiveMcpToolSet"

let current: ActiveMcpToolSet | undefined

export function setActiveMcpToolSet(set: ActiveMcpToolSet | undefined): void {
	current = set
}

export function getActiveMcpToolSet(): ActiveMcpToolSet | undefined {
	return current
}

/**
 * Publish an EMPTY, embedder-dead active set so the gate emits ZERO MCP tools.
 * Called on task teardown to prevent the previous task's active set from
 * leaking into the next task's first request (before that task republishes).
 * Using an empty set (not `undefined`) is deliberate: `undefined` makes the
 * gate emit ALL MCP tools, whereas an empty set is the safe between-tasks state.
 */
export async function clearActiveMcpToolSet(): Promise<void> {
	const { ActiveMcpToolSet } = await import("./ActiveMcpToolSet")
	const { Embedder } = await import("./Embedder")
	const { getRetrievalConfig } = await import("./config")
	const dead = new Embedder(async () => {
		throw new Error("retrieval cleared")
	})
	current = new ActiveMcpToolSet(dead, new Map(), getRetrievalConfig())
}
