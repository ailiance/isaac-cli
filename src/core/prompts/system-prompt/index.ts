import { Logger } from "@/shared/services/Logger"
import { PromptRegistry } from "./registry/PromptRegistry"
import type { SystemPromptContext } from "./types"

export { IsaacToolSet } from "./registry/IsaacToolSet"
export { SubagentBuilder } from "../../task/tools/subagent/SubagentBuilder"
export { PromptBuilder } from "./registry/PromptBuilder"
export { PromptRegistry } from "./registry/PromptRegistry"
export * from "./templates/placeholders"
export { TemplateEngine } from "./templates/TemplateEngine"
export * from "./types"

/**
 * Get the system prompt
 */
export async function getSystemPrompt(context: SystemPromptContext) {
	const registry = PromptRegistry.getInstance()
	const systemPrompt = await registry.get(context)
	const tools = registry.nativeTools

	Logger.log(`[DEBUG] System prompt char length: ${systemPrompt.length}`)

	return { systemPrompt, tools }
}
