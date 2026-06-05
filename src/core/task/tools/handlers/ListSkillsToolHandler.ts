import type { ToolUse } from "@core/assistant-message"
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
		const projectSkills = skills.filter(s => s.source === "project")
		const globalSkills = skills.filter(s => s.source === "global")
		
		const sortedSkills = [...projectSkills, ...globalSkills]

		sortedSkills.forEach(skill => {
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
