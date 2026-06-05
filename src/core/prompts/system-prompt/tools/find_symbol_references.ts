import { IsaacDefaultTool } from "@/shared/tools"
import type { IsaacToolSpec } from "../spec"

const id = IsaacDefaultTool.FIND_SYMBOL_REFERENCES

export const find_symbol_references: IsaacToolSpec = {
	id,
	name: "find_symbol_references",
	description:
		"Finds all exact AST references and invocations of one or more functions, classes, or variables across specified files or directories. Returns precise file paths.",
	parameters: [
		{
			name: "paths",
			required: true,
			type: "array",
			items: { type: "string" },
			instruction: "An array of relative paths to the directories or files to search.",
			usage: '["src/", "tests/"]',
		},
		{
			name: "symbols",
			required: true,
			type: "array",
			items: { type: "string" },
			instruction: "An array of exact symbol names to find references for.",
			usage: '["calculateTotal", "UserAccount"]',
		},
		{
			name: "find_type",
			required: false,
			type: "string",
			enum: ["definition", "reference", "both"],
			instruction:
				'Specifies the type of references to find. "definition" returns only definitions, "reference" returns only references, and "both" (default) returns both.',
		},
	],
}
