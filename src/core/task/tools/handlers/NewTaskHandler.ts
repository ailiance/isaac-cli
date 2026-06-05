import type { ToolUse } from "@core/assistant-message"
import { formatResponse } from "@core/prompts/responses"
import { defineTool, readParam } from "@core/prompts/system-prompt/tool-unit"
import { new_task } from "@core/prompts/system-prompt/tools/new_task"
import { processFilesIntoText } from "@integrations/misc/extract-text"
import { showSystemNotification } from "@integrations/notifications"
import { telemetryService } from "@/services/telemetry"
import { IsaacDefaultTool } from "@/shared/tools"
import type { ToolResponse } from "../../index"
import type { IPartialBlockHandler, IToolHandler } from "../ToolExecutorCoordinator"
import type { TaskConfig } from "../types/TaskConfig"
import type { StronglyTypedUIHelpers } from "../types/UIHelpers"

export class NewTaskHandler implements IToolHandler, IPartialBlockHandler {
	readonly name = IsaacDefaultTool.NEW_TASK
	constructor() {}

	getDescription(block: ToolUse): string {
		return `[${block.name} for creating a new task]`
	}

	/**
	 * Handle partial block streaming for new_task
	 */
	async handlePartialBlock(block: ToolUse, uiHelpers: StronglyTypedUIHelpers): Promise<void> {
		const context = uiHelpers.removeClosingTag(block, "context", block.params.context)
		if (!context) {
			return
		}

		await uiHelpers.ask(this.name, context, true).catch(() => {})
	}

	async execute(config: TaskConfig, block: ToolUse): Promise<ToolResponse> {
		// Lot E: read scalar param through the typed contract derived from the
		// spec. Renaming `context` in the spec breaks this handler's compile.
		const context: string | undefined = readParam(new_task_unit, block.params, "context")

		// Validate required parameters
		if (!context) {
			config.taskState.consecutiveMistakeCount++
			return await config.callbacks.sayAndCreateMissingParamError(block.name, "context")
		}

		config.taskState.consecutiveMistakeCount = 0

		// Show notification if enabled
		if (config.autoApprovalSettings.enableNotifications) {
			showSystemNotification({
				subtitle: "Isaac wants to start a new task...",
				message: `Isaac is suggesting to start a new task with: ${context}`,
			})
		}

		// Ask user for response
		await config.callbacks.removeLastPartialMessageIfExistsWithType("ask", this.name as any)
		const { text, images, files: newTaskFiles } = await config.callbacks.ask(this.name, context, false)

		// If the user provided a response, treat it as feedback
		if (text || (images && images.length > 0) || (newTaskFiles && newTaskFiles.length > 0)) {
			let fileContentString = ""
			if (newTaskFiles && newTaskFiles.length > 0) {
				fileContentString = await processFilesIntoText(newTaskFiles)
			}

			await config.callbacks.say("user_feedback", text ?? "", images, newTaskFiles)
			const apiConfig = config.services.stateManager.getApiConfiguration()
			const provider = (config.mode === "plan" ? apiConfig.planModeApiProvider : apiConfig.actModeApiProvider) as string

			telemetryService.captureToolUsage(
				config.ulid,
				this.name,
				config.api.getModel().id,
				provider,
				false, // autoApproved - new_task is never auto-approved
				false, // success=false because user provided feedback instead
				undefined,
				block.isNativeToolCall,
			)

			return formatResponse.toolResult(
				`The user provided feedback instead of creating a new task:
<feedback>
${text}
</feedback>`,

				images,
				fileContentString,
			)
		}
		// If no response, the user clicked the "Create New Task" button
		const apiConfig = config.services.stateManager.getApiConfiguration()
		const provider = (config.mode === "plan" ? apiConfig.planModeApiProvider : apiConfig.actModeApiProvider) as string

		telemetryService.captureToolUsage(
			config.ulid,
			this.name,
			config.api.getModel().id,
			provider,
			false, // autoApproved - new_task is never auto-approved
			true,
			undefined,
			block.isNativeToolCall,
		)

		return formatResponse.toolResult(`The user has created a new task with the provided context.`)
	}
}

/**
 * Lot E — unified tool unit for `new_task`. Co-locates the prompt spec with the
 * handler factory and the read-only flag, exposing the drift-detecting typed
 * link between spec params and the handler. This handler takes no validator.
 * Coexists with the legacy registration paths (no cutover yet).
 */
export const new_task_unit = defineTool({
	id: IsaacDefaultTool.NEW_TASK,
	spec: new_task,
	readonly: true,
	createHandler: (_validator: unknown) => new NewTaskHandler(),
})
