/**
 * Enhanced type definitions for better type safety and developer experience
 */

import { ApiProviderInfo } from "@/core/api"
import type { BrowserSettings } from "@/shared/BrowserSettings"
import type { SkillMetadata } from "@/shared/skills"
import { IsaacDefaultTool } from "@/shared/tools"
import { ShellType } from "@/utils/shell-detection"
import { SystemPromptSection } from "./templates/placeholders"

/**
 * Enhanced system prompt context with better typing
 */
export interface SystemPromptContext {
	readonly providerInfo: ApiProviderInfo
	readonly cwd?: string
	readonly ide: string
	readonly editorTabs?: {
		readonly open?: readonly string[]
		readonly visible?: readonly string[]
	}
	readonly supportsBrowserUse?: boolean
	readonly skills?: SkillMetadata[]
	readonly globalIsaacRulesFileInstructions?: string
	readonly localIsaacRulesFileInstructions?: string
	readonly localCursorRulesFileInstructions?: string
	readonly localCursorRulesDirInstructions?: string
	readonly localWindsurfRulesFileInstructions?: string
	readonly localAgentsRulesFileInstructions?: string
	readonly localIsaacMdRulesFileInstructions?: string
	readonly isaacIgnoreInstructions?: string
	readonly preferredLanguageInstructions?: string
	readonly userInstructions?: string
	readonly isaacRules?: string
	readonly browserSettings?: BrowserSettings
	readonly isTesting?: boolean
	readonly runtimePlaceholders?: Readonly<Record<string, unknown>>
	readonly yoloModeToggled?: boolean
	readonly subagentsEnabled?: boolean
	/** Active MCP tool qualified names for adaptive retrieval. When set, only
	 * these MCP tools are emitted; undefined means "no gating" (legacy: all). */
	readonly activeMcpTools?: ReadonlySet<string>
	readonly isaacWebToolsEnabled?: boolean
	readonly isMultiRootEnabled?: boolean
	readonly workspaceRoots?: Array<{ path: string; name: string; vcs?: string }>
	readonly isSubagentsEnabledAndCliInstalled?: boolean
	readonly isCliSubagent?: boolean
	readonly isSubagentRun?: boolean
	readonly isCliEnvironment?: boolean
	readonly enableParallelToolCalling?: boolean
	readonly terminalExecutionMode?: "vscodeTerminal" | "backgroundExec"
	readonly activeShellType?: ShellType
	readonly activeShellPath?: string
	readonly activeShellIsPosix?: boolean
	readonly availableCores?: number
	readonly shouldCompact?: boolean
	/**
	 * The user's prompt text for the current turn, if available. Currently
	 * consumed by the memory auto-injector (loadRelevantMemories) to rank
	 * stored memories by relevance to what the user is asking. Optional —
	 * when absent, memories fall back to date-sorted order.
	 */
	readonly userPromptText?: string
}

/**
 * Utility functions for validating prompt components
 */
export function isValidSystemPromptSection(section: string): section is SystemPromptSection {
	return Object.values(SystemPromptSection).includes(section as SystemPromptSection)
}

export function isValidIsaacDefaultTool(tool: string): tool is IsaacDefaultTool {
	return Object.values(IsaacDefaultTool).includes(tool as IsaacDefaultTool)
}
