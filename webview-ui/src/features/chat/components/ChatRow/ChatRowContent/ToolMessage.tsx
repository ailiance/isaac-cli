import { IsaacMessage, IsaacSayTool } from "@shared/ExtensionMessage"
import { memo } from "react"
import { ToolOutput } from "../ToolOutput"

interface ToolMessageProps {
	message: IsaacMessage
	tool: IsaacSayTool
	isExpanded: boolean
	onToggleExpand: (ts: number) => void
	backgroundEditEnabled: boolean | undefined
}

export const ToolMessage = memo(({ message, tool, isExpanded, onToggleExpand, backgroundEditEnabled }: ToolMessageProps) => {
	return (
		<ToolOutput
			backgroundEditEnabled={backgroundEditEnabled}
			isExpanded={isExpanded}
			message={message}
			onToggleExpand={onToggleExpand}
			tool={tool}
		/>
	)
})

ToolMessage.displayName = "ToolMessage"
