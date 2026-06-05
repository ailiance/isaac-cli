import type { IsaacMessage } from "@shared/ExtensionMessage"
import type React from "react"
import { useMemo, useRef } from "react"
import { Virtuoso } from "react-virtuoso"
import { useSettingsStore } from "@/features/settings/store/settingsStore"
import type { ChatState, MessageHandlers, ScrollBehavior } from "../../types/chatTypes"
import { getIsWaitingForResponse } from "../../utils/messageUtils"
import { createMessageRenderer } from "../messages/MessageRenderer"

interface MessagesAreaProps {
	task: IsaacMessage
	groupedMessages: (IsaacMessage | IsaacMessage[])[]
	modifiedMessages: IsaacMessage[]
	scrollBehavior: ScrollBehavior
	chatState: ChatState
	messageHandlers: MessageHandlers
}

/**
 * The scrollable messages area with virtualized list
 * Handles rendering of chat rows and browser sessions
 */
export const MessagesArea: React.FC<MessagesAreaProps> = ({
	task,
	groupedMessages,
	modifiedMessages,
	scrollBehavior,
	chatState,
	messageHandlers,
}) => {
	const parentRef = useRef<HTMLDivElement>(null)
	const { diracMessages } = useSettingsStore()
	const lastRawMessage = useMemo(() => diracMessages.at(-1), [diracMessages])

	const {
		virtuosoRef,
		scrollContainerRef,
		toggleRowExpansion,
		handleRowHeightChange,
		setIsAtBottom,
		setShowScrollToBottom,
		disableAutoScrollRef,
		handleRangeChanged,
		scrollToMessage,
	} = scrollBehavior

	const { expandedRows, inputValue, setActiveQuote } = chatState
	const lastVisibleRow = useMemo(() => groupedMessages.at(-1), [groupedMessages])
	const lastVisibleMessage = useMemo(() => {
		const lastRow = lastVisibleRow
		if (!lastRow) {
			return undefined
		}
		return Array.isArray(lastRow) ? lastRow.at(-1) : lastRow
	}, [lastVisibleRow])

	// Show "Thinking..." until real content starts streaming.
	// This is the sole early loading indicator - RequestStartRow does NOT duplicate it.
	// Covers: pre-api_req_started (backend processing) AND post-api_req_started (waiting for model).
	// Hides once reasoning, tools, text, or any other content message appears.
	const isWaitingForResponse = useMemo(
		() => getIsWaitingForResponse(modifiedMessages, lastRawMessage, groupedMessages, lastVisibleMessage, lastVisibleRow),
		[lastRawMessage, groupedMessages, lastVisibleMessage, lastVisibleRow, modifiedMessages],
	)

	// Keep loader in the message flow (not footer). During handoff from waiting -> reasoning stream,
	// keep the loader mounted until a real reasoning row is visible.
	const showThinkingLoaderRow = useMemo(() => {
		const handoffToReasoningPending =
			lastRawMessage?.type === "say" &&
			lastRawMessage.say === "reasoning" &&
			lastRawMessage.partial === true &&
			lastVisibleMessage?.say !== "reasoning"

		// Mirror the old footer behavior exactly: show whenever waiting logic says so.
		// Plus a brief handoff guard while grouped rows catch up to raw reasoning stream.
		// If we're already showing an active api_req_started row, don't show the synthetic loader.
		const alreadyShowingApiReq = lastVisibleMessage?.say === "api_req_started"
		return (isWaitingForResponse && !alreadyShowingApiReq) || handoffToReasoningPending
	}, [isWaitingForResponse, lastRawMessage, lastVisibleMessage?.say])

	const displayedGroupedMessages = useMemo<(IsaacMessage | IsaacMessage[])[]>(() => {
		let baseMessages = groupedMessages


		if (!showThinkingLoaderRow) {
			return baseMessages
		}

		const waitingRow: IsaacMessage = {
			ts: Number.MIN_SAFE_INTEGER,
			type: "say",
			say: "reasoning",
			partial: true,
			text: "",
		}
		return [...baseMessages, waitingRow]
	}, [groupedMessages, showThinkingLoaderRow])

	const itemContent = useMemo(
		() =>
			createMessageRenderer(
				displayedGroupedMessages,
				modifiedMessages,
				expandedRows,
				toggleRowExpansion,
				handleRowHeightChange,
				setActiveQuote,
				inputValue,
				messageHandlers,
				false,
			),
		[
			displayedGroupedMessages,
			modifiedMessages,
			expandedRows,
			toggleRowExpansion,
			handleRowHeightChange,
			setActiveQuote,
			inputValue,
			messageHandlers,
		],
	)

	// Keep footer as a simple spacer. Thinking loading is rendered as an in-list row.
	const virtuosoComponents = useMemo(
		() => ({
			Footer: () => <div className="min-h-1" />,
		}),
		[],
	)

	return (
		<div className="overflow-hidden flex flex-col h-full relative">
			<div className="grow flex" ref={scrollContainerRef}>
				<div
					className="scrollable grow overflow-y-scroll custom-scrollbar"
					ref={parentRef}
					style={{
						height: "100%",
						width: "100%",
						overflowAnchor: "none",
					}}>
					<Virtuoso
						atBottomStateChange={(isAtBottom) => {
							setIsAtBottom(isAtBottom)
							if (isAtBottom) {
								disableAutoScrollRef.current = false
							}
							setShowScrollToBottom(disableAutoScrollRef.current && !isAtBottom)
						}}
						atBottomThreshold={10}
						className="grow"
						components={virtuosoComponents}
						data={displayedGroupedMessages}
						increaseViewportBy={{
							top: 3_000,
							bottom: Number.MAX_SAFE_INTEGER,
						}}
						initialTopMostItemIndex={displayedGroupedMessages.length - 1}
						itemContent={itemContent}
						key={task.ts}
						rangeChanged={handleRangeChanged}
						ref={virtuosoRef}
						scrollerRef={(ref) => {
							if (ref instanceof HTMLElement) {
								// @ts-expect-error
								parentRef.current = ref
							}
						}}
						style={{
							scrollbarWidth: "none",
							msOverflowStyle: "none",
							overflowAnchor: "none",
						}}
					/>
				</div>
			</div>
		</div>
	)
}
