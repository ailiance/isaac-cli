/**
 * Coerce a tool parameter into a string array.
 *
 * Native tool calls deliver array params (read_file `paths`, list_files
 * `paths`, execute_command `commands`, …) as real arrays. But an array
 * argument can occasionally arrive as its JSON-stringified form — e.g. the
 * string `'["README.md"]'` — depending on the upstream worker / relay. Without
 * this, handlers fall into the "not an array → wrap as `[value]`" branch and
 * treat the literal `["README.md"]` text as a single path/command (ENOENT on
 * a bracketed path, a no-op shell command, etc.). Parse such strings back into
 * a real array so the handler operates on the intended values.
 */
export function coerceToStringArray(value: unknown): string[] {
	if (Array.isArray(value)) {
		return value.map((v) => String(v))
	}
	if (typeof value === "string") {
		const trimmed = value.trim()
		if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
			try {
				const parsed = JSON.parse(trimmed)
				if (Array.isArray(parsed)) {
					return parsed.map((v) => String(v))
				}
			} catch {
				// not valid JSON — fall through and treat as a single value
			}
		}
		return trimmed ? [trimmed] : []
	}
	return []
}

/**
 * Coerce the first non-empty candidate into a string array.
 *
 * Several handlers accept a plural batch param (`paths`, `symbols`) with a
 * singular fallback (`path`, `symbol`). Try each candidate in order via
 * {@link coerceToStringArray} and return the first that yields a non-empty
 * array, so the singular fallback is preserved while still parsing any
 * JSON-stringified array form.
 */
export function coerceFirstStringArray(...values: unknown[]): string[] {
	for (const value of values) {
		const arr = coerceToStringArray(value)
		if (arr.length > 0) {
			return arr
		}
	}
	return []
}
