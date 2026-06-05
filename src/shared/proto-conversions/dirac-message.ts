import { IsaacAsk as AppIsaacAsk, IsaacMessage as AppIsaacMessage, IsaacSay as AppIsaacSay } from "@shared/ExtensionMessage"
import { IsaacAsk, IsaacMessageType, IsaacSay, IsaacMessage as ProtoIsaacMessage } from "@shared/proto/isaac/ui"

// Helper function to convert IsaacAsk string to enum
function convertIsaacAskToProtoEnum(ask: AppIsaacAsk | undefined): IsaacAsk | undefined {
	if (!ask) {
		return undefined
	}

	const mapping: Record<AppIsaacAsk, IsaacAsk> = {
		followup: IsaacAsk.FOLLOWUP,
		plan_mode_respond: IsaacAsk.PLAN_MODE_RESPOND,
		act_mode_respond: IsaacAsk.ACT_MODE_RESPOND,
		command: IsaacAsk.COMMAND,
		command_output: IsaacAsk.COMMAND_OUTPUT,
		completion_result: IsaacAsk.COMPLETION_RESULT,
		tool: IsaacAsk.TOOL,
		api_req_failed: IsaacAsk.API_REQ_FAILED,
		resume_task: IsaacAsk.RESUME_TASK,
		resume_completed_task: IsaacAsk.RESUME_COMPLETED_TASK,
		storage: IsaacAsk.STORAGE,
		mistake_limit_reached: IsaacAsk.MISTAKE_LIMIT_REACHED,
		browser_action_launch: IsaacAsk.BROWSER_ACTION_LAUNCH,
		new_task: IsaacAsk.NEW_TASK,
		condense: IsaacAsk.CONDENSE,
		summarize_task: IsaacAsk.SUMMARIZE_TASK,
		report_bug: IsaacAsk.REPORT_BUG,
		use_subagents: IsaacAsk.USE_SUBAGENTS,
	}

	const result = mapping[ask]
	if (result === undefined) {
	}
	return result
}

// Helper function to convert IsaacAsk enum to string
function convertProtoEnumToIsaacAsk(ask: IsaacAsk): AppIsaacAsk | undefined {
	if (ask === IsaacAsk.UNRECOGNIZED) {
		return undefined
	}

	const mapping: Record<Exclude<IsaacAsk, IsaacAsk.UNRECOGNIZED>, AppIsaacAsk> = {
		[IsaacAsk.FOLLOWUP]: "followup",
		[IsaacAsk.PLAN_MODE_RESPOND]: "plan_mode_respond",
		[IsaacAsk.ACT_MODE_RESPOND]: "act_mode_respond",
		[IsaacAsk.COMMAND]: "command",
		[IsaacAsk.COMMAND_OUTPUT]: "command_output",
		[IsaacAsk.COMPLETION_RESULT]: "completion_result",
		[IsaacAsk.TOOL]: "tool",
		[IsaacAsk.API_REQ_FAILED]: "api_req_failed",
		[IsaacAsk.RESUME_TASK]: "resume_task",
		[IsaacAsk.RESUME_COMPLETED_TASK]: "resume_completed_task",
		[IsaacAsk.MISTAKE_LIMIT_REACHED]: "mistake_limit_reached",
		[IsaacAsk.BROWSER_ACTION_LAUNCH]: "browser_action_launch",
		[IsaacAsk.NEW_TASK]: "new_task",
		[IsaacAsk.CONDENSE]: "condense",
		[IsaacAsk.SUMMARIZE_TASK]: "summarize_task",
		[IsaacAsk.REPORT_BUG]: "report_bug",
		[IsaacAsk.USE_SUBAGENTS]: "use_subagents",
		[IsaacAsk.STORAGE]: "storage",
	}

	return mapping[ask]
}

