import type { ToolUse } from "@core/assistant-message"
import { IsaacDefaultTool } from "@/shared/tools"
import type { ToolResponse } from "../index"
import { AskFollowupQuestionToolHandler } from "./handlers/AskFollowupQuestionToolHandler"
import { AttemptCompletionHandler } from "./handlers/AttemptCompletionHandler"
import { BrowserToolHandler } from "./handlers/BrowserToolHandler"
import { CondenseHandler } from "./handlers/CondenseHandler"
import { DiagnosticsScanToolHandler } from "./handlers/DiagnosticsScanToolHandler"
import { EditFileToolHandler } from "./handlers/EditFileToolHandler"
import { ExecuteCommandToolHandler } from "./handlers/ExecuteCommandToolHandler"
import { FindSymbolReferencesToolHandler } from "./handlers/FindSymbolReferencesToolHandler"
import { FindToolsToolHandler } from "./handlers/FindToolsToolHandler"
import { GenerateExplanationToolHandler } from "./handlers/GenerateExplanationToolHandler"
import { GetFileSkeletonToolHandler } from "./handlers/GetFileSkeletonToolHandler"
import { GetFunctionToolHandler } from "./handlers/GetFunctionToolHandler"
import { GetToolResultToolHandler } from "./handlers/GetToolResultToolHandler"
import { ListFilesToolHandler } from "./handlers/ListFilesToolHandler"
import { ListSkillsToolHandler } from "./handlers/ListSkillsToolHandler"
import { NewTaskHandler } from "./handlers/NewTaskHandler"
import { PlanModeRespondHandler } from "./handlers/PlanModeRespondHandler"
import { ReadFileToolHandler } from "./handlers/ReadFileToolHandler"
import { RenameSymbolToolHandler } from "./handlers/RenameSymbolToolHandler"
import { ReplaceSymbolToolHandler } from "./handlers/ReplaceSymbolToolHandler"
import { ReportBugHandler } from "./handlers/ReportBugHandler"
import { SearchFilesToolHandler } from "./handlers/SearchFilesToolHandler"
import { UseSubagentsToolHandler } from "./handlers/SubagentToolHandler"
import { SummarizeTaskHandler } from "./handlers/SummarizeTaskHandler"
import { UseSkillToolHandler } from "./handlers/UseSkillToolHandler"
import { WriteToFileToolHandler } from "./handlers/WriteToFileToolHandler"
import { AgentConfigLoader } from "./subagent/AgentConfigLoader"
import { ToolValidator } from "./ToolValidator"
import type { TaskConfig } from "./types/TaskConfig"
import type { StronglyTypedUIHelpers } from "./types/UIHelpers"

export interface IToolHandler {
	readonly name: IsaacDefaultTool
	execute(config: TaskConfig, block: ToolUse): Promise<ToolResponse>
	getDescription(block: ToolUse): string
}

export interface IPartialBlockHandler {
	handlePartialBlock(block: ToolUse, uiHelpers: StronglyTypedUIHelpers): Promise<void>
}

export interface IFullyManagedTool extends IToolHandler, IPartialBlockHandler {
	// Marker interface for tools that handle their own complete approval flow
}

/**
 * A wrapper class that allows a single tool handler to be registered under multiple names.
 * This provides proper typing for tools that share the same implementation logic.
 */
export class SharedToolHandler implements IFullyManagedTool {
	constructor(
		public readonly name: IsaacDefaultTool,
		private baseHandler: IFullyManagedTool,
	) {}

	getDescription(block: ToolUse): string {
		return this.baseHandler.getDescription(block)
	}

	async execute(config: TaskConfig, block: ToolUse): Promise<ToolResponse> {
		return this.baseHandler.execute(config, block)
	}

	async handlePartialBlock(block: ToolUse, uiHelpers: StronglyTypedUIHelpers): Promise<void> {
		return this.baseHandler.handlePartialBlock(block, uiHelpers)
	}
}

/**
 * Coordinates tool execution by routing to registered handlers.
 * Falls back to legacy switch for unregistered tools.
 */
export class ToolExecutorCoordinator {
	private handlers = new Map<string, IToolHandler>()
	private dynamicSubagentHandlers = new Map<string, IToolHandler>()
	private mcpHandlers = new Map<string, IToolHandler>()

