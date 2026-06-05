import { Mode } from "../storage/types"

export interface IsaacMessageModelInfo {
	modelId: string
	providerId: string
	mode: Mode
}

interface IsaacTokensInfo {
	prompt: number // Total input tokens (includes cached + non-cached)
	completion: number // Total output tokens
	reasoning?: number // Subset of completion_tokens that were reasoning tokens
	cached: number // Subset of prompt_tokens that were cache hits
}

export interface IsaacMessageMetricsInfo {
	tokens?: IsaacTokensInfo
	cost?: number // Monetary cost for this turn
}
