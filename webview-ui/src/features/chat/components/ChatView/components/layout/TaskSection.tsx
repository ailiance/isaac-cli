import { IsaacApiReqInfo, IsaacMessage } from "@shared/ExtensionMessage"
import React from "react"
import TaskHeader from "@/features/chat/components/TaskHeader/TaskHeader"
import { MessageHandlers } from "../../types/chatTypes"

interface TaskSectionProps {
	task: IsaacMessage
	lastApiReqInfo?: IsaacApiReqInfo
	apiMetrics: {
		totalCost: number
	}
	messageHandlers: MessageHandlers
}

/**
 * Task section shown when there's an active task
 * Includes the task header and manages task-specific UI
 */
export const TaskSection: React.FC<TaskSectionProps> = ({
	task,
	lastApiReqInfo,
	apiMetrics,
	messageHandlers,
}) => {
	return (
		<TaskHeader
			onClose={messageHandlers.handleTaskCloseButtonClick}
			onSendMessage={messageHandlers.handleSendMessage}
			task={task}
			totalCost={apiMetrics.totalCost}
			lastApiReqInfo={lastApiReqInfo}
		/>
	)
}