	private readonly toolHandlersMap: Record<IsaacDefaultTool, (v: ToolValidator) => IToolHandler | undefined> = {
		[IsaacDefaultTool.ASK]: (_v: ToolValidator) => new AskFollowupQuestionToolHandler(),
		[IsaacDefaultTool.ATTEMPT]: (_v: ToolValidator) => new AttemptCompletionHandler(),
		[IsaacDefaultTool.BASH]: (v: ToolValidator) => new ExecuteCommandToolHandler(v),
		[IsaacDefaultTool.FILE_READ]: (v: ToolValidator) => new ReadFileToolHandler(v),
		[IsaacDefaultTool.FILE_NEW]: (v: ToolValidator) => new WriteToFileToolHandler(v),
		[IsaacDefaultTool.SEARCH]: (v: ToolValidator) => new SearchFilesToolHandler(v),
		[IsaacDefaultTool.LIST_FILES]: (v: ToolValidator) => new ListFilesToolHandler(v),
		[IsaacDefaultTool.GET_FUNCTION]: (v: ToolValidator) => new GetFunctionToolHandler(v),
		[IsaacDefaultTool.GET_FILE_SKELETON]: (v: ToolValidator) => new GetFileSkeletonToolHandler(v),
		[IsaacDefaultTool.FIND_SYMBOL_REFERENCES]: (v: ToolValidator) => new FindSymbolReferencesToolHandler(v),

		[IsaacDefaultTool.EDIT_FILE]: (v: ToolValidator) => new EditFileToolHandler(v),
		[IsaacDefaultTool.DIAGNOSTICS_SCAN]: (v: ToolValidator) => new DiagnosticsScanToolHandler(v),
		[IsaacDefaultTool.REPLACE_SYMBOL]: (v: ToolValidator) => new ReplaceSymbolToolHandler(v),
		[IsaacDefaultTool.RENAME_SYMBOL]: (v: ToolValidator) => new RenameSymbolToolHandler(v),
		[IsaacDefaultTool.BROWSER]: (_v: ToolValidator) => new BrowserToolHandler(),

		[IsaacDefaultTool.NEW_TASK]: (_v: ToolValidator) => new NewTaskHandler(),
		[IsaacDefaultTool.PLAN_MODE]: (_v: ToolValidator) => new PlanModeRespondHandler(),
		[IsaacDefaultTool.CONDENSE]: (_v: ToolValidator) => new CondenseHandler(),
		[IsaacDefaultTool.SUMMARIZE_TASK]: (_v: ToolValidator) => new SummarizeTaskHandler(_v),
		[IsaacDefaultTool.REPORT_BUG]: (_v: ToolValidator) => new ReportBugHandler(),
		[IsaacDefaultTool.NEW_RULE]: (v: ToolValidator) =>
			new SharedToolHandler(IsaacDefaultTool.NEW_RULE, new WriteToFileToolHandler(v)),
		[IsaacDefaultTool.GENERATE_EXPLANATION]: (_v: ToolValidator) => new GenerateExplanationToolHandler(),
		[IsaacDefaultTool.USE_SKILL]: (_v: ToolValidator) => new UseSkillToolHandler(),
		[IsaacDefaultTool.LIST_SKILLS]: (_v: ToolValidator) => new ListSkillsToolHandler(),
		[IsaacDefaultTool.USE_SUBAGENTS]: (_v: ToolValidator) => new UseSubagentsToolHandler(),
		[IsaacDefaultTool.GET_TOOL_RESULT]: (_v: ToolValidator) => new GetToolResultToolHandler(),

		[IsaacDefaultTool.FIND_TOOLS]: (_v: ToolValidator) => new FindToolsToolHandler(),
	}

	/**
	 * Register a tool handler
	 */
	register(handler: IToolHandler): void {
		this.handlers.set(handler.name, handler)
	}

	registerByName(toolName: IsaacDefaultTool, validator: ToolValidator): void {
		const handler = this.toolHandlersMap[toolName]?.(validator)
		if (handler) {
			this.register(handler)
		}
	}

	/**
	 * Register a dynamically-named tool handler (e.g. MCP tools whose names are not in IsaacDefaultTool).
	 */
	registerDynamicTool(toolName: string, handler: IToolHandler): void {
		this.mcpHandlers.set(toolName, handler)
	}

	/**
	 * Check if a handler is registered for the given tool
	 */
	has(toolName: string): boolean {
		return this.getHandler(toolName) !== undefined
	}

	/**
	 * Get a handler for the given tool name
	 */
	getHandler(toolName: string): IToolHandler | undefined {
		const staticHandler = this.handlers.get(toolName)
		if (staticHandler) {
			return staticHandler
		}

		const mcpHandler = this.mcpHandlers.get(toolName)
		if (mcpHandler) {
			return mcpHandler
		}

		if (AgentConfigLoader.getInstance().isDynamicSubagentTool(toolName)) {
			const existingHandler = this.dynamicSubagentHandlers.get(toolName)
			if (existingHandler) {
				return existingHandler
			}
			const handler = new SharedToolHandler(toolName as IsaacDefaultTool, new UseSubagentsToolHandler())
			this.dynamicSubagentHandlers.set(toolName, handler)
			return handler
		}

		return undefined
	}

	/**
	 * Execute a tool through its registered handler
	 */
	async execute(config: TaskConfig, block: ToolUse): Promise<ToolResponse> {
		const handler = this.getHandler(block.name)
		if (!handler) {
			throw new Error(`No handler registered for tool: ${block.name}`)
		}
		return handler.execute(config, block)
	}
}
