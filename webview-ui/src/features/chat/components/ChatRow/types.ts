import { DiracMessage, Mode } from "@shared/ExtensionMessage"
import type { DiffStructure } from "@shared/utils/diff/DiffStructure"

export interface ChatRowProps {
	message: DiracMessage
	isExpanded: boolean
	onToggleExpand: (ts: number) => void
	lastModifiedMessage?: DiracMessage
	isLast: boolean
	onHeightChange: (isTaller: boolean) => void
	inputValue?: string
	sendMessageFromChatRow?: (text: string, images: string[], files: string[]) => void
	onSetQuote: (text: string) => void
	onCancelCommand?: () => void
	mode?: Mode
	reasoningContent?: string
	responseStarted?: boolean
	isRequestInProgress?: boolean
}

export interface QuoteButtonState {
	visible: boolean
	top: number
	left: number
	selectedText: string
}

export interface ChatRowContentProps extends Omit<ChatRowProps, "onHeightChange"> {}


export type DisplayUnitStatus = "pending" | "active" | "success" | "error"

export interface DisplayUnit {
	id: string // Unique ID for the row
	type: string // tool name or category
	label: string // Primary text (e.g., filename, command)
	subLabel?: string // Secondary metadata (e.g., line ranges, edit stats)
	status: DisplayUnitStatus
	icon: any // Lucide icon component
	isExpandable: boolean
	content?: string // Expanded detail (diff, file content, etc.)
	path?: string // For file-related actions
	isFilePath?: boolean // Whether the path points to a specific file (vs directory/cwd)
	symbol?: string // For symbol-related actions (replace_symbol, etc.)
	hasComponent?: boolean // Whether a specialized component is handling the expansion
	toolName?: string // The raw tool name for tooltip
	hunks?: DiffStructure // v0.6 Sprint 1-D: structured diff from host (per-file)
}
