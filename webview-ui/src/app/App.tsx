import type { Boolean, EmptyRequest } from "@shared/proto/isaac/common"
import { useEffect } from "react"
import { useAppStore } from "@/app/store/appStore"
import ChatView from "@/features/chat/components/ChatView/ChatView"
import HistoryView from "@/features/history/components/HistoryView/HistoryView"
import SettingsView from "@/features/settings/components/SettingsView/SettingsView"
import { StackConfigView } from "@/features/stack-config/components/StackConfigView"
import WorktreesView from "@/features/worktrees/components/WorktreesView"
import { UiServiceClient } from "@/shared/api/grpc-client"
import { Providers } from "./Providers"

const AppContent = () => {
	const {
		didHydrateState,
		shouldShowAnnouncement,
		showSettings,
		settingsTargetSection,
		showHistory,
		showWorktrees,
		showStackConfig,
		showAnnouncement,
		setShowAnnouncement,
		setShouldShowAnnouncement,
		navigateToHistory,
		hideSettings,
		hideHistory,
		hideWorktrees,
		hideStackConfig,
		hideAnnouncement,
	} = useAppStore()
	const hydrate = useAppStore((state) => state.hydrate)

	useEffect(() => {
		const cleanup = hydrate()
		return cleanup
	}, [hydrate])

	useEffect(() => {
		if (shouldShowAnnouncement) {
			setShowAnnouncement(true)

			// Use the gRPC client instead of direct WebviewMessage
			UiServiceClient.onDidShowAnnouncement({} as EmptyRequest)
				.then((response: Boolean) => {
					setShouldShowAnnouncement(response.value)
				})
				.catch((error: any) => {
					console.error("Failed to acknowledge announcement:", error)
				})
		}
	}, [shouldShowAnnouncement, setShouldShowAnnouncement, setShowAnnouncement])

	if (!didHydrateState) {
		return null
	}

	const isOverlay = showSettings || showHistory || showWorktrees || showStackConfig

	return (
		<div className="flex h-screen w-full flex-col">
			{showSettings && <SettingsView onDone={hideSettings} targetSection={settingsTargetSection} />}
			{showHistory && <HistoryView onDone={hideHistory} />}
			{showWorktrees && <WorktreesView onDone={hideWorktrees} />}
			{showStackConfig && <StackConfigView onDone={hideStackConfig} />}
			{/* Do not conditionally load ChatView, it's expensive and there's state we don't want to lose (user input, disableInput, askResponse promise, etc.) */}
			<ChatView
				hideAnnouncement={hideAnnouncement}
				isHidden={isOverlay}
				showAnnouncement={showAnnouncement}
				showHistoryView={navigateToHistory}
			/>
		</div>
	)
}

const App = () => {
	return (
		<Providers>
			<AppContent />
		</Providers>
	)
}

export default App
