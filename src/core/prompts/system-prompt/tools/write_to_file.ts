import { IsaacDefaultTool } from "@/shared/tools"
import type { IsaacToolSpec } from "../spec"
import type { ParamNames } from "../tool-unit"

const id = IsaacDefaultTool.FILE_NEW

export const write_to_file = {
	id,
	name: "write_to_file",
	description: "Creates a new file or completely overwrites an existing file. Automatically creates required directories.",
	parameters: [
		{
			name: "path",
			required: true,
			instruction: "The path of the file to write to.",
			usage: "File path here",
		},
		{
			name: "content",
			required: true,
			instruction: "The COMPLETE intended content of the file. Do not truncate or omit any parts.",
			usage: "Full file content here",
		},
	],
} as const satisfies IsaacToolSpec

/**
 * Lot E: typed param-name union derived from the spec literal above.
 * The handler reads scalar params through these names; a rename/removal of a
 * spec parameter changes this union and breaks the handler compile (kills drift).
 */
export type WriteToFileParam = ParamNames<typeof write_to_file>
