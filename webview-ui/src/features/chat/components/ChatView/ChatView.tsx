import { combineApiRequests } from "@shared/combineApiRequests"
import { combineCommandSequences } from "@shared/combineCommandSequences"
import { combineErrorRetryMessages } from "@shared/combineErrorRetryMessages"
import { combineHookSequences } from "@shared/combineHookSequences"
import { Mode } from "@shared/ExtensionMessage"
import { getApiMetrics, getLastApiReqInfo } from "@shared/getApiMetrics"
import { BooleanRequest } from "@shared/proto/isaac/common"
import { useCallback, useEffect, useMemo } from "react"
import { useMount } from "react-use"
import { useAppStore } from "@/app/store/appStore"
import { useShowNavbar } from "@/context/PlatformContext"
import { useTaskStore } from "@/entities/task/store/taskStore"
import { useUserStore } from "@/entities/user/store/userStore"
import { useChatStore } from "@/features/chat/store/chatStore"
import { normalizeApiConfiguration } from "@/features/settings/components/utils/providerUtils"
import { useSettingsStore } from "@/features/settings/store/settingsStore"
import { cn } from "@/lib/utils"
import { FileServiceClient } from "@/shared/api/grpc-client"
import { Navbar } from "@/shared/ui/Navbar"
import AutoApproveBar from "../auto-approve-menu/AutoApproveBar"
import { useClipboardHandler } from "./hooks/useClipboardHandler"
import { useVscodeSubscriptions } from "./hooks/useVscodeSubscriptions"
// Import utilities and hooks from the new structure
import {
    ActionButtons,
    CHAT_CONSTANTS,
    ChatLayout,
    filterVisibleMessages,
    groupLowStakesTools,
    groupMessages,
    InputSection,
    InteractionStateProvider,
    MessagesArea,
    TaskSection,
    useChatState,
    useMessageHandlers,
    useScrollBehavior,
    WelcomeSection,
} from "./index"

interface ChatViewProps {
	isHidden: boolean
	showAnnouncement: boolean
	hideAnnouncement: () => void
	showHistoryView: () => void
}

// Use constants from the imported module
const MAX_IMAGES_AND_FILES_PER_MESSAGE = CHAT_CONSTANTS.MAX_IMAGES_AND_FILES_PER_MESSAGE
const QUICK_WINS_HISTORY_THRESHOLD = 3

