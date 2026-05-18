/**
 * Pure pagination helpers for read_file. Kept in a standalone module — with no
 * I/O or host imports — so the slicing logic can be unit-tested in isolation
 * from ReadFileToolHandler's heavy dependency graph.
 */

/** Pagination mode resolved from a read_file block's parameters. */
export interface PaginationSpec {
	startLineNum?: number
	endLineNum?: number
	offsetNum?: number
	limitNum?: number
}

/**
 * Slices `content` according to a {@link PaginationSpec}.
 *
 *   - line range: `start_line`/`end_line` are 1-based and inclusive.
 *   - offset/limit: `offset` is 0-based, `limit` is a count.
 *   - no pagination params: the content is returned unchanged.
 *
 * Out-of-range bounds are clamped, so an offset past the end yields an empty
 * slice rather than throwing. When both pagination styles are present the line
 * range wins (mutual exclusion is enforced upstream by the handler).
 */
export function sliceContentLines(content: string, spec: PaginationSpec): string {
	const hasLineRange = spec.startLineNum !== undefined || spec.endLineNum !== undefined
	const hasOffsetLimit = spec.offsetNum !== undefined || spec.limitNum !== undefined

	if (hasLineRange) {
		const lines = content.split("\n")
		const start = Math.max(0, (spec.startLineNum || 1) - 1)
		const end = Math.min(lines.length, spec.endLineNum || lines.length)
		return lines.slice(start, end).join("\n")
	}
	if (hasOffsetLimit) {
		const lines = content.split("\n")
		const start = Math.max(0, spec.offsetNum ?? 0)
		const end = spec.limitNum !== undefined ? Math.min(lines.length, start + spec.limitNum) : lines.length
		return lines.slice(start, end).join("\n")
	}
	return content
}
