// ailiance-agent: parser for hallucinated XML tool-call format
//
// Background: some workers (Mistral-Medium-128B on MLX in particular)
// receive a request with tools[] but their backend does not support
// OpenAI native function calling. The gateway is supposed to force
// such requests onto a FC-capable worker (Qwen 32B vLLM), but the
// ailiance auto-router model can leak through — see the companion
// gateway-side fix that hardens that route.
//
// When this leak happens, the model imitates Anthropic-style XML but
// emits a flat shape neither Anthropic nor any of the 5
// universal-emulation formats (CHANGELOG 0.5.0) handles:
//
//   <function=list_files>
//   <parameter=paths>
//   ["."]
//   </parameter>
//   </function>
//
// The CLI's text-block parser previously stripped the outer
// <function_calls>...</function_calls> Anthropic wrapper but did not
// recognise this flat <function=name> shape. The model repeats it,
// the CLI never dispatches a tool, the agent loop hits 5 consecutive
// "no tool call detected" errors and aborts.
//
// This module gives the CLI a tolerant parser so the same input ends
// up as a structured tool call regardless of which format the model
// chose. It is best-effort, never throws, and returns the residual
// text so the caller can still display non-tool prose.

export interface ParsedXmlToolCall {
	name: string
	params: Record<string, string>
}

export interface XmlToolParseResult {
	calls: ParsedXmlToolCall[]
	// Text remaining after the tool-call blocks have been excised.
	residualText: string
}

// Tolerant patterns:
// - <function=NAME>...</function>  (the observed hallucination)
// - <invoke=NAME>...</invoke>      (a near-cousin some models emit)
const FUNCTION_BLOCK_RE = /<(function|invoke)=([a-zA-Z0-9_.-]+)>([\s\S]*?)<\/\1>/g
// Inside a block, parameters are <parameter=KEY>VALUE</parameter>.
// Some models drop the equals: <parameter name="KEY"> — accept both.
const PARAM_RE = /<parameter(?:=|\s+name=["'])([a-zA-Z0-9_.-]+)["']?\s*>([\s\S]*?)<\/parameter>/g

/**
 * Extract tool calls from an assistant text block.
 *
 * Returns the structured calls plus the residual text after the
 * matched blocks are excised. Always succeeds — if no pattern matches,
 * `calls` is empty and `residualText` is the input untouched.
 */
export function parseHallucinatedToolXml(text: string): XmlToolParseResult {
	if (!text || (!text.includes("<function") && !text.includes("<invoke"))) {
		return { calls: [], residualText: text ?? "" }
	}

	const calls: ParsedXmlToolCall[] = []
	let residual = text

	residual = residual.replace(FUNCTION_BLOCK_RE, (_match, _outerTag, name, inner) => {
		const params: Record<string, string> = {}
		let paramMatch: RegExpExecArray | null
		// Reset lastIndex; PARAM_RE is global so it carries state across calls.
		PARAM_RE.lastIndex = 0
		while ((paramMatch = PARAM_RE.exec(inner)) !== null) {
			const key = paramMatch[1]
			const value = paramMatch[2].trim()
			params[key] = value
		}
		calls.push({ name, params })
		// Excise the block; trim a single surrounding newline so we don't
		// pile blank lines in the residual prose.
		return ""
	})

	// Collapse runs of >2 newlines left by the excision.
	residual = residual.replace(/\n{3,}/g, "\n\n").trim()

	return { calls, residualText: residual }
}

/**
 * Heuristic: does this text look like it contains a hallucinated tool
 * call? Cheap check used to decide whether to invoke the full parser.
 */
export function hasHallucinatedToolXml(text: string): boolean {
	if (!text) return false
	// Must contain BOTH the opening tag and a closing — partial streams
	// should not trigger (the assistant-message parser handles partials
	// elsewhere; we only act on complete blocks).
	const hasOpen = /<(function|invoke)=[a-zA-Z0-9_.-]+>/.test(text)
	const hasClose = /<\/(function|invoke)>/.test(text)
	return hasOpen && hasClose
}

/**
 * Canonical aliases observed in the wild. The keys are exactly what
 * Mistral-Medium-128B (and similar MLX backends) emit when they
 * hallucinate tool calls; the values are the real IsaacDefaultTool
 * enum strings. Extend this map when new hallucinations are observed
 * in production logs.
 *
 * Strict policy: unknown names are NOT silently passed through. Names
 * not in the canonical enum and not in this alias map are dropped
 * (the caller surfaces them as text so the user can see what the
 * model attempted).
 */
const TOOL_NAME_ALIASES: Record<string, string> = {
	// Plural / singular drift
	read_files: "read_file",
	list_file: "list_files",
	// Mistral-128B observed forms 2026-05-12
	listfiles: "list_files",
	lsfiles: "list_files",
	ls_files: "list_files",
	writefile: "write_to_file",
	write_file: "write_to_file",
	readfile: "read_file",
	executecommand: "execute_command",
	exec_command: "execute_command",
	run_command: "execute_command",
	bash: "execute_command",
	shell: "execute_command",
	searchfiles: "search_files",
	search_file: "search_files",
	grep: "search_files",
}

/**
 * Resolve a model-emitted tool name to a canonical IsaacDefaultTool
 * string. Pass the runtime enum-value set so this module stays
 * decoupled from the broader tool registry (the registry imports
 * proto-generated types; this module is parser-only).
 *
 * Returns the canonical name when the input is recognised, or null
 * when it cannot be matched to any known tool.
 */
export function canonicaliseToolName(name: string, knownTools: ReadonlySet<string>): string | null {
	if (!name) return null
	const trimmed = name.trim()
	if (knownTools.has(trimmed)) return trimmed
	const lower = trimmed.toLowerCase()
	if (knownTools.has(lower)) return lower
	const alias = TOOL_NAME_ALIASES[lower]
	if (alias && knownTools.has(alias)) return alias
	return null
}
