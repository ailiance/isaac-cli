import type { ToolUse } from "@core/assistant-message"
import { defineTool } from "@core/prompts/system-prompt/tool-unit"
import { list_skills } from "@core/prompts/system-prompt/tools/list_skills"
import { IsaacDefaultTool } from "@/shared/tools"
import type { ToolResponse } from "../../index"
import type { IPartialBlockHandler, IToolHandler } from "../ToolExecutorCoordinator"
import type { TaskConfig } from "../types/TaskConfig"
import type { StronglyTypedUIHelpers } from "../types/UIHelpers"

export class ListSkillsToolHandler implements IToolHandler, IPartialBlockHandler {
	readonly name = IsaacDefaultTool.LIST_SKILLS

	constructor() {}

	getDescription(_block: ToolUse): string {
		return `[${this.name}]`
	}

	async handlePartialBlock(block: ToolUse, uiHelpers: StronglyTypedUIHelpers): Promise<void> {
		if (uiHelpers.getConfig().isSubagentExecution) {
			return
		}
		const message = JSON.stringify({ tool: "listSkills" })
		await uiHelpers.say("tool", message, undefined, undefined, true)
	}

	async execute(config: TaskConfig, _block: ToolUse): Promise<ToolResponse> {
		const skills = config.taskState.availableSkills || []
		if (skills.length === 0) {
			return "No skills are currently available."
		}

		let response = "# AVAILABLE SKILLS\n\n"

		// Prioritize Project skills
		const projectSkills = skills.filter((s) => s.source === "project")
		const globalSkills = skills.filter((s) => s.source === "global")

		const sortedSkills = [...projectSkills, ...globalSkills]

		sortedSkills.forEach((skill) => {
			response += `- ${skill.name}: ${skill.description}\n`
		})

		response += "\nUse the 'use_skill' tool to activate a skill."

		const message = JSON.stringify({ tool: "listSkills", content: response })
		if (!config.isSubagentExecution) {
			await config.callbacks.removeLastPartialMessageIfExistsWithType("say", "tool")
			await config.callbacks.say("tool", message, undefined, undefined, false)
		}

		return response
	}
}

/**
 * Lot E — unified tool unit for `list_skills`. Co-locates the prompt spec with
 * the handler factory and the read-only flag. This tool has no parameters and the
 * handler takes no validator. Coexists with the legacy registration paths (no
 * cutover yet).
 */
export const list_skills_unit = defineTool({
	id: IsaacDefaultTool.LIST_SKILLS,
	spec: list_skills,
	readonly: true,
	createHandler: (_validator: unknown) => new ListSkillsToolHandler(),
})
