import { IsaacDefaultTool } from "@/shared/tools"
import type { IsaacToolSpec } from "../spec"
import type { ParamNames } from "../tool-unit"

export const execute_command = {
	id: IsaacDefaultTool.BASH,
	name: "execute_command",
	description:
		"Executes CLI commands or scripts. " +
		"Use 'commands' for simple sequences of shell operations, can also be a single command. " +
		"Use 'script' for complex multi-line logic, data processing, or when a high-level language like Python or Node.js is more efficient than shell scripting. Default language is bash" +
		"'script' are also very useful for combinatorial problems such as looping over 'swap and try' pattern" +
		"Scripts have full access to the file system and current environment, be careful. " +
		"In multi-root workspaces, use the @workspace:command syntax for standard commands. " +
		"Leverage the full power of the environment's interpreters (bash, python, node, etc.) to accomplish tasks with minimal round-trips." +
		"NOTE: provide exactly one of the {commands,script}",
	parameters: [
		{
			name: "commands",
			required: false,
			type: "array",
			items: { type: "string" },
			instruction:
				"An array of CLI commands to execute in sequence. Use proper shell operators within each command. Do not use ~ for home directory. When running builds or parallel tasks, use the number of cores provided in SYSTEM INFO instead of 'nproc' to respect environment limits.",
		},
		{
			name: "script",
			required: false,
			type: "string",
			instruction:
				"A script to execute. Use this for complex multi-line logic or non-shell languages like Python or Node.js.",
		},
		{
			name: "language",
			required: false,
			type: "string",
			instruction: "The language of the script (e.g., 'bash', 'python', 'node'). Defaults to 'bash'.",
		},
	],
} as const satisfies IsaacToolSpec

/**
 * Lot E: typed param-name union derived from the spec literal above.
 * The handler reads the scalar `script`/`language` params through this contract;
 * the array `commands` is read via `coerceToStringArray`. A rename/removal of a
 * spec parameter changes this union and breaks the handler compile (kills drift).
 */
export type ExecuteCommandParam = ParamNames<typeof execute_command>
