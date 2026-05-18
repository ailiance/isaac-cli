import { ToolUse } from "@core/assistant-message"
import { ToolResponse } from "../../../index"

export interface Edit {
	anchor: string
	end_anchor?: string
	edit_type?: "replace" | "insert_after" | "insert_before"
	text: string
}

export interface FileEdit {
	path: string
	edits: Edit[]
}

export interface ResolvedEdit {
	lineIdx: number
	endIdx: number
	edit: Edit
}

export interface FuzzyCandidate {
	/** Which side of the edit this candidate is for. */
	type: "anchor" | "end_anchor"
	/** Anchor name (e.g. "Banana") that triggered the lookup. */
	anchorName: string
	/** Content the model provided alongside the anchor. */
	provided: string
	/** 0-based index of the actual line the file currently has. */
	actualLineIdx: number
	/** Actual content at `actualLineIdx`. */
	actualContent: string
	/** Levenshtein-normalized similarity in [0, 1]. */
	similarity: number
}

export interface FailedEdit {
	edit: Edit
	error: string
	/** Per-anchor fuzzy match candidates (≥ threshold). At most one per side. */
	fuzzyCandidates?: FuzzyCandidate[]
}

export interface AppliedEdit {
	startIdx: number
	endIdx: number
	originalStartIdx: number
	originalEndIdx: number
	edit: Edit
	linesAdded: number
	linesDeleted: number
}

export interface PreparedEdits {
	content: string
	finalContent: string
	diff: string
	resolvedEdits: ResolvedEdit[]
	failedEdits: FailedEdit[]
	appliedEdits: AppliedEdit[]
	lines: string[]
	lineHashes: string[]
	finalLines: string[]
	displayPath: string
}

export interface PreparedFileBatch {
	wasStringified?: boolean
	absolutePath: string
	displayPath: string
	prepared?: PreparedEdits
	blocks: ToolUse[]
	error?: ToolResponse
	diagnostics?: { fixedCount: number; newProblemsMessage: string }
}
