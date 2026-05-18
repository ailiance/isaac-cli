import { ToolUse } from "@core/assistant-message";
import { splitAnchor, stripHashes, getDelimiter } from "@utils/line-hashing";
import { AppliedEdit, Edit, FailedEdit, FuzzyCandidate, ResolvedEdit } from "./types";

/**
 * Threshold for the fuzzy fallback: only candidates with normalized
 * Levenshtein similarity ≥ this value trigger a user approval prompt.
 *
 * Rationale: 0.85 keeps false positives low (random refactors with
 * shared keywords usually score 0.5–0.7) while still catching the
 * realistic failure mode of "model echoed an outdated version of the
 * line" (whitespace + 1–2 token churn typically scores 0.88–0.96).
 *
 * Not user-configurable in this sprint — see Sprint 3 task D notes.
 */
export const FUZZY_MATCH_THRESHOLD = 0.85

/**
 * How the line content provided alongside an anchor is compared to the actual
 * line in the file.
 *
 * - "strict"     — exact byte-for-byte equality (legacy behaviour, used for
 *                   regression tests and some diagnostic helpers).
 * - "normalized" — ignore CRLF, leading/trailing whitespace differences. Used
 *                   by default to avoid silent "anchor not found" failures
 *                   when the model echoes the line with cosmetic differences
 *                   (tabs vs spaces, trailing newline, indent variation, …).
 *
 * Internal-only setting. Exposed via constructor for tests; not surfaced to
 * the LLM. The actual edit is always applied against the *real* line in the
 * file (anchors locate by line index, not by content).
 */
export type AnchorMatchMode = "strict" | "normalized"

/**
 * Normalize a line for whitespace-tolerant equality.
 *
 * Decision (see edit-file CLAUDE.md / Sprint 3 audit):
 * - drop trailing CR (CRLF noise),
 * - trim leading and trailing whitespace.
 *
 * We deliberately do NOT collapse internal whitespace runs: that would mask
 * real bugs (e.g. a missing space inside a literal string, or a deliberately
 * rewritten signature). Indent and EOL differences are the real-world failure
 * modes; collapsing internal spaces is too aggressive.
 */
function normalizeLineForMatch(line: string): string {
	return line.replace(/\r$/, "").trim()
}

/**
 * Levenshtein distance between two strings — classic two-row DP.
 * Inlined (~25 lines) to avoid pulling `leven` as a direct dep; the
 * package only ships in node_modules transitively today.
 */
function levenshtein(a: string, b: string): number {
	if (a === b) return 0
	if (a.length === 0) return b.length
	if (b.length === 0) return a.length
	let prev = new Array(b.length + 1)
	let curr = new Array(b.length + 1)
	for (let j = 0; j <= b.length; j++) prev[j] = j
	for (let i = 1; i <= a.length; i++) {
		curr[0] = i
		const ai = a.charCodeAt(i - 1)
		for (let j = 1; j <= b.length; j++) {
			const cost = ai === b.charCodeAt(j - 1) ? 0 : 1
			curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost)
		}
		const tmp = prev
		prev = curr
		curr = tmp
	}
	return prev[b.length]
}

/**
 * Levenshtein-based similarity in [0, 1] — 1 = identical, 0 = completely
 * different. Used by the fuzzy fallback (Sprint 3 task D) for high-confidence
 * single-line matches. Operates on normalized lines so that whitespace
 * variations don't depress the score below threshold.
 */
function levenshteinSimilarity(a: string, b: string): number {
	const an = normalizeLineForMatch(a)
	const bn = normalizeLineForMatch(b)
	if (an === bn) return 1
	const maxLen = Math.max(an.length, bn.length)
	if (maxLen === 0) return 1
	return 1 - levenshtein(an, bn) / maxLen
}

/**
 * Cheap similarity score in [0, 1] used only for diagnostic hints when an
 * anchor lookup fails. Token-set Jaccard on whitespace-split tokens — fast,
 * good enough to surface "you probably meant line N".
 */
function similarity(a: string, b: string): number {
	const an = normalizeLineForMatch(a)
	const bn = normalizeLineForMatch(b)
	if (an === bn) return 1
	if (!an && !bn) return 1
	if (!an || !bn) return 0
	const at = new Set(an.split(/\s+/).filter(Boolean))
	const bt = new Set(bn.split(/\s+/).filter(Boolean))
	if (at.size === 0 && bt.size === 0) return 1
	let inter = 0
	for (const t of at) if (bt.has(t)) inter++
	const union = at.size + bt.size - inter
	return union === 0 ? 0 : inter / union
}

export class EditExecutor {
	constructor(private readonly matchMode: AnchorMatchMode = "normalized") {}

