/**
 * Utility functions for message filtering, grouping, and manipulation
 */

import { combineApiRequests } from "@shared/combineApiRequests"
import { combineCommandSequences } from "@shared/combineCommandSequences"
import type { IsaacMessage, IsaacSayBrowserAction, IsaacSayTool } from "@shared/ExtensionMessage"

/**
 * Low-stakes tool types that should be grouped together
 */
const LOW_STAKES_TOOLS = new Set([
	"readFile",
	"readLineRange",
	"listFilesTopLevel",
	"listFilesRecursive",
	"listCodeDefinitionNames",
	"searchFiles",
	"getFileSkeleton",
	"getFunction"
])

/**
 * Check if a tool message is a low-stakes tool
 */
export function isLowStakesTool(message: IsaacMessage): boolean {
	if (message.say !== "tool" && message.ask !== "tool") {
		return false
	}
	try {
		const tool = JSON.parse(message.text || "{}") as IsaacSayTool
		return LOW_STAKES_TOOLS.has(tool.tool)
	} catch {
		return false
	}
}

/**
 * Check if a message group is a tool group (array with _isToolGroup marker)
 */
export function isToolGroup(item: IsaacMessage | IsaacMessage[]): item is IsaacMessage[] & { _isToolGroup: true } {
	return Array.isArray(item) && (item as any)._isToolGroup === true
}

/**
 * Combine API requests and command sequences in messages
 */
export function processMessages(messages: IsaacMessage[]): IsaacMessage[] {
	return combineApiRequests(combineCommandSequences(messages))
}

/**
 * Filter messages that should be visible in the chat
 */
export function filterVisibleMessages(messages: IsaacMessage[]): IsaacMessage[] {
	return messages.filter((message, index, arr) => {
		switch (message.ask) {
			case "completion_result":
				if (message.text === "") {
					return false
				}
				break
			case "api_req_failed":
			case "resume_task":
			case "resume_completed_task":
				return false
			case "use_subagents":
				if (arr.slice(index + 1).some((candidate) => candidate.type === "say" && candidate.say === "subagent")) {
					return false
				}
				break
		}
		switch (message.say) {
			case "api_req_finished":
			case "api_req_retried":
			case "deleted_api_reqs":
			case "subagent_usage":
				return false
			case "api_req_started":
				return true
			case "text":
				if ((message.text ?? "") === "" && (message.images?.length ?? 0) === 0) {
					return false
				}
				break
			case "use_subagents":
				if (arr.slice(index + 1).some((candidate) => candidate.type === "say" && candidate.say === "subagent")) {
					return false
				}
				break
		}
		return true
	})
}

/**
 * Check if a message is part of a browser session
 */
export function isBrowserSessionMessage(message: IsaacMessage): boolean {
	if (message.type === "ask") {
		return ["browser_action_launch"].includes(message.ask!)
	}
	if (message.type === "say") {
		return [
			"browser_action_launch",
			"api_req_started",
			"text",
			"browser_action",
			"browser_action_result",
			"checkpoint_created",
			"reasoning",
			"error_retry",
			"official",
		].includes(message.say!)
	}
	return false
}

/**
 * Group messages, combining browser session messages into arrays
 */
export function groupMessages(visibleMessages: IsaacMessage[]): (IsaacMessage | IsaacMessage[])[] {
	const result: (IsaacMessage | IsaacMessage[])[] = []
	let currentGroup: IsaacMessage[] = []
	let isInBrowserSession = false

	const endBrowserSession = () => {
		if (currentGroup.length > 0) {
			result.push([...currentGroup])
			currentGroup = []
			isInBrowserSession = false
		}
	}

	for (const message of visibleMessages) {
		if (message.ask === "browser_action_launch" || message.say === "browser_action_launch") {
			endBrowserSession()
			isInBrowserSession = true
			currentGroup.push(message)
		} else if (isInBrowserSession) {
			if (message.say === "api_req_started") {
				const lastApiReqStarted = [...currentGroup].reverse().find((m) => m.say === "api_req_started")
				if (lastApiReqStarted?.text != null) {
					const info = JSON.parse(lastApiReqStarted.text)
					const isCancelled = info.cancelReason != null
					if (isCancelled) {
						endBrowserSession()
						result.push(message)
						continue
					}
				}
			}

			if (isBrowserSessionMessage(message)) {
				currentGroup.push(message)
				if (message.say === "browser_action") {
					const browserAction = JSON.parse(message.text || "{}") as IsaacSayBrowserAction
					if (browserAction.action === "close") {
						endBrowserSession()
					}
				}
			} else {
				endBrowserSession()
				result.push(message)
			}
		} else {
			result.push(message)
		}
	}

	if (currentGroup.length > 0) {
		result.push([...currentGroup])
	}

	return result
}

