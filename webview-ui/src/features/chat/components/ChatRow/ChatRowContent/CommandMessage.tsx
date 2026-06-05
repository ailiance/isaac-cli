import { IsaacMessage } from "@shared/ExtensionMessage"
import { memo } from "react"
import { CommandOutputRow } from "@/features/chat/components/CommandOutputRow"

interface CommandMessageProps {
	message: IsaacMessage
	icon: JSX.Element | null
	title: JSX.Element | null
	isCommandExecuting: boolean
	isCommandPending: boolean
	isCommandCompleted: boolean
	isOutputFullyExpanded: boolean
	setIsOutputFullyExpanded: (expanded: boolean) => void
	onCancelCommand?: () => void
	vscodeTerminalExecutionMode: string | undefined
}

export const CommandMessage = memo(
	({
		message,
		icon,
		title,
		isCommandExecuting,
		isCommandPending,
		isCommandCompleted,
		isOutputFullyExpanded,
		setIsOutputFullyExpanded,
		onCancelCommand,
		vscodeTerminalExecutionMode,
	}: CommandMessageProps) => {
		return (
			<CommandOutputRow
				icon={icon}
				isBackgroundExec={true}
				isCommandCompleted={isCommandCompleted}
				isCommandExecuting={isCommandExecuting}
				isCommandPending={isCommandPending}
				isOutputFullyExpanded={isOutputFullyExpanded}
				message={message}
				onCancelCommand={onCancelCommand}
				setIsOutputFullyExpanded={setIsOutputFullyExpanded}
				title={title}
			/>
		)
	},
)

CommandMessage.displayName = "CommandMessage"
