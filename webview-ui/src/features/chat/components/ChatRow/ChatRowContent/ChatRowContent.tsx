import { IsaacApiReqInfo, IsaacSayTool, COMMAND_OUTPUT_STRING } from "@shared/ExtensionMessage"
import { memo, useEffect, useMemo, useRef, useState } from "react"
import SubagentStatusRow from "@/features/chat/components/SubagentStatusRow"
import { useChatStore } from "@/features/chat/store/chatStore"
import { useSettingsStore } from "@/features/settings/store/settingsStore"
import { useRelinquishControl } from "@/shared/hooks/useRelinquishControl"
import { getIconAndTitle } from "../ChatRowIcons"
import { MessageRenderer } from "../MessageRenderer"
import { ChatRowContentProps } from "../types"
import { useQuoteLogic } from "../useQuoteLogic"
import { CommandMessage } from "./CommandMessage"
import { ConditionalRulesMessage } from "./ConditionalRulesMessage"
import { ToolMessage } from "./ToolMessage"

export const ChatRowContent = memo(
	({
		message,
		isExpanded,
		onToggleExpand,
		lastModifiedMessage,
		isLast,
		inputValue,
		sendMessageFromChatRow,
		onSetQuote,
		onCancelCommand,
		mode,
		isRequestInProgress,
		reasoningContent,
		responseStarted,
	}: ChatRowContentProps) => {
		const onAskForUpdate = async () => {
			await onCancelCommand?.()
			// Small delay to ensure task is re-initialized before sending message
			setTimeout(() => {
				sendMessageFromChatRow?.("I'm still waiting for an update, are you stuck?", [], [])
			}, 200)
		}

		const backgroundEditEnabled = useSettingsStore((state) => state.backgroundEditEnabled)
		const vscodeTerminalExecutionMode = useSettingsStore((state) => state.vscodeTerminalExecutionMode)
		const diracMessagesCount = useChatStore((state) => state.diracMessages.length)
		const onRelinquishControl = useRelinquishControl()

		const [seeNewChangesDisabled, setSeeNewChangesDisabled] = useState(false)
		const [explainChangesDisabled, setExplainChangesDisabled] = useState(false)

		const { quoteButtonState, handleQuoteClick, handleMouseUp } = useQuoteLogic(onSetQuote)

		const [isOutputFullyExpanded, setIsOutputFullyExpanded] = useState(false)
		const prevCommandExecutingRef = useRef<boolean>(false)

		const hasAutoExpandedRef = useRef(false)
		const hasAutoCollapsedRef = useRef(false)
		const prevIsLastRef = useRef(isLast)

		useEffect(() => {
			const isCompletionResult = message.ask === "completion_result" || message.say === "completion_result"
			if (isLast && isCompletionResult && !hasAutoExpandedRef.current) {
				hasAutoExpandedRef.current = true
				hasAutoCollapsedRef.current = false
			}
		}, [isLast, message.ask, message.say])

		useEffect(() => {
			const isCompletionResult = message.ask === "completion_result" || message.say === "completion_result"
			const wasLast = prevIsLastRef.current
			if (wasLast && !isLast && isCompletionResult && !hasAutoCollapsedRef.current) {
				hasAutoCollapsedRef.current = true
				hasAutoExpandedRef.current = false
			}
			prevIsLastRef.current = isLast
		}, [isLast, message.ask, message.say])

		const [cost, apiReqCancelReason, apiReqStreamingFailedMessage] = useMemo(() => {
			if (message.text != null && message.say === "api_req_started") {
				try {
					const info: IsaacApiReqInfo = JSON.parse(message.text)
					return [info.cost, info.cancelReason, info.streamingFailedMessage]
				} catch (e) {
					console.error("Error parsing api_req_started message:", e)
					return [undefined, undefined, undefined]
				}
			}
			return [undefined, undefined, undefined]
		}, [message.text, message.say])

		const apiRequestFailedMessage =
			isLast && lastModifiedMessage?.ask === "api_req_failed" ? lastModifiedMessage?.text : undefined

		const type = message.type === "ask" ? message.ask : message.say
		const isCommandMessage = type === "command"
		const commandHasOutput = message.text?.includes(COMMAND_OUTPUT_STRING) ?? false

		const isMultiCommand = !!message.multiCommandState

		const multiCommandRequiresApproval =
			isMultiCommand && message.multiCommandState!.commands.some((cmd) => cmd.requiresApproval)
		const multiCommandIsRunning =
			isMultiCommand && message.multiCommandState!.commands.some((cmd) => cmd.status === "running")

		const isCommandExecuting = (() => {
			if (!isCommandMessage) return false
			if (multiCommandIsRunning) return true
			if (message.commandCompleted) return false
			return commandHasOutput
		})()

		const isCommandPending = (() => {
			if (!isCommandMessage) return false
			if (multiCommandRequiresApproval) return true
			if (message.commandCompleted) return false
			if (isCommandExecuting) return false

			// If it's an 'ask' message, it's pending by definition until completed
			if (message.type === "ask") return true

			if (!isLast || commandHasOutput) return false
			return true
		})()

		const isCommandCompleted = isCommandMessage && message.commandCompleted === true

		useEffect(() => {
			return onRelinquishControl(() => {
				setSeeNewChangesDisabled(false)
				setExplainChangesDisabled(false)
			})
		}, [onRelinquishControl])

		const [icon, title] = useMemo(() => getIconAndTitle(type), [type])

		const tool = useMemo(() => {
			if (message.ask === "tool" || message.say === "tool") {
				try {
					return JSON.parse(message.text || "{}") as IsaacSayTool
				} catch (e) {
					console.error("Error parsing tool message:", e)
					return null
				}
			}
			return null
		}, [message.ask, message.say, message.text])

		const conditionalRulesInfo = useMemo(() => {
			if (message.say !== "conditional_rules_applied" || !message.text) return null
			try {
				const parsed = JSON.parse(message.text)
				return parsed as { rules: Array<{ name: string; matchedConditions: Record<string, string[]> }> }
			} catch (e) {
				console.error("Error parsing conditional_rules_applied message:", e)
				return null
			}
		}, [message.say, message.text])

		useEffect(() => {
			if (isCommandMessage && prevCommandExecutingRef.current && !isCommandExecuting) {
				setIsOutputFullyExpanded(false)
			}
			prevCommandExecutingRef.current = isCommandExecuting
		}, [isCommandMessage, isCommandExecuting])

		useEffect(() => {
			if (isCommandMessage && isCommandExecuting && !isExpanded) {
				const timer = setTimeout(() => {
					onToggleExpand(message.ts)
				}, 500)
				return () => clearTimeout(timer)
			}
		}, [isCommandMessage, isCommandExecuting, isExpanded, onToggleExpand, message.ts])

		if (conditionalRulesInfo) {
			return <ConditionalRulesMessage rules={conditionalRulesInfo.rules} />
		}

		if (tool) {
			return (
				<ToolMessage
					backgroundEditEnabled={backgroundEditEnabled}
					isExpanded={isExpanded}
					message={message}
					onToggleExpand={onToggleExpand}
					tool={tool}
				/>
			)
		}

		if (message.ask === "command" || message.say === "command") {
			return (
				<CommandMessage
					icon={icon}
					isCommandCompleted={isCommandCompleted}
					isCommandExecuting={isCommandExecuting}
					isCommandPending={isCommandPending}
					isOutputFullyExpanded={isOutputFullyExpanded}
					message={message}
					onCancelCommand={onCancelCommand}
					setIsOutputFullyExpanded={setIsOutputFullyExpanded}
					title={title}
					vscodeTerminalExecutionMode={vscodeTerminalExecutionMode}
				/>
			)
		}

		if (message.ask === "use_subagents" || message.say === "use_subagents") {
			return <SubagentStatusRow isLast={isLast} lastModifiedMessage={lastModifiedMessage} message={message} />
		}

		return (
			<MessageRenderer
				apiReqStreamingFailedMessage={apiReqStreamingFailedMessage}
				apiRequestFailedMessage={apiRequestFailedMessage}
				diracMessagesCount={diracMessagesCount}
				cost={cost}
				dashboardReasoningContent={reasoningContent}
				explainChangesDisabled={explainChangesDisabled}
				handleMouseUp={handleMouseUp}
				handleQuoteClick={handleQuoteClick}
				icon={icon}
				inputValue={inputValue}
				isExpanded={isExpanded}
				isLast={isLast}
				isRequestInProgress={isRequestInProgress}
				lastModifiedMessage={lastModifiedMessage}
				message={message}
				mode={mode}
				onSetQuote={onSetQuote}
				onToggleExpand={onToggleExpand}
				quoteButtonState={quoteButtonState}
				responseStarted={responseStarted}
				seeNewChangesDisabled={seeNewChangesDisabled}
				sendMessageFromChatRow={sendMessageFromChatRow}
				setExplainChangesDisabled={setExplainChangesDisabled}
				setSeeNewChangesDisabled={setSeeNewChangesDisabled}
				title={title}
				vscodeTerminalExecutionMode={vscodeTerminalExecutionMode}
				onAskForUpdate={onAskForUpdate}
			/>
		)
	},
)