/**
 * Get the task message from the messages array
 */
export function getTaskMessage(messages: IsaacMessage[]): IsaacMessage | undefined {
	return messages.at(0)
}

/**
 * Check if we should show the scroll to bottom button
 */
export function shouldShowScrollButton(disableAutoScroll: boolean, isAtBottom: boolean): boolean {
	return disableAutoScroll && !isAtBottom
}

/**
 * Find reasoning content associated with an api_req_started message.
 */
export function findReasoningForApiReq(
	apiReqTs: number,
	allMessages: IsaacMessage[],
): { reasoning: string | undefined; responseStarted: boolean } {
	const apiReqIndex = allMessages.findIndex((m) => m.ts === apiReqTs && m.say === "api_req_started")
	if (apiReqIndex === -1) {
		return { reasoning: undefined, responseStarted: false }
	}

	const reasoningParts: string[] = []
	let responseStarted = false

	for (let i = apiReqIndex + 1; i < allMessages.length; i++) {
		const msg = allMessages[i]
		if (msg.say === "api_req_started") {
			break
		}
		if (msg.say === "reasoning" && msg.text) {
			reasoningParts.push(msg.text)
		}
		if (msg.say === "text" || msg.say === "tool" || msg.ask === "tool" || msg.ask === "command" || msg.say === "command") {
			responseStarted = true
		}
	}

	return {
		reasoning: reasoningParts.length > 0 ? reasoningParts.join("\n\n") : undefined,
		responseStarted,
	}
}

/**
 * Find the API request info for a checkpoint message.
 */
export function findApiReqInfoForCheckpoint(
	checkpointTs: number,
	allMessages: IsaacMessage[],
): { cost: number | undefined; request: string | undefined } {
	const checkpointIndex = allMessages.findIndex((m) => m.ts === checkpointTs && m.say === "checkpoint_created")
	if (checkpointIndex === -1) {
		return { cost: undefined, request: undefined }
	}

	for (let i = checkpointIndex - 1; i >= 0; i--) {
		const msg = allMessages[i]
		if (msg.say === "api_req_started" && msg.text) {
			try {
				const info = JSON.parse(msg.text)
				return {
					cost: info.cost,
					request: info.request,
				}
			} catch {
				return { cost: undefined, request: undefined }
			}
		}
	}
	return { cost: undefined, request: undefined }
}

/**
 * Check if a checkpoint at the given index would be displayed (not absorbed into a tool group).
 */
function isDisplayedCheckpoint(checkpointIndex: number, allMessages: IsaacMessage[]): boolean {
	for (let i = checkpointIndex - 1; i >= 0; i--) {
		const msg = allMessages[i]
		if (msg.say === "api_req_started" || msg.say === "api_req_finished") {
			continue
		}
		if (msg.say === "reasoning") {
			continue
		}
		if (msg.say === "checkpoint_created") {
			continue
		}
		if (msg.say === "tool" || msg.ask === "tool") {
			try {
				const tool = JSON.parse(msg.text || "{}") as IsaacSayTool
				if (LOW_STAKES_TOOLS.has(tool.tool)) {
					return false
				}
			} catch {}
		}
		return true
	}
	return true
}

/**
 * Find the total cost for the segment starting at a checkpoint.
 */
