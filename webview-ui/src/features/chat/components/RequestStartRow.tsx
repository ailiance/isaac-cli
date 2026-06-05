import type { IsaacMessage, Mode } from "@shared/ExtensionMessage"
import type { LucideIcon } from "lucide-react"
import type React from "react"
import { useMemo } from "react"
import ErrorRow from "./ErrorRow"
import { ThinkingRow } from "./ThinkingRow"
import { IsaacApiReqInfo } from "@shared/ExtensionMessage"
import { TypewriterText } from "./TypewriterText"

interface RequestStartRowProps {
	message: IsaacMessage
	apiRequestFailedMessage?: string
	apiReqStreamingFailedMessage?: string
	cost?: number
	reasoningContent?: string
	responseStarted?: boolean
	diracMessagesCount: number
	mode?: Mode
	classNames?: string
	isExpanded: boolean
	handleToggle: () => void
	onAskForUpdate?: () => void
}

// State type for api_req_started rendering
type ApiReqState = "pre" | "thinking" | "error" | "final"

/**
 * Displays the current state of an active tool operation,
 */
export const RequestStartRow: React.FC<RequestStartRowProps> = ({
	apiRequestFailedMessage,
	apiReqStreamingFailedMessage,
	cost,
	reasoningContent,
	responseStarted,
	diracMessagesCount,
	mode,
	handleToggle,
	isExpanded,
	message,
	onAskForUpdate,
}) => {
	const apiReqInfo = useMemo(() => {
		if (!message.text) return undefined
		try {
			return JSON.parse(message.text) as IsaacApiReqInfo
		} catch {
			return undefined
		}
	}, [message.text])

	const echoedRequest = useMemo(() => {
		const request = apiReqInfo?.request
		if (!request) return undefined

		// Look for tool response pattern: [Tool] [...] Result:
		const toolResponseMatch = request.match(/\[Tool(?: \(Error\))?\]\s*\[([^\]\s]+)(?:\s+for\s+[^\]]+)?\]\s*Result:/)
		if (toolResponseMatch) {
			const toolName = toolResponseMatch[1]
				.split("_")
				.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
				.join(" ")
			return `Sent ${toolName} response`
		}

		// If it starts with [Tool Use: ...], it's a model tool call, don't echo
		if (request.startsWith("[Tool Use:")) {
			return undefined
		}

		// For other tool-related strings that don't match the response pattern, suppress them
		if (request.startsWith("[Tool")) {
			return undefined
		}

		// For other requests (like user messages), show a generic "API call"
		return "API call"
	}, [apiReqInfo?.request])


	// Derive explicit state
	const hasError = !!(apiRequestFailedMessage || apiReqStreamingFailedMessage)
	const hasCost = cost != null
	const hasReasoning = !!reasoningContent
	// We no longer have access to the full diracMessages array here for performance reasons.
	// If hasCompletionResult is needed, it should be passed as a prop.
	const hasCompletionResult = false

	const apiReqState: ApiReqState = hasError ? "error" : hasCost ? "final" : hasReasoning ? "thinking" : "pre"

	// Only show "Thinking..." if no actual response content has started yet.
	// Once reasoning or tools start, this row should collapse to just the cost/metadata.
	const shouldShowThinking = useMemo(
		() => !hasError && !hasCost && !responseStarted,
		[hasError, hasCost, responseStarted],
	)


	// Check if this api_req will be absorbed into a tool group (reasoning will disappear)
	const willBeAbsorbed = useMemo(() => {
		// We no longer have access to the full diracMessages array here for performance reasons.
		return false
	}, [message.ts])

	// Find all exploratory tool activities that are currently in flight.
	// Tools come AFTER the api_req_started message, so we look from currentApiReq forward.
	const currentActivities = useMemo(() => {
		// We no longer have access to the full diracMessages array here for performance reasons.
		return []
	}, [])

	const hasCompletedTools = useMemo(() => {
		// We no longer have access to the full diracMessages array here for performance reasons.
		return false
	}, [])

	// Only show currentActivities if there are NO completed tools
	// (otherwise they'll be shown in the unified ToolGroupRenderer list)
	const shouldShowActivities = currentActivities.length > 0 && !hasCompletedTools

	// Initial loading ("Thinking..." before any content) is injected as a synthetic in-list
	// reasoning row in MessagesArea to avoid footer handoff flicker.

	return (
		<div className="flex flex-col gap-1">
			{echoedRequest && (
				<div className="flex items-center gap-2 px-1 text-description opacity-80">
					<span className="text-[11px] font-medium tracking-tight truncate">
						{echoedRequest}
					</span>
				</div>
			)}
		<div>
			{apiReqState === "pre" && shouldShowActivities && (
				<div className="flex items-center text-description w-full text-sm">
					<div className="ml-1 flex-1 w-full h-full">
						<div className="flex flex-col gap-0.5 w-full min-h-1">
							{(currentActivities as { icon: LucideIcon; text: string }[]).map((activity, _) => (
								<div className="flex items-center gap-2 h-auto w-full overflow-hidden" key={activity.text}>
									<activity.icon className="size-2 text-foreground shrink-0" />
									<TypewriterText speed={15} text={activity.text} />
								</div>
							))}
						</div>
					</div>
				</div>
			)}
			{shouldShowThinking && (
				<ThinkingRow
					isExpanded={false}
					isStreaming={true}
					isVisible={true}
					onAskForUpdate={onAskForUpdate}
					showChevron={false}
					showTitle={true}
					title="Thinking..."
				/>
			)}


			{apiReqState === "error" && (
				<ErrorRow
					apiReqStreamingFailedMessage={apiReqStreamingFailedMessage}
					apiRequestFailedMessage={apiRequestFailedMessage}
					errorType="error"
					message={message}
				/>
			)}
		</div>
		</div>
	)
}
