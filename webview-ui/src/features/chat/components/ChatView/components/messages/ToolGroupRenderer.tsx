import { IsaacApiReqInfo, IsaacMessage, IsaacSayTool } from "@shared/ExtensionMessage"
import { StringRequest } from "@shared/proto/isaac/common"
import { memo, useCallback, useMemo, useState } from "react"
import { cn } from "@/lib/utils"
import { FileServiceClient } from "@/shared/api/grpc-client"
import { getToolsNotInCurrentActivities } from "../../utils/messageUtils"
import { serializeToolToDisplayUnits } from "../../utils/toolSerialization"
import { ToolRow } from "../../../ChatRow/ToolRow"
import { getComponentForTool } from "../../../ChatRow/ToolRegistry"
import { DisplayUnit } from "../../../ChatRow/types"
import { RequestStartRow } from "../../../RequestStartRow"

interface ToolGroupRendererProps {
	messages: IsaacMessage[]
	allMessages: IsaacMessage[]
	isLastGroup: boolean
}

const getCurrentActivities = (allMessages: IsaacMessage[]): IsaacMessage[] => {
	let currentApiReqIndex = -1
	let lastFinishedApiReqIndex = -1
	for (let i = allMessages.length - 1; i >= 0; i--) {
		const msg = allMessages[i]
		if (msg.say === "api_req_started" && msg.text) {
			try {
				const info = JSON.parse(msg.text)
				const hasCost = info.cost != null
				if (!hasCost) {
					currentApiReqIndex = i
					break
				} else {
					if (lastFinishedApiReqIndex === -1) {
						lastFinishedApiReqIndex = i
					}
				}
			} catch {
				// ignore
			}
		}
	}

	const startIndex = currentApiReqIndex !== -1 ? currentApiReqIndex : lastFinishedApiReqIndex

	if (startIndex === -1) {
		return []
	}

	const activities: IsaacMessage[] = []
	for (let i = startIndex + 1; i < allMessages.length; i++) {
		const msg = allMessages[i]
		if (msg.say !== "tool" && msg.ask !== "tool") {
			continue
		}
		// If the API request is finished, we only include tools that are still marked as partial
		if (currentApiReqIndex === -1 && !msg.partial) {
			continue
		}
		activities.push(msg)
	}

	return activities
}

export const ToolGroupRenderer = memo(({ messages, allMessages, isLastGroup }: ToolGroupRendererProps) => {
	const [expandedItems, setExpandedItems] = useState<Record<string, boolean>>({})

	const apiReqMessage = useMemo(() => messages.find((m) => m.say === "api_req_started"), [messages])
	const apiReqInfo = useMemo(() => {
		if (!apiReqMessage?.text) return undefined
		try {
			return JSON.parse(apiReqMessage.text) as IsaacApiReqInfo
		} catch {
			return undefined
		}
	}, [apiReqMessage])

	const filteredMessages = useMemo(() => getToolsNotInCurrentActivities(messages, allMessages), [messages, allMessages])

	const currentActivities = useMemo(() => {
		if (!isLastGroup) return []
		return getCurrentActivities(allMessages)
	}, [allMessages, isLastGroup])

	const displayUnits = useMemo(() => {
		const units: (DisplayUnit & { tool: IsaacSayTool; message: IsaacMessage })[] = []

		// Add completed tools
		filteredMessages.forEach((msg) => {
			if (msg.say !== "tool" && msg.ask !== "tool") return

			try {
				const parsedTool = JSON.parse(msg.text || "{}")
				const toolUnits = serializeToolToDisplayUnits(parsedTool, msg)
				units.push(
					...toolUnits.map((u) => ({
						...u,
						hasComponent: !!getComponentForTool(u.type),
						tool: parsedTool,
						message: msg,
					}))
				)
			} catch (e) {
				console.error("Failed to parse tool message", e)
			}
		})

		// Add active tools
		currentActivities.forEach((msg) => {
			if (msg.say !== "tool" && msg.ask !== "tool") return

			try {
				const parsedTool = JSON.parse(msg.text || "{}")
				const toolUnits = serializeToolToDisplayUnits(parsedTool, msg, "active")
				units.push(
					...toolUnits.map((u) => ({
						...u,
						hasComponent: !!getComponentForTool(u.type),
						tool: parsedTool,
						message: msg,
					}))
				)
			} catch (e) {
				console.error("Failed to parse active tool message", e)
			}
		})

		return units
	}, [filteredMessages, currentActivities])

	const handleOpenFile = useCallback((filePath: string) => {
		FileServiceClient.openFileRelativePath(StringRequest.create({ value: filePath })).catch((err) =>
			console.error("Failed to open file:", err)
		)
	}, [])

	const handleToggleExpand = useCallback((id: string) => {
		setExpandedItems((prev) => ({ ...prev, [id]: !prev[id] }))
	}, [])

	if (displayUnits.length === 0 && !apiReqMessage) {
		return null
	}

	return (
		<div className={cn("px-4 py-2 ml-1 text-description")}>
			<div className="min-w-0">
				{apiReqMessage && (
					<div className="mb-1 -ml-1">
						<RequestStartRow
							cost={apiReqInfo?.cost}
							diracMessagesCount={allMessages.length}
							handleToggle={() => {}}
							isExpanded={false}
							message={apiReqMessage}
							responseStarted={true}
						/>
					</div>
				)}
				{displayUnits.map((unit) => {
					const Component = getComponentForTool(unit.type)
					const isExpanded = expandedItems[unit.id]
					return (
						<div key={unit.id} className="flex flex-col gap-1">
							<ToolRow
								unit={unit}
								isExpanded={isExpanded}
								onToggleExpand={handleToggleExpand}
								onPathClick={handleOpenFile}
							/>
							{Component && isExpanded && (
								<div className="ml-4 mt-1 border-l-2 border-editor-group-border pl-2">
									<Component
										unit={unit}
										tool={unit.tool}
										message={unit.message}
										isExpanded={true}
										onToggleExpand={() => handleToggleExpand(unit.id)}
									/>
								</div>
							)}
						</div>
					)
				})}
			</div>
		</div>
	)
})

ToolGroupRenderer.displayName = "ToolGroupRenderer"