export function findNextSegmentCost(checkpointTs: number, allMessages: IsaacMessage[]): number | undefined {
	const checkpointIndex = allMessages.findIndex((m) => m.ts === checkpointTs && m.say === "checkpoint_created")
	if (checkpointIndex === -1) {
		return undefined
	}
	let nextDisplayedCheckpointIndex = -1
	for (let i = checkpointIndex + 1; i < allMessages.length; i++) {
		if (allMessages[i].say === "checkpoint_created") {
			if (isDisplayedCheckpoint(i, allMessages)) {
				nextDisplayedCheckpointIndex = i
				break
			}
		}
	}

	const endIndex = nextDisplayedCheckpointIndex === -1 ? allMessages.length : nextDisplayedCheckpointIndex
	let totalCost = 0
	for (let i = checkpointIndex + 1; i < endIndex; i++) {
		const msg = allMessages[i]
		if (msg.say === "api_req_started" && msg.text) {
			try {
				const info = JSON.parse(msg.text)
				if (typeof info.cost === "number") {
					totalCost += info.cost
				}
			} catch {}
		}
	}

	return totalCost > 0 ? totalCost : undefined
}

/**
 * Check if a text message's associated API request is still in progress.
 */
export function isTextMessagePendingToolCall(textTs: number, allMessages: IsaacMessage[]): boolean {
	const textIndex = allMessages.findIndex((m) => m.ts === textTs)
	if (textIndex === -1) {
		return false
	}

	for (let i = textIndex - 1; i >= 0; i--) {
		const msg = allMessages[i]
		if (msg.say === "api_req_started" && msg.text) {
			try {
				const info = JSON.parse(msg.text)
				return info.cost == null
			} catch {
				return false
			}
		}
	}
	return false
}

/**
 * Check if a tool group should be hidden because its tools are currently being displayed in the loading state animation.
 */
export function isToolGroupInFlight(toolGroupMessages: IsaacMessage[], allMessages: IsaacMessage[]): boolean {
	if (toolGroupMessages.length === 0) {
		return false
	}

	let mostRecentApiReqIndex = -1
	for (let i = allMessages.length - 1; i >= 0; i--) {
		if (allMessages[i].say === "api_req_started") {
			mostRecentApiReqIndex = i
			break
		}
	}

	if (mostRecentApiReqIndex === -1 || !allMessages[mostRecentApiReqIndex].text) {
		return false
	}

	let mostRecentHasCost = false
	try {
		const info = JSON.parse(allMessages[mostRecentApiReqIndex].text!)
		mostRecentHasCost = info.cost != null
	} catch {
		return false
	}

	const lastTool = [...toolGroupMessages].reverse().find((m) => isLowStakesTool(m))
	if (!lastTool) {
		return false
	}

	const toolIndex = allMessages.findIndex((m) => m.ts === lastTool.ts)
	if (toolIndex === -1) {
		return false
	}

	if (!mostRecentHasCost) {
		let prevCompletedApiReqIndex = -1
		for (let i = mostRecentApiReqIndex - 1; i >= 0; i--) {
			const msg = allMessages[i]
			if (msg.say === "api_req_started" && msg.text) {
				try {
					const prevInfo = JSON.parse(msg.text)
					if (prevInfo.cost != null) {
						prevCompletedApiReqIndex = i
						break
					}
				} catch {}
			}
		}

		if (prevCompletedApiReqIndex === -1) {
			return false
		}
		return toolIndex > prevCompletedApiReqIndex && toolIndex < mostRecentApiReqIndex
	}
	return toolIndex > mostRecentApiReqIndex
}

/**
 * Filter a tool group to exclude tools that are in the "current activities" range.
 */