	resolveEdits(
		blocks: ToolUse[],
		lines: string[],
		lineHashes: string[],
	): { resolvedEdits: ResolvedEdit[]; failedEdits: FailedEdit[] } {
		const failedEdits: FailedEdit[] = []
		const resolvedEdits: ResolvedEdit[] = []
		const normalizedLineHashes = lineHashes.map((h) => h.trim())

		for (const block of blocks) {
			const edits = (block.params.edits as Edit[]) || []
			for (const edit of edits) {
				const diagnostics: string[] = []
				const fuzzyCandidates: FuzzyCandidate[] = []
				const editType = edit.edit_type

				const startResult = this.resolveAnchor("anchor", edit.anchor, normalizedLineHashes, lines)
				const lineIdx = startResult.index
				if (startResult.error) diagnostics.push(startResult.error)
				if (startResult.fuzzyCandidate) fuzzyCandidates.push(startResult.fuzzyCandidate)

				let endIdx = lineIdx
				if (editType === "replace") {
					const endResult = this.resolveAnchor("end_anchor", edit.end_anchor, normalizedLineHashes, lines)
					if (endResult.error) diagnostics.push(endResult.error)
					if (endResult.fuzzyCandidate) fuzzyCandidates.push(endResult.fuzzyCandidate)
					endIdx = endResult.index
				}

				if (lineIdx !== -1 && endIdx !== -1 && endIdx < lineIdx) {
					diagnostics.push("Range error: anchor must refer to a line that precedes or is the same as end_anchor.")
				}

				if (diagnostics.length > 0) {
					const failed: FailedEdit = { edit, error: diagnostics.join(" ") }
					if (fuzzyCandidates.length > 0) failed.fuzzyCandidates = fuzzyCandidates
					failedEdits.push(failed)
				} else {
					resolvedEdits.push({ lineIdx, endIdx, edit })
				}
			}
		}
		return { resolvedEdits, failedEdits }
	}

	resolveAnchor(
		type: "anchor" | "end_anchor",
		rawAnchor: string | undefined,
		normalizedLineHashes: string[],
		lines: string[],
	): { index: number; error?: string; fuzzyCandidate?: FuzzyCandidate } {
		const anchorRaw = rawAnchor || ""
		if (!anchorRaw.trim()) return { index: -1, error: `${type} is missing.` }

		const { anchor: anchorName, content: providedContent } = splitAnchor(anchorRaw)

		// 1. Check if the anchor name is valid (starts with a capital letter, letters only)
		const anchorExtractRegex = /^[A-Z][a-zA-Z]*$/
		if (!anchorExtractRegex.test(anchorName)) {
			return {
				index: -1,
				error: `${type} is missing or incorrectly formatted. It must start with a single word followed by the delimiter (e.g., "Apple${getDelimiter()}").`,
			}
		}

		// 2. Check if the anchor exists in the file
		const index = normalizedLineHashes.indexOf(anchorName)
		if (index === -1) {
			return {
				index: -1,
				error: `${type} "${anchorName}" not found in the file. Please ensure you are using the latest anchors from the most recent read tool output.`,
			}
		}

		// 3. Check for newlines in the provided code line
		if (providedContent.includes("\n") || providedContent.includes("\r")) {
			return {
				index: -1,
				error: `${type} "${anchorName}" exists, but the provided code line contains a newline character. Anchors must refer to a single line only in the format Anchor${getDelimiter()}{line_text}.`,
			}
		}

		// 4. Check if the code line matches the file's content.
		//    The actual edit always uses the file's real line (anchors locate by
		//    index, not by the provided content), so we may safely accept a
		//    whitespace-tolerant match here.
		const actualContent = lines[index]
		const matches =
			this.matchMode === "strict"
				? providedContent === actualContent
				: normalizeLineForMatch(providedContent) === normalizeLineForMatch(actualContent)

		if (!matches) {
			// Strict / normalized lookup failed. Compute a Levenshtein-based fuzzy
			// score against the line at the anchor's index — if it's high enough,
			// the BatchProcessor will surface a per-anchor approval prompt
			// (Sprint 3 task D).
			const fuzzyScore = levenshteinSimilarity(providedContent, actualContent)
			const result: { index: number; error?: string; fuzzyCandidate?: FuzzyCandidate } = {
				index: -1,
				error: this.formatContentMismatch(type, anchorName, providedContent, actualContent, lines),
			}
			if (fuzzyScore >= FUZZY_MATCH_THRESHOLD) {
				result.fuzzyCandidate = {
					type,
					anchorName,
					provided: providedContent,
					actualLineIdx: index,
					actualContent,
					similarity: fuzzyScore,
				}
			}
			return result
		}

		return { index }
	}

