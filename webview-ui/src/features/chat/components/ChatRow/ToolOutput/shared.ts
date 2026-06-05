import { IsaacSayTool } from "@shared/ExtensionMessage"
import { DisplayUnit } from "../types"

export interface BaseToolOutputProps {
	unit: DisplayUnit
	tool: IsaacSayTool
	isExpanded: boolean
	onToggleExpand: (ts: number) => void
}

export const HEADER_CLASSNAMES = "flex items-center gap-2 px-3 py-1.5 text-xs font-medium text-description bg-description/5 border-b border-editor-group-border"