export function getToolsNotInCurrentActivities(toolGroupMessages: IsaacMessage[], allMessages: IsaacMessage[]): IsaacMessage[] {
	const tsToIndex = new Map<number, number>()
	for (let i = 0; i < allMessages.length; i++) {
		tsToIndex.set(allMessages[i].ts, i)
	}

	let mostRecentApiReqIndex = -1
	for (let i = allMessages.length - 1; i >= 0; i--) {
		if (allMessages[i].say === "api_req_started") {
			mostRecentApiReqIndex = i
			break
		}
	}

	if (mostRecentApiReqIndex === -1 || !allMessages[mostRecentApiReqIndex].text) {
		return toolGroupMessages
	}

	let mostRecentHasCost = false
	try {
		const info = JSON.parse(allMessages[mostRecentApiReqIndex].text!)
		mostRecentHasCost = info.cost != null
	} catch {
		return toolGroupMessages
	}

	if (!mostRecentHasCost) {
		return toolGroupMessages.filter((msg) => {
			const toolIndex = tsToIndex.get(msg.ts)
			if (toolIndex === undefined) {
				return true
			}
			// If we have an in-progress request, tools after it are "current activities"
			const isInCurrentActivitiesRange = toolIndex > mostRecentApiReqIndex
			return !isInCurrentActivitiesRange
		})
	}

	return toolGroupMessages.filter((msg) => {
		if (!isLowStakesTool(msg)) {
			return true
		}
		if (msg.ask === "tool") {
			const toolIndex = tsToIndex.get(msg.ts)
			if (toolIndex === undefined) {
				return true
			}
			// If the request is finished, all tools associated with it are now "completed"
			// and should be shown in the unified list.
			return true
		}
		return true
	})
}

/**
 * Returns true if this api_req_started should be fully absorbed into a low-stakes tool group.
 */
export function isApiReqAbsorbable(apiReqTs: number, allMessages: IsaacMessage[]): boolean {
	const apiReqIndex = allMessages.findIndex((m) => m.ts === apiReqTs && m.say === "api_req_started")
	if (apiReqIndex === -1) {
		return false
	}

	let hasLowStakesTool = false
	let hasReasoning = false
	for (let i = apiReqIndex + 1; i < allMessages.length; i++) {
		const msg = allMessages[i]
		if (msg.say === "api_req_started") {
			break
		}
		if (msg.say === "reasoning") {
			hasReasoning = true
			continue
		}
		if (msg.say === "checkpoint_created" || msg.say === "text") {
			continue
		}
		if (isLowStakesTool(msg)) {
			hasLowStakesTool = true
			continue
		}
		if (msg.say === "tool" || msg.ask === "tool" || msg.say === "command" || msg.ask === "command") {
			return false
		}
	}
	return hasLowStakesTool && !hasReasoning
}

/**
 * Check if an api_req_started at a given index produces low-stakes tools.
 */
function isApiReqFollowedOnlyByLowStakesTools(index: number, messages: (IsaacMessage | IsaacMessage[])[]): boolean {
	let hasLowStakesTool = false
	let hasReasoning = false
	for (let i = index + 1; i < messages.length; i++) {
		const item = messages[i]
		if (Array.isArray(item)) {
			break
		}
		const msg = item
		if (msg.say === "api_req_started") {
			break
		}
		if (msg.say === "reasoning") {
			hasReasoning = true
			continue
		}
		if (isLowStakesTool(msg)) {
			hasLowStakesTool = true
			continue
		}
		if (msg.say === "checkpoint_created" || msg.say === "text") {
			continue
		}
		if (msg.say === "tool" || msg.ask === "tool" || msg.say === "command" || msg.ask === "command") {
			return false
		}
	}
	return hasLowStakesTool && !hasReasoning
}

/**
 * Group consecutive low-stakes tools into arrays.
 */
