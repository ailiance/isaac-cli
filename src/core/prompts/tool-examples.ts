import { IsaacDefaultTool } from "../../shared/tools"

export const TOOL_EXAMPLES: Partial<Record<IsaacDefaultTool, string>> = {
	[IsaacDefaultTool.ASK]: '{"question": "What should I do next?"}',
	[IsaacDefaultTool.ATTEMPT]: '{"result": "Summary of work done..."}',
	[IsaacDefaultTool.SUMMARIZE_TASK]: '{"context": "Detailed summary of the conversation..."}',
	[IsaacDefaultTool.DIAGNOSTICS_SCAN]: '{"paths": ["src"]}',
	[IsaacDefaultTool.BROWSER]: '{"action": "launch", "url": "https://google.com"}',
	[IsaacDefaultTool.EDIT_FILE]:
		'{"files": [{"path": "src/index.ts", "edits": [{"edit_type": "replace", "anchor": "...", "end_anchor": "...", "text": "new content"}]}]}',
	[IsaacDefaultTool.REPLACE_SYMBOL]:
		'{"replacements": [{"path": "src/main.ts", "symbol": "main", "text": "..."}]}',
	[IsaacDefaultTool.RENAME_SYMBOL]:
		'{"paths": ["src"], "existing_symbol": "oldName", "new_symbol": "newName"}',
	[IsaacDefaultTool.BASH]: '{"commands": ["ls -R"]}',
	[IsaacDefaultTool.GET_FUNCTION]: '{"paths": ["src/main.ts"], "function_names": ["main"]}',
	[IsaacDefaultTool.GET_FILE_SKELETON]: '{"paths": ["src/main.ts"]}',
	[IsaacDefaultTool.FIND_SYMBOL_REFERENCES]:
		'{"paths": ["src"], "symbols": ["main"]}',
	[IsaacDefaultTool.LIST_FILES]: '{"paths": ["src"]}',
	[IsaacDefaultTool.NEW_TASK]: '{"context": "Detailed summary of the conversation..."}',
	[IsaacDefaultTool.PLAN_MODE]: '{"response": "I have gathered context..."}',
	[IsaacDefaultTool.FILE_READ]: '{"paths": ["src/main.ts"]}',
	[IsaacDefaultTool.SEARCH]: '{"paths": ["src"], "regex": "TODO"}',
	[IsaacDefaultTool.USE_SUBAGENTS]: '{"prompt_1": "...", "prompt_2": "..."}',
	[IsaacDefaultTool.USE_SKILL]: '{"skill_name": "skill-name"}',
	[IsaacDefaultTool.LIST_SKILLS]: '{}',
	[IsaacDefaultTool.GENERATE_EXPLANATION]: '{"title": "Changes in last commit", "from_ref": "HEAD~1"}',
	[IsaacDefaultTool.FILE_NEW]: '{"path": "src/new-file.ts", "content": "export const x = 1"}',
}