const ChatViewContent = ({ isHidden, showAnnouncement, hideAnnouncement, showHistoryView }: ChatViewProps) => {
	const showNavbar = useShowNavbar()
	const hydrate = useChatStore((state) => state.hydrate)
	const version = useAppStore((state: any) => state.version)
	const messages = useChatStore((state) => state.diracMessages)
	const taskHistory = useTaskStore((state) => state.taskHistory)
	const apiConfiguration = useSettingsStore((state: any) => state.apiConfiguration)
	const telemetrySetting = useSettingsStore((state) => state.telemetrySetting)
	const mode = useSettingsStore((state) => state.mode)
	const userInfo = useUserStore((state) => state.userInfo)
	const hooksEnabled = useSettingsStore((state) => state.hooksEnabled)
	const isProdHostedApp = (userInfo as any)?.appBaseUrl === "https://app.dirac.run"
	const shouldShowQuickWins = isProdHostedApp && (!taskHistory || taskHistory.length < QUICK_WINS_HISTORY_THRESHOLD)

	//const task = messages.length > 0 ? (messages[0].say === "task" ? messages[0] : undefined) : undefined) : undefined
	const task = useMemo(() => messages.at(0), [messages]) // leaving this less safe version here since if the first message is not a task, then the extension is in a bad state and needs to be debugged (see Isaac.abort)
	const modifiedMessages = useMemo(() => {
		const slicedMessages = messages.slice(1)
		// Only combine hook sequences if hooks are enabled
		const withHooks = hooksEnabled ? combineHookSequences(slicedMessages) : slicedMessages
		return combineErrorRetryMessages(combineApiRequests(combineCommandSequences(withHooks)))
	}, [messages, hooksEnabled])
	// has to be after api_req_finished are all reduced into api_req_started messages
	const apiMetrics = useMemo(() => getApiMetrics(modifiedMessages), [modifiedMessages])
	const lastApiReqInfo = useMemo(() => getLastApiReqInfo(modifiedMessages), [modifiedMessages])

	const lastApiReqTotalTokens = lastApiReqInfo ? (lastApiReqInfo.tokensIn || 0) + (lastApiReqInfo.tokensOut || 0) + (lastApiReqInfo.cacheWrites || 0) + (lastApiReqInfo.cacheReads || 0) : undefined

	// Use custom hooks for state management
	const chatState = useChatState(messages)
	const {
		setInputValue,
		selectedImages,
		setSelectedImages,
		selectedFiles,
		setSelectedFiles,
		sendingDisabled,
		enableButtons,
		expandedRows,
		setExpandedRows,
		textAreaRef,
	} = chatState

	useClipboardHandler()
	// Button state is now managed by useButtonState hook

	// handleFocusChange is already provided by chatState

	// Use message handlers hook
	const messageHandlers = useMessageHandlers(messages, chatState)

	const { selectedModelInfo } = useMemo(() => {
		return normalizeApiConfiguration(apiConfiguration, mode as Mode)
	}, [apiConfiguration, mode])
	const selectFilesAndImages = useCallback(async () => {
		try {
			const response = await FileServiceClient.selectFiles(
				BooleanRequest.create({
					value: selectedModelInfo.supportsImages,
				}),
			)
			if (
				response &&
				response.values1 &&
				response.values2 &&
				(response.values1.length > 0 || response.values2.length > 0)
			) {
				const currentTotal = selectedImages.length + selectedFiles.length
				const availableSlots = MAX_IMAGES_AND_FILES_PER_MESSAGE - currentTotal

				if (availableSlots > 0) {
					// Prioritize images first
					const imagesToAdd = Math.min(response.values1.length, availableSlots)
					if (imagesToAdd > 0) {
						setSelectedImages((prevImages) => [...prevImages, ...response.values1.slice(0, imagesToAdd)])
					}

					// Use remaining slots for files
					const remainingSlots = availableSlots - imagesToAdd
					if (remainingSlots > 0) {
						setSelectedFiles((prevFiles) => [...prevFiles, ...response.values2.slice(0, remainingSlots)])
					}
				}
			}
		} catch (error) {
			console.error("Error selecting images & files:", error)
		}
	}, [selectedModelInfo.supportsImages])

	const shouldDisableFilesAndImages = selectedImages.length + selectedFiles.length >= MAX_IMAGES_AND_FILES_PER_MESSAGE

	useVscodeSubscriptions({ isHidden, textAreaRef, setInputValue })

	useEffect(() => {
		const cleanup = hydrate()
		return cleanup
	}, [hydrate])

	useMount(() => {
		// NOTE: the vscode window needs to be focused for this to work
		textAreaRef.current?.focus()
	})

	useEffect(() => {
		const timer = setTimeout(() => {
			if (!isHidden && !sendingDisabled && !enableButtons && document.hasFocus()) {
				textAreaRef.current?.focus()
			}
		}, 50)
		return () => {
			clearTimeout(timer)
		}
	}, [isHidden, sendingDisabled, enableButtons])

	const visibleMessages = useMemo(() => {
		return filterVisibleMessages(modifiedMessages)
	}, [modifiedMessages])



	const groupedMessages = useMemo(() => {
		return groupLowStakesTools(groupMessages(visibleMessages))
	}, [visibleMessages])

	// Use scroll behavior hook
	const scrollBehavior = useScrollBehavior(messages, visibleMessages, groupedMessages, expandedRows, setExpandedRows)

	const placeholderText = useMemo(() => {
		const text = task ? "Type a message..." : "Type your task here..."
		return text
	}, [task])

	return (
		<ChatLayout isHidden={isHidden}>
			<div className="flex flex-col flex-1 overflow-hidden relative">
				<div className={cn("flex flex-col flex-1 overflow-hidden", mode === "plan" ? "bg-grid-plan" : "")}>
					{showNavbar && <Navbar />}
					{task ? (
						<TaskSection
							lastApiReqInfo={lastApiReqInfo}
							apiMetrics={apiMetrics}
							messageHandlers={messageHandlers}
							task={task}
						/>
					) : (
						<WelcomeSection
							hideAnnouncement={hideAnnouncement}
							shouldShowQuickWins={shouldShowQuickWins}
							showAnnouncement={showAnnouncement}
							showHistoryView={showHistoryView}
							taskHistory={taskHistory}
							telemetrySetting={telemetrySetting}
							version={version}
						/>
					)}
					{task && (
						<MessagesArea
							chatState={chatState}
							groupedMessages={groupedMessages}
							messageHandlers={messageHandlers}
							modifiedMessages={modifiedMessages}
							scrollBehavior={scrollBehavior}
							task={task}
						/>
					)}
				</div>
			</div>
			<footer className="bg-(--vscode-sidebar-background) z-20" style={{ gridRow: "2" }}>
				<AutoApproveBar />
				<ActionButtons
					chatState={chatState}
					messageHandlers={messageHandlers}
					messages={messages}
					mode={mode as any}
					scrollBehavior={{
						scrollToBottomSmooth: scrollBehavior.scrollToBottomSmooth,
						disableAutoScrollRef: scrollBehavior.disableAutoScrollRef,
						showScrollToBottom: scrollBehavior.showScrollToBottom,
						virtuosoRef: scrollBehavior.virtuosoRef,
					}}
					task={task}
				/>
				<InputSection
					chatState={chatState}
					messageHandlers={messageHandlers}
					placeholderText={placeholderText}
					scrollBehavior={scrollBehavior}
					selectFilesAndImages={selectFilesAndImages}
					shouldDisableFilesAndImages={shouldDisableFilesAndImages}
				/>
			</footer>
		</ChatLayout>
	)
}

const ChatView = (props: ChatViewProps) => (
	<InteractionStateProvider>
		<ChatViewContent {...props} />
	</InteractionStateProvider>
)

export default ChatView