	/**
	 * Re-resolve a previously failed edit, treating approved fuzzy candidates as
	 * if their content had matched. Used by BatchProcessor after the user
	 * accepts the fuzzy approval prompt (Sprint 3 task D).
	 *
	 * Returns null if the edit cannot be resolved even with the approvals (e.g.
	 * a non-fuzzy diagnostic still applies, or end < start).
	 */
	resolveFuzzyEdit(
		failed: FailedEdit,
		approvedCandidates: Map<"anchor" | "end_anchor", FuzzyCandidate>,
		normalizedLineHashes: string[],
		lines: string[],
	): ResolvedEdit | null {
		const editType = failed.edit.edit_type

		const startApproved = approvedCandidates.get("anchor")
		const startResult = startApproved
			? { index: startApproved.actualLineIdx }
			: this.resolveAnchor("anchor", failed.edit.anchor, normalizedLineHashes, lines)
		const lineIdx = startResult.index
		if (lineIdx === -1) return null

		let endIdx = lineIdx
		if (editType === "replace") {
			const endApproved = approvedCandidates.get("end_anchor")
			const endResult = endApproved
				? { index: endApproved.actualLineIdx }
				: this.resolveAnchor("end_anchor", failed.edit.end_anchor, normalizedLineHashes, lines)
			if (endResult.index === -1) return null
			endIdx = endResult.index
			if (endIdx < lineIdx) return null
		}
		return { lineIdx, endIdx, edit: failed.edit }
	}

	/**
	 * Build a diagnostic when the anchor's line content does not match.
	 *
	 * Format (actionable, parseable by humans and the model):
	 *
	 *   Edit anchor "<Name>" exists, but the line content does not match.
	 *   Provided: "<line_provided>"
	 *   Expected: "<line_actual>"
	 *   Closest other match in file (line <N>, similarity 0.85): "<line_actual_2>"
	 *   Suggestion: re-read the file to refresh anchors before editing.
	 */
	private formatContentMismatch(
		type: "anchor" | "end_anchor",
		anchorName: string,
		providedContent: string,
		actualContent: string,
		lines: string[],
	): string {
		// Find closest other line by similarity. Skip the anchor's own line.
		let bestIdx = -1
		let bestScore = 0
		for (let i = 0; i < lines.length; i++) {
			if (lines[i] === actualContent && i === lines.indexOf(actualContent)) continue
			const score = similarity(lines[i], providedContent)
			if (score > bestScore) {
				bestScore = score
				bestIdx = i
			}
		}

		const base =
			`${type} "${anchorName}" exists, but the code line you provided does not match the file's content. ` +
			`Expected: "${actualContent}", Provided: "${providedContent}".`

		if (bestScore >= 0.5 && bestIdx !== -1) {
			return (
				`${base} Closest other match in file at line ${bestIdx + 1} ` +
				`(similarity ${bestScore.toFixed(2)}): "${lines[bestIdx]}". ` +
				`Suggestion: re-read the file to refresh anchors before editing.`
			)
		}
		return `${base} No close match found elsewhere — the file may have changed; re-read it before retrying.`
	}

	applyEdits(
		lines: string[],
		resolvedEdits: ResolvedEdit[],
	): { finalLines: string[]; addedCount: number; removedCount: number; appliedEdits: AppliedEdit[] } {
		const sortedEdits = [...resolvedEdits].sort((a, b) => b.lineIdx - a.lineIdx)
		const newLines = [...lines]
		let addedCount = 0
		let removedCount = 0
		const changes: Array<{
			originalLineIdx: number
			replacementCount: number
			removedCount: number
			edit: Edit
		}> = []

		for (const { lineIdx, endIdx, edit } of sortedEdits) {
			const editType = edit.edit_type
			const cleanText = stripHashes(edit.text || "")
			const replacementLines = cleanText === "" ? [] : cleanText.split(/\r?\n/)

			let removedInThisEdit: number
			let spliceIndex: number

			if (editType === "insert_after") {
				spliceIndex = lineIdx + 1
				removedInThisEdit = 0
			} else if (editType === "insert_before") {
				spliceIndex = lineIdx
				removedInThisEdit = 0
			} else {
				// replace
				spliceIndex = lineIdx
				removedInThisEdit = endIdx - lineIdx + 1
			}

			newLines.splice(spliceIndex, removedInThisEdit, ...replacementLines)
			addedCount += replacementLines.length
			removedCount += removedInThisEdit
			changes.push({
				originalLineIdx: lineIdx,
				replacementCount: replacementLines.length,
				removedCount: removedInThisEdit,
				edit,
			})
		}

		const appliedEdits: AppliedEdit[] = changes.map((change) => {
			let shift = 0
			for (const other of changes) {
				if (other.originalLineIdx < change.originalLineIdx) {
					shift += other.replacementCount - other.removedCount
				}
			}
			return {
				startIdx: change.originalLineIdx + shift,
				endIdx: change.originalLineIdx + shift + change.replacementCount - 1,
				originalStartIdx: change.originalLineIdx,
				originalEndIdx: change.originalLineIdx + change.removedCount - 1,
				edit: change.edit,
				linesAdded: change.replacementCount,
				linesDeleted: change.removedCount,
			}
		})

		return { finalLines: newLines, addedCount, removedCount, appliedEdits }
	}

	formatFailureMessage(edit: Edit, error?: string): string {
		const diagnostic = error
			? ` Diagnostics: ${error}`
			: " This almost certainly is because the anchors used were incorrect or not in ascending order or the text supplied was incorrect. please check again edit again"
		return `Edit (anchor: "${edit.anchor}", end_anchor: "${edit.end_anchor}") failed.${diagnostic}`
	}
}
