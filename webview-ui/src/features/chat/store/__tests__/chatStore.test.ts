import { IsaacMessage } from "@shared/ExtensionMessage"
import { act, renderHook } from "@testing-library/react"
import { useChatStore } from "../chatStore"

describe("useChatStore", () => {
	beforeEach(() => {
		useChatStore.setState({ diracMessages: [] })
	})

	it("should initialize with empty messages", () => {
		const { result } = renderHook(() => useChatStore())
		expect(result.current.diracMessages).toEqual([])
	})

	it("should set messages", () => {
		const { result } = renderHook(() => useChatStore())
		const messages: IsaacMessage[] = [{ ts: 1, type: "say", say: "text", text: "hello" }]

		act(() => {
			result.current.setIsaacMessages(messages)
		})

		expect(result.current.diracMessages).toEqual(messages)
	})

	it("should update partial message", () => {
		const { result } = renderHook(() => useChatStore())
		const initialMessages: IsaacMessage[] = [
			{ ts: 1, type: "say", say: "text", text: "hello" },
			{ ts: 2, type: "say", say: "text", text: "world" },
		]

		act(() => {
			result.current.setIsaacMessages(initialMessages)
		})

		const updatedMessage: IsaacMessage = { ts: 2, type: "say", say: "text", text: "updated world" }

		act(() => {
			result.current.updatePartialMessage(updatedMessage)
		})

		expect(result.current.diracMessages[1]).toEqual(updatedMessage)
		expect(result.current.diracMessages[0]).toEqual(initialMessages[0])
	})

	it("should not update if message ts not found", () => {
		const { result } = renderHook(() => useChatStore())
		const initialMessages: IsaacMessage[] = [{ ts: 1, type: "say", say: "text", text: "hello" }]

		act(() => {
			result.current.setIsaacMessages(initialMessages)
		})

		const unknownMessage: IsaacMessage = { ts: 99, type: "say", say: "text", text: "unknown" }

		act(() => {
			result.current.updatePartialMessage(unknownMessage)
		})

		expect(result.current.diracMessages).toEqual(initialMessages)
	})
})
