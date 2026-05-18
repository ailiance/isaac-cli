/**
 * ModelRegistry — maps model ids (substring, case-insensitive) to a tool-call
 * format profile. Used by LocalRouter to choose the right emulation template
 * and parser priority per worker, instead of the binary supportsTools flag.
 *
 * Patterns are matched in registration order (most specific first). The first
 * substring hit wins. Unknown model ids fall back to markdown_fence (safe,
 * compatible with most instruction-tuned models).
 */

export type ToolCallFormat =
	| "openai_native" // worker accepts native OpenAI tool_calls
	| "anthropic_native" // worker accepts native Anthropic <tool_use>
	| "markdown_fence" // ```tool\n{...}\n``` (Gemma, Llama 3)
	| "xml" // <tool_call>{...}</tool_call> (Devstral, Qwen)
	| "json_inline" // {"name": "...", "arguments": {...}} alone on a line (Mistral)
	| "plain_function" // foo("bar") (very basic models)

export interface ToolFormatConstraints {
	/** Max nesting in tool arguments (some models choke beyond 3) */
	maxArgsDepth?: number
	/** Whether the model can chain multiple tool calls in one response */
	supportsParallelCalls?: boolean
	/** Whether tool result must be inlined as user message (vs role:tool) */
	toolResultRole?: "tool" | "user"
}

export interface ModelToolProfile {
	/** Format the worker prefers/accepts */
	format: ToolCallFormat
	/** True if format is native (no system-prompt injection needed) */
	isNative: boolean
	/** Optional behavioral hints */
	constraints?: ToolFormatConstraints
}

interface RegistryEntry {
	pattern: string
	/** Optional override for the substring match — if returns false, skip */
	predicate?: (modelId: string) => boolean
	profile: ModelToolProfile
}

// Order matters: most specific patterns first, generic family fallbacks last.
const REGISTRY: RegistryEntry[] = [
	// ── OpenAI native ──────────────────────────────────────────────────────
	{ pattern: "gpt-", profile: { format: "openai_native", isNative: true } },
	{ pattern: "o1-", profile: { format: "openai_native", isNative: true } },
	{ pattern: "o3-", profile: { format: "openai_native", isNative: true } },
	// ── Anthropic native ────────────────────────────────────────────────────
	{ pattern: "claude", profile: { format: "anthropic_native", isNative: true } },
	// ── DeepSeek (OpenAI-compatible function calling) ──────────────────────
	{ pattern: "deepseek", profile: { format: "openai_native", isNative: true } },
	// ── EuroLLM (native OpenAI function calls per defaults.ts) ──────────────
	{ pattern: "eurollm", profile: { format: "openai_native", isNative: true } },
	// ── Mistral special case: "Medium" supports native; rest is JSON inline ─
	{
		pattern: "mistral-medium",
		profile: { format: "openai_native", isNative: true },
	},
	// Mixtral / Mistral fallback → emulated JSON inline
	{ pattern: "mixtral", profile: { format: "json_inline", isNative: false } },
	{ pattern: "mistral", profile: { format: "json_inline", isNative: false } },
	// ── XML family (Devstral, Qwen) ────────────────────────────────────────
	{ pattern: "devstral", profile: { format: "xml", isNative: false } },
	{ pattern: "qwen", profile: { format: "xml", isNative: false } },
	// ── Markdown-fence family (Gemma, Llama, Apertus) ──────────────────────
	{ pattern: "gemma", profile: { format: "markdown_fence", isNative: false } },
	{ pattern: "llama", profile: { format: "markdown_fence", isNative: false } },
	{ pattern: "apertus", profile: { format: "markdown_fence", isNative: false } },
]

const FALLBACK_PROFILE: ModelToolProfile = {
	format: "markdown_fence",
	isNative: false,
}

/**
 * Resolve a model id to its tool-call profile.
 * Substring match is case-insensitive; first registered hit wins.
 * Falls back to markdown_fence (non-native) when nothing matches.
 */
export function getToolProfile(modelId: string): ModelToolProfile {
	const lower = (modelId ?? "").toLowerCase()
	for (const entry of REGISTRY) {
		if (!lower.includes(entry.pattern)) continue
		if (entry.predicate && !entry.predicate(lower)) continue
		return entry.profile
	}
	return FALLBACK_PROFILE
}

/**
 * Expose the full pattern table — useful for debug UIs and future overrides.
 */
export function listKnownPatterns(): { pattern: string; profile: ModelToolProfile }[] {
	return REGISTRY.map((e) => ({ pattern: e.pattern, profile: e.profile }))
}
