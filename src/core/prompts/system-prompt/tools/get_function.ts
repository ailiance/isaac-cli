import { IsaacDefaultTool } from "@/shared/tools"
import type { IsaacToolSpec } from "../spec"

const id = IsaacDefaultTool.GET_FUNCTION

export const get_function: IsaacToolSpec = {
	id,
	name: "get_function",
	description:
		"Extracts the complete implementation of one or more functions or methods from one or more files. Use this to inspect specific functions' logic without reading the entire files. You can specify multiple files and multiple functions, it will return an all to all lookup result. Use dot-separated path to the function.",
	parameters: [
		{
			name: "paths",
			required: true,
			type: "array",
			items: { type: "string" },
			instruction: "An array of relative paths to the source files.",
			usage: '["src/utils/math.ts", "src/utils/string.ts"]',
		},
		{
			name: "function_names",
			required: true,
			type: "array",
			items: { type: "string" },
			instruction: "Exact names of the functions or methods to extract.",
			usage: '["Foo.calculateSum", "Bar.findMax"]',
		},
	],
}
