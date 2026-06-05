import { IsaacDefaultTool } from "@/shared/tools"
import type { IsaacToolSpec } from "../spec"
import type { ParamNames } from "../tool-unit"

const id = IsaacDefaultTool.REPLACE_SYMBOL

export const replace_symbol = {
	id,
	name: "replace_symbol",
	description:
		"Replaces one or more symbols (functions, methods, or classes) in one or more files with new code. This is more robust and token-efficient than edit_file because it targets specific AST nodes directly. IMPORTANT: You MUST provide the complete and correct replacement for each symbol, including all its associated JSDoc, comments, decorators, and export keywords. The tool will replace the entire original range of the symbol and its metadata with your provided text.",
	parameters: [
		{
			name: "replacements",
			type: "array",
			required: true,
			instruction: "An array of replacement objects.",
			items: {
				type: "object",
				properties: {
					path: {
						type: "string",
						description: "Relative path to the source file.",
					},
					symbol: {
						type: "string",
						description:
							"The dot-separated path to the symbol to replace (e.g., 'ClassName.methodName' or just 'functionName').",
					},
					text: {
						type: "string",
						description:
							"The complete new code for the symbol, including any associated JSDoc, comments, decorators, and export keywords.",
					},
					type: {
						type: "string",
						description:
							"Optional type of the symbol to help with disambiguation (e.g., 'function', 'method', 'class').",
					},
				},
				required: ["path", "symbol", "text"],
			},
		},
	],
} as const satisfies IsaacToolSpec

/**
 * Lot E: typed param-name union derived from the spec literal above.
 * This tool only has the array param `replacements` (the handler also accepts
 * legacy singular `path`/`symbol`/`text`/`type` aliases that are not part of the
 * spec). No scalar `readParam` call applies; the typed link is preserved via
 * this export + the `replace_symbol_unit`. Nested `items`/`required` JSON Schema
 * fields are preserved verbatim by `as const satisfies IsaacToolSpec`.
 */
export type ReplaceSymbolParam = ParamNames<typeof replace_symbol>
