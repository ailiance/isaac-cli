import type { IsaacAsk, IsaacSay, MultiCommandState } from "@shared/ExtensionMessage"
import type { IsaacDefaultTool } from "@shared/tools"
import type { IsaacAskResponse } from "@shared/WebviewMessage"
import { telemetryService } from "@/services/telemetry"
import type { ToolParamName, ToolUse } from "../../../assistant-message"
import { showNotificationForApproval } from "../../utils"
import { removeClosingTag } from "../utils/ToolConstants"
import type { TaskConfig } from "./TaskConfig"

/**
 * Strongly-typed UI helper functions for tool handlers
 */
export interface StronglyTypedUIHelpers {
	// Core UI methods
	say: (type: IsaacSay, text?: string, images?: string[], files?: string[], partial?: boolean, multiCommandState?: MultiCommandState) => Promise<number | undefined>

	ask: (
		type: IsaacAsk,
		text?: string,
		partial?: boolean,
		multiCommandState?: MultiCommandState,
	) => Promise<{
		response: IsaacAskResponse
		text?: string
		images?: string[]
		files?: string[]
	}>

	// Utility methods
	removeClosingTag: (block: ToolUse, tag: ToolParamName, text?: any) => string
	removeLastPartialMessageIfExistsWithType: (type: "ask" | "say", askOrSay: IsaacAsk | IsaacSay, onlyPartial?: boolean) => Promise<void>

	// Approval methods
	shouldAutoApproveTool: (toolName: IsaacDefaultTool) => boolean | [boolean, boolean]
	shouldAutoApproveToolWithPath: (toolName: IsaacDefaultTool, path?: string) => Promise<boolean>
	askApproval: (messageType: IsaacAsk, message: string) => Promise<boolean>

	// Telemetry and notifications
	captureTelemetry: (toolName: IsaacDefaultTool, autoApproved: boolean, approved: boolean, isNativeToolCall?: boolean) => void
	showNotificationIfEnabled: (message: string) => void

	// Config access - returns the proper typed config
	getConfig: () => TaskConfig
}

/**
 * Creates strongly-typed UI helpers from a TaskConfig
 */
export function createUIHelpers(config: TaskConfig): StronglyTypedUIHelpers {
	return {
		say: config.callbacks.say,
		ask: config.callbacks.ask,
		removeClosingTag: (block: ToolUse, tag: ToolParamName, text?: any) => removeClosingTag(block, tag, text),
		removeLastPartialMessageIfExistsWithType: (type: "ask" | "say", askOrSay: IsaacAsk | IsaacSay, onlyPartial?: boolean) => config.callbacks.removeLastPartialMessageIfExistsWithType(type, askOrSay, onlyPartial),
		shouldAutoApproveTool: (toolName: IsaacDefaultTool) => config.autoApprover.shouldAutoApproveTool(toolName),
		shouldAutoApproveToolWithPath: config.callbacks.shouldAutoApproveToolWithPath,
		askApproval: async (messageType: IsaacAsk, message: string): Promise<boolean> => {
			const { response } = await config.callbacks.ask(messageType, message, false)
			return response === "yesButtonClicked"
		},
		captureTelemetry: (toolName: IsaacDefaultTool, autoApproved: boolean, approved: boolean, isNativeToolCall?: boolean) => {
			// Extract provider information for telemetry
			const apiConfig = config.services.stateManager.getApiConfiguration()
			const currentMode = config.services.stateManager.getGlobalSettingsKey("mode")
			const provider = (currentMode === "plan" ? apiConfig.planModeApiProvider : apiConfig.actModeApiProvider) as string

			telemetryService.captureToolUsage(
				config.ulid,
				toolName,
				config.api.getModel().id,
				provider,
				autoApproved,
				approved,
				undefined,
				isNativeToolCall,
			)
		},
		showNotificationIfEnabled: (message: string) => {
			showNotificationForApproval(message, config.autoApprovalSettings.enableNotifications)
		},
		getConfig: () => config,
	}
}
