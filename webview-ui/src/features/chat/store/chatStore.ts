import type { IsaacMessage, ExtensionState } from "@shared/ExtensionMessage"
import { EmptyRequest } from "@shared/proto/isaac/common"
import { create } from "zustand"
import { StateServiceClient } from "@/shared/api/grpc-client"

interface ChatState {
	diracMessages: IsaacMessage[]

	// Actions
	setIsaacMessages: (messages: IsaacMessage[]) => void
	updatePartialMessage: (message: IsaacMessage) => void

	// Hydration
	hydrate: () => () => void
}

export const useChatStore = create<ChatState>((set) => ({
	diracMessages: [],

	setIsaacMessages: (messages) => set({ diracMessages: messages }),


	updatePartialMessage: (message) =>
		set((state) => {
			const lastIndex = state.diracMessages.findLastIndex((msg) => msg.ts === message.ts)
			if (lastIndex !== -1) {
				const newMessages = [...state.diracMessages]
				newMessages[lastIndex] = message
				return { diracMessages: newMessages }
			}
			return state
		}),

	hydrate: () => {
		const cleanup = StateServiceClient.subscribeToState({} as EmptyRequest, {
			onResponse: (state) => {
				if (!state.stateJson) return
				const parsedState = JSON.parse(state.stateJson) as ExtensionState

				if (parsedState.diracMessages) {
					const lastUserMessage = parsedState.diracMessages.filter((m) => m.type === "say" && m.say === "text").at(-1)

					set((state) => {

						return { diracMessages: parsedState.diracMessages }
					})
				}
			},
			onError: (error) => {
				console.error("Error in chatStore state subscription:", error)
			},
			onComplete: () => {},
		})
		return cleanup
	},
}))