// Helper function to convert IsaacSay string to enum
function convertIsaacSayToProtoEnum(say: AppIsaacSay | undefined): IsaacSay | undefined {
	if (!say) {
		return undefined
	}

	const mapping: Record<AppIsaacSay, IsaacSay> = {
		task: IsaacSay.TASK,
		error: IsaacSay.ERROR,
		api_req_started: IsaacSay.API_REQ_STARTED,
		api_req_finished: IsaacSay.API_REQ_FINISHED,
		text: IsaacSay.TEXT,
		reasoning: IsaacSay.REASONING,
		completion_result: IsaacSay.COMPLETION_RESULT_SAY,
		user_feedback: IsaacSay.USER_FEEDBACK,
		user_feedback_diff: IsaacSay.USER_FEEDBACK_DIFF,
		api_req_retried: IsaacSay.API_REQ_RETRIED,
		command: IsaacSay.COMMAND_SAY,
		command_output: IsaacSay.COMMAND_OUTPUT_SAY,
		tool: IsaacSay.TOOL_SAY,
		shell_integration_warning: IsaacSay.SHELL_INTEGRATION_WARNING,
		shell_integration_warning_with_suggestion: IsaacSay.SHELL_INTEGRATION_WARNING,
		browser_action_launch: IsaacSay.BROWSER_ACTION_LAUNCH_SAY,
		browser_action: IsaacSay.BROWSER_ACTION,
		browser_action_result: IsaacSay.BROWSER_ACTION_RESULT,
		diff_error: IsaacSay.DIFF_ERROR,
		deleted_api_reqs: IsaacSay.DELETED_API_REQS,
		diracignore_error: IsaacSay.DIRACIGNORE_ERROR,
		command_permission_denied: IsaacSay.COMMAND_PERMISSION_DENIED,
		checkpoint_created: IsaacSay.CHECKPOINT_CREATED,
		info: IsaacSay.INFO,
		error_retry: IsaacSay.ERROR_RETRY,
		hook_status: IsaacSay.HOOK_STATUS,
		hook_output_stream: IsaacSay.HOOK_OUTPUT_STREAM,
		conditional_rules_applied: IsaacSay.CONDITIONAL_RULES_APPLIED,
		subagent: IsaacSay.SUBAGENT_STATUS,
		use_subagents: IsaacSay.USE_SUBAGENTS_SAY,
		subagent_usage: IsaacSay.SUBAGENT_USAGE,
		generate_explanation: IsaacSay.GENERATE_EXPLANATION,
	}

	const result = mapping[say]

	return result
}

// Helper function to convert IsaacSay enum to string
function convertProtoEnumToIsaacSay(say: IsaacSay): AppIsaacSay | undefined {
	if (say === IsaacSay.UNRECOGNIZED) {
		return undefined
	}

	const mapping: Record<Exclude<IsaacSay, IsaacSay.UNRECOGNIZED>, AppIsaacSay> = {
		[IsaacSay.TASK]: "task",
		[IsaacSay.ERROR]: "error",
		[IsaacSay.API_REQ_STARTED]: "api_req_started",
		[IsaacSay.API_REQ_FINISHED]: "api_req_finished",
		[IsaacSay.TEXT]: "text",
		[IsaacSay.REASONING]: "reasoning",
		[IsaacSay.COMPLETION_RESULT_SAY]: "completion_result",
		[IsaacSay.USER_FEEDBACK]: "user_feedback",
		[IsaacSay.USER_FEEDBACK_DIFF]: "user_feedback_diff",
		[IsaacSay.API_REQ_RETRIED]: "api_req_retried",
		[IsaacSay.COMMAND_SAY]: "command",
		[IsaacSay.COMMAND_OUTPUT_SAY]: "command_output",
		[IsaacSay.TOOL_SAY]: "tool",
		[IsaacSay.SHELL_INTEGRATION_WARNING]: "shell_integration_warning",
		[IsaacSay.BROWSER_ACTION_LAUNCH_SAY]: "browser_action_launch",
		[IsaacSay.BROWSER_ACTION]: "browser_action",
		[IsaacSay.BROWSER_ACTION_RESULT]: "browser_action_result",
		[IsaacSay.DIFF_ERROR]: "diff_error",
		[IsaacSay.DELETED_API_REQS]: "deleted_api_reqs",
		[IsaacSay.DIRACIGNORE_ERROR]: "diracignore_error",
		[IsaacSay.COMMAND_PERMISSION_DENIED]: "command_permission_denied",
		[IsaacSay.CHECKPOINT_CREATED]: "checkpoint_created",
		[IsaacSay.INFO]: "info",
		[IsaacSay.ERROR_RETRY]: "error_retry",
		[IsaacSay.GENERATE_EXPLANATION]: "generate_explanation",
		[IsaacSay.HOOK_STATUS]: "hook_status",
		[IsaacSay.HOOK_OUTPUT_STREAM]: "hook_output_stream",
		[IsaacSay.CONDITIONAL_RULES_APPLIED]: "conditional_rules_applied",
		[IsaacSay.SUBAGENT_STATUS]: "subagent",
		[IsaacSay.USE_SUBAGENTS_SAY]: "use_subagents",
		[IsaacSay.SUBAGENT_USAGE]: "subagent_usage",
	}

	return mapping[say]
}

/**
 * Convert application IsaacMessage to proto IsaacMessage
 */
