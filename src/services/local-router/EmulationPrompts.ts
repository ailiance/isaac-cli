/**
 * Per-format emulation system-prompt templates. Selected by LocalRouter based
 * on the worker's ModelToolProfile.format. Each template embeds the same
 * tool descriptions but instructs the model to use a different wire format.
 */

import type { ToolCallFormat } from "./ModelRegistry"
import type { ChatTool } from "./types"

export function formatToolsAsPromptText(tools: ChatTool[]): string {
	let out = "## Available tools\n\n"
	for (const t of tools) {
		out += `### \`${t.function.name}\`\n${t.function.description ?? ""}\n\nParameters:\n\`\`\`json\n${JSON.stringify(t.function.parameters, null, 2)}\n\`\`\`\n\n`
	}
	return out.trim()
}

const COMMON_RULES = `
RULES:
- One tool call per response. Wait for the result.
- Use the exact tool name (no variations like "readFile" or "fs.read").
- Do NOT explain what you will do BEFORE calling. Just call the tool.
`

const MARKDOWN_FENCE_TEMPLATE = `

%TOOLS%

You have access to the following tools to interact with files and execute commands. To call a tool, respond with EXACTLY this format (a single fenced JSON block):

\`\`\`tool
{"name": "tool_name", "arguments": {"key": "value"}}
\`\`\`

EXAMPLES:

User: read the file foo.txt
Assistant:
\`\`\`tool
{"name": "read_file", "arguments": {"path": "foo.txt"}}
\`\`\`

User: list files in src/
Assistant:
\`\`\`tool
{"name": "list_files", "arguments": {"path": "src/", "recursive": false}}
\`\`\`

User: write "hello world" to greeting.txt
Assistant:
\`\`\`tool
{"name": "write_to_file", "arguments": {"path": "greeting.txt", "content": "hello world"}}
\`\`\`

User: run "ls -la"
Assistant:
\`\`\`tool
{"name": "execute_command", "arguments": {"command": "ls -la", "requires_approval": false}}
\`\`\`

${COMMON_RULES}- Always use the \`\`\`tool fence (not bash, json, python, or other).

`

const XML_TEMPLATE = `

%TOOLS%

You have access to the following tools. Wrap each tool call in \`<tool_call>{...}</tool_call>\` tags containing a single JSON object with "name" and "arguments":

<tool_call>{"name": "tool_name", "arguments": {"key": "value"}}</tool_call>

EXAMPLES:

User: read the file foo.txt
Assistant: <tool_call>{"name": "read_file", "arguments": {"path": "foo.txt"}}</tool_call>

User: list files in src/
Assistant: <tool_call>{"name": "list_files", "arguments": {"path": "src/", "recursive": false}}</tool_call>

User: write "hello world" to greeting.txt
Assistant: <tool_call>{"name": "write_to_file", "arguments": {"path": "greeting.txt", "content": "hello world"}}</tool_call>

User: run "ls -la"
Assistant: <tool_call>{"name": "execute_command", "arguments": {"command": "ls -la", "requires_approval": false}}</tool_call>

${COMMON_RULES}- Always use the \`<tool_call>...</tool_call>\` XML-style tags.

`

const JSON_INLINE_TEMPLATE = `

%TOOLS%

You have access to the following tools. Emit the tool call as a single JSON object on a line of its own — no fences, no tags — with "name" and "arguments":

{"name": "tool_name", "arguments": {"key": "value"}}

EXAMPLES:

User: read the file foo.txt
Assistant: {"name": "read_file", "arguments": {"path": "foo.txt"}}

User: list files in src/
Assistant: {"name": "list_files", "arguments": {"path": "src/", "recursive": false}}

User: write "hello world" to greeting.txt
Assistant: {"name": "write_to_file", "arguments": {"path": "greeting.txt", "content": "hello world"}}

User: run "ls -la"
Assistant: {"name": "execute_command", "arguments": {"command": "ls -la", "requires_approval": false}}

${COMMON_RULES}- Emit the JSON object alone on its own line, no surrounding markdown.

`

const PLAIN_FUNCTION_TEMPLATE = `

%TOOLS%

You have access to the following tools. Call tools using \`tool_name(arg1=value1, arg2=value2)\` syntax:

EXAMPLES:

User: read the file foo.txt
Assistant: read_file(path="foo.txt")

User: list files in src/
Assistant: list_files(path="src/", recursive=false)

User: run "ls -la"
Assistant: execute_command(command="ls -la", requires_approval=false)

${COMMON_RULES}- Use Python-style keyword arguments: \`name=value\`, with strings quoted.

`

/**
 * Render the emulation system-prompt preamble for a given format.
 * Returns a string that should be appended to the existing system message
 * (or used as the system message when none exists).
 */
export function renderEmulationPrompt(format: ToolCallFormat, tools: ChatTool[]): string {
	const toolDescriptions = formatToolsAsPromptText(tools)
	const template = pickTemplate(format)
	return template.replace("%TOOLS%", toolDescriptions)
}

function pickTemplate(format: ToolCallFormat): string {
	switch (format) {
		case "xml":
			return XML_TEMPLATE
		case "json_inline":
			return JSON_INLINE_TEMPLATE
		case "plain_function":
			return PLAIN_FUNCTION_TEMPLATE
		// markdown_fence is also the safe default for native formats when we
		// fall back to emulation (worker advertised native but profile says no).
		default:
			return MARKDOWN_FENCE_TEMPLATE
	}
}
