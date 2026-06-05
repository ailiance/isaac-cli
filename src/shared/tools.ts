import { Tool as AnthropicTool } from "@anthropic-ai/sdk/resources/index"
import { FunctionDeclaration as GoogleTool } from "@google/genai"
import { ChatCompletionTool as OpenAITool } from "openai/resources/chat/completions"

export type IsaacTool = OpenAITool | AnthropicTool | GoogleTool

// Define available tool ids
export enum IsaacDefaultTool {
	ASK = "ask_followup_question",
	ATTEMPT = "attempt_completion",
	BASH = "execute_command",
	FILE_READ = "read_file",
	FILE_NEW = "write_to_file",
	SEARCH = "search_files",
	LIST_FILES = "list_files",
	BROWSER = "browser_action",
	NEW_TASK = "new_task",
	PLAN_MODE = "plan_mode_respond",
	CONDENSE = "condense",
	SUMMARIZE_TASK = "summarize_task",
	REPORT_BUG = "report_bug",
	NEW_RULE = "new_rule",
	GENERATE_EXPLANATION = "generate_explanation",
	USE_SKILL = "use_skill",
	LIST_SKILLS = "list_skills",
	USE_SUBAGENTS = "use_subagents",
	GET_FUNCTION = "get_function",
	GET_FILE_SKELETON = "get_file_skeleton",
	FIND_SYMBOL_REFERENCES = "find_symbol_references",

	EDIT_FILE = "edit_file",
	DIAGNOSTICS_SCAN = "diagnostics_scan",
	REPLACE_SYMBOL = "replace_symbol",
	RENAME_SYMBOL = "rename_symbol",

	// Sprint 2 — async tool result lookup. Fetches the result of a
	// previously-dispatched long-running tool by task_id.
	GET_TOOL_RESULT = "get_tool_result",

	FIND_TOOLS = "find_tools",
}

// Array of all tool names for compatibility
// Automatically generated from the enum values
export const toolUseNames = Object.values(IsaacDefaultTool) as IsaacDefaultTool[]

const dynamicToolUseNamesByNamespace = new Map<string, Set<string>>()

export function setDynamicToolUseNames(namespace: string, names: string[]): void {
	dynamicToolUseNamesByNamespace.set(namespace, new Set(names.map((name) => name.trim()).filter(Boolean)))
}

export function getToolUseNames(): string[] {
	const defaults = [...toolUseNames]
	const dynamic = Array.from(dynamicToolUseNamesByNamespace.values()).flatMap((set) => Array.from(set))
	return Array.from(new Set([...defaults, ...dynamic]))
}

// Tools that are safe to run in parallel with the initial checkpoint commit
// These are tools that do not modify the workspace state
export const READ_ONLY_TOOLS = [
	IsaacDefaultTool.LIST_FILES,
	IsaacDefaultTool.FILE_READ,
	IsaacDefaultTool.SEARCH,
	IsaacDefaultTool.BROWSER,
	IsaacDefaultTool.ASK,
	IsaacDefaultTool.GET_FUNCTION,
	IsaacDefaultTool.GET_FILE_SKELETON,
	IsaacDefaultTool.FIND_SYMBOL_REFERENCES,
	IsaacDefaultTool.DIAGNOSTICS_SCAN,

	IsaacDefaultTool.USE_SKILL,
	IsaacDefaultTool.LIST_SKILLS,
	IsaacDefaultTool.USE_SUBAGENTS,

	// Sprint 2 — get_tool_result is a metadata-only lookup, never mutates.
	IsaacDefaultTool.GET_TOOL_RESULT,
] as const