export function convertIsaacMessageToProto(message: AppIsaacMessage): ProtoIsaacMessage {
	// For sending messages, we need to provide values for required proto fields
	const askEnum = message.ask ? convertIsaacAskToProtoEnum(message.ask) : undefined
	const sayEnum = message.say ? convertIsaacSayToProtoEnum(message.say) : undefined

	// Determine appropriate enum values based on message type
	let finalAskEnum: IsaacAsk = IsaacAsk.FOLLOWUP // Proto default
	let finalSayEnum: IsaacSay = IsaacSay.TEXT // Proto default

	if (message.type === "ask") {
		finalAskEnum = askEnum ?? IsaacAsk.FOLLOWUP // Use FOLLOWUP as default for ask messages
	} else if (message.type === "say") {
		finalSayEnum = sayEnum ?? IsaacSay.TEXT // Use TEXT as default for say messages
	}

	const protoMessage: ProtoIsaacMessage = {
		ts: message.ts,
		type: message.type === "ask" ? IsaacMessageType.ASK : IsaacMessageType.SAY,
		ask: finalAskEnum,
		say: finalSayEnum,
		text: message.text ?? "",
		reasoning: message.reasoning ?? "",
		images: message.images ?? [],
		files: message.files ?? [],
		partial: message.partial ?? false,
		lastCheckpointHash: message.lastCheckpointHash ?? "",
		isCheckpointCheckedOut: message.isCheckpointCheckedOut ?? false,
		isOperationOutsideWorkspace: message.isOperationOutsideWorkspace ?? false,
		conversationHistoryIndex: message.conversationHistoryIndex ?? 0,
		conversationHistoryDeletedRange: message.conversationHistoryDeletedRange
			? {
					startIndex: message.conversationHistoryDeletedRange[0],
					endIndex: message.conversationHistoryDeletedRange[1],
				}
			: undefined,
		// Additional optional fields for specific ask/say types
		sayTool: undefined,
		sayBrowserAction: undefined,
		browserActionResult: undefined,
		planModeResponse: undefined,
		askQuestion: undefined,
		askNewTask: undefined,
		apiReqInfo: undefined,
		modelInfo: message.modelInfo ?? undefined,
		multiCommandState: message.multiCommandState
			? {
					commands: message.multiCommandState.commands.map((cmd) => ({
						command: cmd.command,
						status: cmd.status,
						output: cmd.output ?? undefined,
						exitCode: cmd.exitCode ?? undefined,
						signal: cmd.signal ?? undefined,
						requiresApproval: cmd.requiresApproval ?? undefined,
						wasAutoApproved: cmd.wasAutoApproved ?? undefined,
					})),
				}
			: undefined,

	}

	return protoMessage
}

/**
 * Convert proto IsaacMessage to application IsaacMessage
 */
export function convertProtoToIsaacMessage(protoMessage: ProtoIsaacMessage): AppIsaacMessage {
	const message: AppIsaacMessage = {
		ts: protoMessage.ts,
		type: protoMessage.type === IsaacMessageType.ASK ? "ask" : "say",
	}

	// Convert ask enum to string
	if (protoMessage.type === IsaacMessageType.ASK) {
		const ask = convertProtoEnumToIsaacAsk(protoMessage.ask)
		if (ask !== undefined) {
			message.ask = ask
		}
	}

	// Convert say enum to string
	if (protoMessage.type === IsaacMessageType.SAY) {
		const say = convertProtoEnumToIsaacSay(protoMessage.say)
		if (say !== undefined) {
			message.say = say
		}
	}

	// Convert other fields - preserve empty strings as they may be intentional
	if (protoMessage.text !== "") {
		message.text = protoMessage.text
	}
	if (protoMessage.reasoning !== "") {
		message.reasoning = protoMessage.reasoning
	}
	if (protoMessage.images.length > 0) {
		message.images = protoMessage.images
	}
	if (protoMessage.files.length > 0) {
		message.files = protoMessage.files
	}
	if (protoMessage.partial) {
		message.partial = protoMessage.partial
	}
	if (protoMessage.lastCheckpointHash !== "") {
		message.lastCheckpointHash = protoMessage.lastCheckpointHash
	}
	if (protoMessage.isCheckpointCheckedOut) {
		message.isCheckpointCheckedOut = protoMessage.isCheckpointCheckedOut
	}
	if (protoMessage.isOperationOutsideWorkspace) {
		message.isOperationOutsideWorkspace = protoMessage.isOperationOutsideWorkspace
	}
	if (protoMessage.conversationHistoryIndex !== 0) {
		message.conversationHistoryIndex = protoMessage.conversationHistoryIndex
	}

	// Convert conversationHistoryDeletedRange from object to tuple
	if (protoMessage.conversationHistoryDeletedRange) {
		message.conversationHistoryDeletedRange = [
			protoMessage.conversationHistoryDeletedRange.startIndex,
			protoMessage.conversationHistoryDeletedRange.endIndex,
		]
	}

	if (protoMessage.multiCommandState) {
		message.multiCommandState = {
			commands: protoMessage.multiCommandState.commands.map((cmd) => ({
				command: cmd.command,
				status: cmd.status as any,
				output: cmd.output ?? undefined,
				exitCode: cmd.exitCode ?? undefined,
				signal: cmd.signal ?? undefined,
				requiresApproval: cmd.requiresApproval ?? undefined,
				wasAutoApproved: cmd.wasAutoApproved ?? undefined,
			})),
		}
	}


	return message
}
