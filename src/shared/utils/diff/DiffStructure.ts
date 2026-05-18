import type { DiffBlock } from "./DiffComputer"

/**
 * v0.6 Sprint 1-C: Lightweight, host-side structured diff that travels with
 * `editSummaries[]` over the JSON `ExtensionMessage` channel. Distinct from
 * the proto-generated `DiffStructure` in `src/shared/proto/host/diff.ts`,
 * which is reserved for a future strict gRPC transport.
 *
 * Surfaces (CLI Ink renderer, webview React renderer) consume this single
 * source of truth instead of recomputing from the textual diff.
 */
export interface DiffStructure {
	path: string
	totalAdditions: number
	totalDeletions: number
	blocks: DiffBlock[]
}
