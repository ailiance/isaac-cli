import { AgentConfigLoader } from "@core/task/tools/subagent/AgentConfigLoader"
import { IsaacDefaultTool } from "@/shared/tools"
import { type IsaacToolSpec, toolSpecFunctionDefinition } from "../spec"
import { SystemPromptContext } from "../types"

export class IsaacToolSet {
	private static tools: Map<string, IsaacToolSet> = new Map()

	private constructor(
		public readonly id: string,
		public readonly config: IsaacToolSpec,
	) {
		this._register()
	}

	public static register(config: IsaacToolSpec): IsaacToolSet {
		return new IsaacToolSet(config.id, config)
	}

	private _register(): void {
		if (!IsaacToolSet.tools.has(this.config.id)) {
			IsaacToolSet.tools.set(this.config.id, this)
		}
	}

	public static getTools(): IsaacToolSet[] {
		return Array.from(IsaacToolSet.tools.values())
	}

	public static getToolByName(toolName: string): IsaacToolSet | undefined {
		return IsaacToolSet.tools.get(toolName)
	}

	public static getEnabledTools(context: SystemPromptContext): IsaacToolSet[] {
		return Array.from(IsaacToolSet.tools.values()).filter(
			(tool) => !tool.config.contextRequirements || tool.config.contextRequirements(context),
		)
	}

	private static getDynamicSubagentToolSpecs(context: SystemPromptContext): IsaacToolSpec[] {
		if (context.subagentsEnabled !== true) {
			return []
		}

		const agentConfigs = AgentConfigLoader.getInstance().getAllCachedConfigsWithToolNames()
		return agentConfigs.map(({ toolName, config }) => ({
			id: IsaacDefaultTool.USE_SUBAGENTS,
			name: toolName,
			description: `Use the "${config.name}" subagent: ${config.description}`,
			contextRequirements: (ctx) => ctx.subagentsEnabled === true,
			parameters: [
				{
					name: "prompt",
					required: true,
					instruction: "Helpful instruction for the task that the subagent will perform.",
				},
				{
					name: "timeout",
					required: false,
					instruction: "Optional timeout in seconds for the subagent.",
				},
				{
					name: "max_turns",
					required: false,
					instruction: "Optional maximum number of turns for the subagent.",
				},
			],
		}))
	}

	public static getEnabledToolSpecs(context: SystemPromptContext): IsaacToolSpec[] {
		const registeredTools = IsaacToolSet.getEnabledTools(context).map((tool) => tool.config)
		const dynamicSubagentTools = IsaacToolSet.getDynamicSubagentToolSpecs(context)

		const includesDynamicSubagents = dynamicSubagentTools.length > 0
		const filteredRegistered = includesDynamicSubagents
			? registeredTools.filter((tool) => tool.id !== IsaacDefaultTool.USE_SUBAGENTS)
			: registeredTools

		return [...filteredRegistered, ...dynamicSubagentTools]
	}

	/**
	 * Get the appropriate native tool converter for the given provider.
	 * All supported providers (openai, dirac, openrouter, lmstudio, litellm, vscode-lm)
	 * use the OpenAI-compatible tool schema.
	 */
	public static getNativeConverter(_providerId: string, _modelId?: string) {
		return (tool: IsaacToolSpec, ctx: SystemPromptContext) =>
			toolSpecFunctionDefinition(tool, ctx, ctx.providerInfo?.model?.info?.supportsStrictTools ?? false)
	}

	public static getNativeTools(context: SystemPromptContext) {
		// Base set
		const toolConfigs = IsaacToolSet.getEnabledToolSpecs(context)

		const enabledTools = toolConfigs.filter(
			(tool) => typeof tool.description === "string" && tool.description.trim().length > 0,
		)
		const providerId = context.providerInfo?.providerId || "openai"
		const modelId = context.providerInfo?.model?.id
		const converter = IsaacToolSet.getNativeConverter(providerId, modelId)

		return enabledTools.map((tool) => converter(tool, context))
	}
}
