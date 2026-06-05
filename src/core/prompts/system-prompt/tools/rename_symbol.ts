import { IsaacDefaultTool } from "@/shared/tools"
import type { IsaacToolSpec } from "../spec"
import type { ParamNames } from "../tool-unit"

const id = IsaacDefaultTool.RENAME_SYMBOL

export const rename_symbol = {
	id,
	name: "rename_symbol",
	description:
		"Renames ALL occurrences of a symbol (function, class, method, or variable) inside the specified files or directories. This tool can identify precise symbols using a language's AST and is more accurate than a simple search-and-replace because it understands the language structure. For renaming tasks, strongly prefer this as the first pass.",
	parameters: [
		{
			name: "paths",
			required: true,
			type: "array",
			items: { type: "string" },
			instruction: "An array of relative paths to the directories or files to perform the rename in.",
			usage: '["src/", "tests/"]',
		},
		{
			name: "existing_symbol",
			required: true,
			type: "string",
			instruction: "The exact name of the symbol to be renamed.",
			usage: '"calculateTotal"',
		},
		{
			name: "new_symbol",
			required: true,
			type: "string",
			instruction: "The new name for the symbol.",
			usage: '"calculateGrandTotal"',
		},
	],
} as const satisfies IsaacToolSpec

/**
 * Lot E: typed param-name union derived from the spec literal above.
 * The handler reads the scalar `existing_symbol`/`new_symbol` params through this
 * contract; the array `paths` is read via `coerceToStringArray`. A rename/removal
 * of a spec parameter changes this union and breaks the handler compile.
 */
export type RenameSymbolParam = ParamNames<typeof rename_symbol>