export function groupLowStakesTools(groupedMessages: (IsaacMessage | IsaacMessage[])[]): (IsaacMessage | IsaacMessage[])[] {
	const result: (IsaacMessage | IsaacMessage[])[] = []
	let toolGroup: IsaacMessage[] = []
	let pendingReasoning: IsaacMessage[] = []
	let pendingApiReq: IsaacMessage[] = []
	let hasTools = false
	let hasApiReq = false
	const pendingTools: IsaacMessage[] = []

	const flushPending = () => {
		pendingApiReq.forEach((m) => result.push(m))
		pendingReasoning.forEach((m) => result.push(m))
		pendingApiReq = []
		pendingReasoning = []
		hasApiReq = false
	}

	const commitToolGroup = () => {
		if (toolGroup.length > 0 && (hasTools || hasApiReq)) {
			const group = toolGroup as IsaacMessage[] & { _isToolGroup: boolean }
			group._isToolGroup = true
			result.push(group)
			pendingReasoning = []
			pendingApiReq = []
			hasApiReq = false
		}
		toolGroup = []
		hasTools = false
	}

	const absorbPending = () => {
		if (pendingApiReq.length > 0) {
			toolGroup.push(...pendingApiReq)
			pendingApiReq = []
			hasApiReq = true
		}
	}

	for (let i = 0; i < groupedMessages.length; i++) {
		const item = groupedMessages[i]
		if (Array.isArray(item)) {
			commitToolGroup()
			flushPending()
			result.push(item)
			continue
		}
		const message = item
		const messageType = message.say
		const isLast = i === groupedMessages.length - 1

		if (isLowStakesTool(message)) {
			if (!hasTools && pendingReasoning.length > 0) {
				flushPending()
			}
			absorbPending()
			hasTools = true
			toolGroup.push(message)
			if (message.type === "ask" && !message.partial && isLast) {
				pendingTools.push(message)
			}
			continue
		}

		if (messageType === "reasoning") {
			commitToolGroup()
			flushPending()
			result.push(message)
			continue
		}

		if (messageType === "api_req_started") {
			if (isApiReqFollowedOnlyByLowStakesTools(i, groupedMessages)) {
				absorbPending()
				pendingApiReq.push(message)
				hasApiReq = true
			} else {
				commitToolGroup()
				flushPending()
				result.push(message)
			}
			continue
		}

		if (messageType === "checkpoint_created" && (hasTools || hasApiReq)) {
			toolGroup.push(message)
			continue
		}

		if (messageType === "text") {
			commitToolGroup()
			flushPending()
			result.push(message)
			continue
		}

		commitToolGroup()
		flushPending()
		result.push(message)
	}

	commitToolGroup()
	flushPending()
	if (pendingTools.length > 0) {
		result.push(...pendingTools)
	}
	return result
}


/**
 * Check if the chat is currently waiting for a response from the model.
 */
export function getIsWaitingForResponse(
	modifiedMessages: IsaacMessage[],
	lastRawMessage: IsaacMessage | undefined,
	groupedMessages: (IsaacMessage | IsaacMessage[])[],
	lastVisibleMessage: IsaacMessage | undefined,
	lastVisibleRow: IsaacMessage | IsaacMessage[] | undefined,
): boolean {
	const lastMsg = modifiedMessages[modifiedMessages.length - 1]

	// Never show thinking while waiting on user input (any ask state).
	if (lastRawMessage?.type === "ask") {
		return false
	}

	// attempt_completion emits a final say("completion_result") before ask("completion_result").
	if (lastRawMessage?.type === "say" && lastRawMessage.say === "completion_result") {
		return false
	}

	if (lastRawMessage?.type === "say" && lastRawMessage.say === "api_req_started") {
		try {
			const info = JSON.parse(lastRawMessage.text || "{}")
			if (info.cancelReason === "user_cancelled") {
				return false
			}
			// If it's an active api_req_started, we are definitely waiting.
			return true
		} catch {
			// ignore parse errors
			return true
		}
	}

	// Always show while task has started but no visible rows are rendered yet.
	if (groupedMessages.length === 0) {
		return true
	}

	// Defensive guard for transient states where a grouped row exists
	if (!lastVisibleMessage) {
		return true
	}

	// Always show when the last rendered row is a toolgroup.
	if (lastVisibleRow && isToolGroup(lastVisibleRow)) {
		return true
	}

	// if the last visible row is not actively partial, always show Thinking in the footer.
	if (lastVisibleMessage.partial !== true) {
		return true
	}

	if (!lastMsg) {
		return true
	}

	if (lastMsg.say === "user_feedback" || lastMsg.say === "user_feedback_diff") return true

	if (lastMsg.say === "api_req_started") {
		try {
			const info = JSON.parse(lastMsg.text || "{}")
			return info.cost == null
		} catch {
			return true
		}
	}

	return false
}
