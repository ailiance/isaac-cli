import type { ToolUse } from "@core/assistant-message"
import { IsaacDefaultTool } from "@/shared/tools"
import type { ToolResponse } from "../index"
import { CondenseHandler } from "./handlers/CondenseHandler"
import { ReportBugHandler } from "./handlers/ReportBugHandler"
import { UseSubagentsToolHandler } from "./handlers/SubagentToolHandler"
import { WriteToFileToolHandler } from "./handlers/WriteToFileToolHandler"
import { AgentConfigLoader } from "./subagent/AgentConfigLoader"
import { ToolValidator } from "./ToolValidator"
import type { TaskConfig } from "./types/TaskConfig"
import type { StronglyTypedUIHelpers } from "./types/UIHelpers"
import { getUnits } from "./units"

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

	/**
	 * Lot E cutover: the per-tool handler factories come from the migrated tool
	 * *units* (`getUnits()`), built lazily into a name→factory map. This removes
	 * the previously-duplicated `toolHandlersMap`.
	 *
	 * Four tools have no unit and keep their legacy registration here, reproducing
	 * the exact prior behavior:
	 *  - `new_rule`       — SharedToolHandler aliasing the write_to_file handler.
	 *  - `use_subagents`  — dynamic per-subagent names (see `getHandler`).
	 *  - `condense`       — slash-command only.
	 *  - `report_bug`     — slash-command only.
	 */
	private readonly legacyHandlersMap: Partial<Record<IsaacDefaultTool, (v: ToolValidator) => IToolHandler | undefined>> = {
		[IsaacDefaultTool.NEW_RULE]: (v: ToolValidator) =>
			new SharedToolHandler(IsaacDefaultTool.NEW_RULE, new WriteToFileToolHandler(v)),
		[IsaacDefaultTool.CONDENSE]: (_v: ToolValidator) => new CondenseHandler(),
		[IsaacDefaultTool.REPORT_BUG]: (_v: ToolValidator) => new ReportBugHandler(),
		[IsaacDefaultTool.USE_SUBAGENTS]: (_v: ToolValidator) => new UseSubagentsToolHandler(),
	}

	private unitHandlerFactories?: Map<IsaacDefaultTool, (v: ToolValidator) => IToolHandler | undefined>

	private getHandlerFactory(toolName: IsaacDefaultTool): ((v: ToolValidator) => IToolHandler | undefined) | undefined {
		if (!this.unitHandlerFactories) {
			this.unitHandlerFactories = new Map()
			for (const unit of getUnits()) {
				this.unitHandlerFactories.set(unit.id, (v: ToolValidator) => unit.createHandler(v))
			}
		}
		return this.unitHandlerFactories.get(toolName) ?? this.legacyHandlersMap[toolName]
	}

	/**
	 * Register a tool handler
	 */
	register(handler: IToolHandler): void {
		this.handlers.set(handler.name, handler)
	}

	registerByName(toolName: IsaacDefaultTool, validator: ToolValidator): void {
		const handler = this.getHandlerFactory(toolName)?.(validator)
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
