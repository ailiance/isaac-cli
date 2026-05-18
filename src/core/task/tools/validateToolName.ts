import { telemetryService } from "@/services/telemetry"

/**
 * Result of validating a tool name proposed by the LLM.
 *
 * The model may emit fictional names like `digikey:search` or
 * `kicad.new_project` — runtime validation rejects them so we don't
 * dispatch to an absent handler and we surface a corrective hint.
 */
export type ToolNameValidation = { valid: true } | { valid: false; reason: string; hint: string }

/** Characters explicitly banned by the system prompt's TOOL CONSTRAINTS section. */
const FORBIDDEN_CHARS = /[:.]/

const HINT_TOOL_LIMIT = 8

function summarizeKnownTools(knownTools: ReadonlySet<string>): string {
	return Array.from(knownTools).slice(0, HINT_TOOL_LIMIT).join(", ")
}

/**
 * Validate a tool name parsed from a model response before dispatch.
 *
 * Centralised so the emulation parser (LocalRouter) and any future
 * native dispatcher reject the same shapes. The forbidden-character
 * rule fires before the unknown-name rule because its hint is more
 * actionable when both apply.
 */
export function validateToolName(name: unknown, knownTools: ReadonlySet<string>): ToolNameValidation {
	if (typeof name !== "string" || name.length === 0) {
		return {
			valid: false,
			reason: "Tool name is empty.",
			hint: "Provide a tool name from the available tools.",
		}
	}
	if (FORBIDDEN_CHARS.test(name)) {
		return {
			valid: false,
			reason: `Tool name "${name}" contains forbidden characters (':' or '.').`,
			hint: `Tool names cannot contain ':' or '.'. Use one of: ${summarizeKnownTools(knownTools)}.`,
		}
	}
	if (!knownTools.has(name)) {
		return {
			valid: false,
			reason: `Tool name "${name}" is not a known tool.`,
			hint: `Use one of: ${summarizeKnownTools(knownTools)}.`,
		}
	}
	return { valid: true }
}

/**
 * Best-effort telemetry report for an invalid tool name. Never throws —
 * telemetry failures must not block the agent loop.
 */
export function reportInvalidToolName(name: string, reason: string): void {
	try {
		const svc = telemetryService as unknown as {
			captureInvalidToolName?: (n: string, r: string) => void
		}
		svc.captureInvalidToolName?.(name, reason)
	} catch {
		// swallow — telemetry is best-effort
	}
}
