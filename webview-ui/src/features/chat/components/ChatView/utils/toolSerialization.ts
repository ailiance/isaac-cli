import { DiracSayTool, DiracMessage, COMMAND_OUTPUT_STRING } from "@shared/ExtensionMessage"
import { DisplayUnit, DisplayUnitStatus } from "../../ChatRow/types"
import { getIconForTool } from "../../../utils/toolIcons"


import { cleanPathPrefix } from "@/shared/ui/CodeAccordian"

export function serializeToolToDisplayUnits(
	tool: DiracSayTool,
	message: DiracMessage,
	statusOverride?: DisplayUnitStatus
): DisplayUnit[] {
	const relPaths = tool.paths || (tool.path ? [tool.path] : [])
	const isCommandExecuting =
		(message.ask === "command" || message.say === "command") &&
		(!!message.multiCommandState?.commands.some((c) => c.status === "running") ||
			(message.text?.includes(COMMAND_OUTPUT_STRING) && !message.commandCompleted))
	const isPending =
		(message.ask === "tool" || message.ask === "command" || message.ask === "browser_action_launch" || message.ask === "use_subagents") &&
		!isCommandExecuting &&
		!message.partial
	const status: DisplayUnitStatus = statusOverride || (isPending ? "pending" : message.partial ? "active" : "success")

	const units: DisplayUnit[] = []
	const icon = getIconForTool(tool.tool)

	const toolType = tool.tool || (tool as any).tool
	switch (toolType) {
		case "readFile":
		case "read_file":
		case "readLineRange":
		case "read_line_range": {
			relPaths.forEach((path: string, idx: number) => {
				let subLabel: string | undefined
				if (tool.tool === "readLineRange" || tool.tool === "read_line_range") {
					subLabel = `lines ${tool.startLine}-${tool.endLine}`
				} else if (tool.tool === "readFile" || tool.tool === "read_file") {
					const startLine = (tool as any).start_line
					const endLine = (tool as any).end_line
					if (startLine !== undefined && endLine !== undefined) {
						subLabel = `(${startLine} to ${endLine})`
					} else if (startLine !== undefined) {
						subLabel = `(${startLine} to end)`
					} else if (endLine !== undefined) {
						subLabel = `(1 to ${endLine})`
					}
				}
				units.push({
					toolName: tool.tool,
					id: `${message.ts}-${tool.tool}-${idx}`,
					type: tool.tool,
					label: "Read",
					subLabel: `${cleanPathPrefix(path)}${subLabel ? ` (${subLabel})` : ""}`,
					status,
					icon,
					isExpandable: true,
					content: tool.content,
					path,
					isFilePath: true,
				})
			})
			break
		}

		case "listFilesTopLevel":
		case "list_files_top_level":
		case "listFilesRecursive":
		case "list_files_recursive": {
			relPaths.forEach((path: string, idx: number) => {
				const label = cleanPathPrefix(path) + "/"

				units.push({
					toolName: tool.tool,
					id: `${message.ts}-${tool.tool}-${idx}`,
					type: tool.tool,
					label: "List",
					subLabel: label,
					status,
					icon,
					isExpandable: true,
					content: tool.content,
					path,
				})
			})
			break
		}

		case "searchFiles":
		case "search_files": {
			relPaths.forEach((path: string, idx: number) => {
				const terms = tool.regex || tool.query || ""
				const label = tool.filePattern && tool.filePattern !== "*" ? `"${terms}" in ${cleanPathPrefix(path)}/ (${tool.filePattern})` : `"${terms}" in ${cleanPathPrefix(path)}/`
				units.push({
					toolName: tool.tool,
					id: `${message.ts}-${tool.tool}-${idx}`,
					type: tool.tool,
					label: "Search",
					subLabel: label,
					status,
					icon,
					isExpandable: true,
					content: tool.content,
					path,
				})
			})
			break
		}

		case "listCodeDefinitionNames":
			relPaths.forEach((path: string, idx: number) => {
				const label = cleanPathPrefix(path) + "/"
				units.push({
					toolName: tool.tool,
					id: `${message.ts}-${tool.tool}-${idx}`,
					type: tool.tool,
					label: "Definitions",
					subLabel: label,
					status,
					icon,
					isExpandable: true,
					content: tool.content,
					path,
				})
			})
			break
		case "editFile":
		case "edit_file": {
			const editSummaries = tool.editSummaries || (tool as any).editSummaries
			if (editSummaries && editSummaries.length > 0 && tool.diff) {
				// Split the full diff into chunks by file marker
				const diffChunks: Record<string, string[]> = {}
				const lines = tool.diff.split("\n")
				let currentPath: string | null = null
				let currentChunk: string[] = []

				for (const line of lines) {
					// Match both formats:
					// 1. *** Add/Update/Delete File: path (from ToolExecutor/BatchProcessor)
					// 2. *** Update File: path (from BatchProcessor)
					const fileMatch = line.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/)
					if (fileMatch) {
						if (currentPath && currentChunk.length > 0) {
							diffChunks[currentPath] = (diffChunks[currentPath] || []).concat(currentChunk)
						}
						currentPath = fileMatch[1].trim()
						currentChunk = [line]
					} else if (currentPath) {
						currentChunk.push(line)
					}
				}
				if (currentPath && currentChunk.length > 0) {
					diffChunks[currentPath] = (diffChunks[currentPath] || []).concat(currentChunk)
				}

				editSummaries.forEach((summary: any, idx: number) => {
					const additions = summary.edits?.reduce((acc: number, e: any) => acc + (e.additions || 0), 0) || summary.additions || 0
					const deletions = summary.edits?.reduce((acc: number, e: any) => acc + (e.deletions || 0), 0) || summary.deletions || 0
					const path = summary.path
					const fileDiff = diffChunks[path]?.join("\n") || tool.diff
					units.push({
						isFilePath: true,
						toolName: "editFile",
						id: `${message.ts}-edit-${idx}`,
						type: "editFile",
						label: "Edit",
						subLabel: `${cleanPathPrefix(path)} (+${additions} -${deletions})`,
						status,
						icon,
						isExpandable: true,
						content: fileDiff,
						path: path,
						hunks: summary.hunks,
					})
				})
			} else if (tool.path || (tool as any).path) {
				const path = tool.path || (tool as any).path
				const editsCount = tool.editsCount || (tool as any).editsCount
				units.push({
					toolName: "editFile",
					id: `${message.ts}-edit-0`,
					type: "editFile",
					label: "Edit",
					subLabel: `${cleanPathPrefix(path)}${editsCount ? ` (${editsCount} edits)` : ""}`,
					status,
					icon,
					isExpandable: true,
					content: tool.diff,
					path: path,
					isFilePath: true,
				})
			}
			break
		}

		case "executeCommand":
		case "execute_command": {
			units.push({
				toolName: "executeCommand",
				id: `${message.ts}-exec`,
				type: "executeCommand",
				label: "Execute",
				subLabel: `${tool.command || "command"}${(tool as any).exitCode !== undefined ? ` (exit ${(tool as any).exitCode})` : ""}`,
				status,
				icon,
				isExpandable: true,
				content: tool.content || (tool as any).output,
				path: (tool as any).cwd,
			})
			break
		}

		case "getFunction":
		case "get_function":
		case "getFileSkeleton":
		case "get_file_skeleton": {
			relPaths.forEach((path: string, idx: number) => {
				const isSkeleton = tool.tool === "getFileSkeleton" || tool.tool === "get_file_skeleton"
				const label = isSkeleton ? `Get skeleton of ${cleanPathPrefix(path)}` : `Get functions from ${cleanPathPrefix(path)}`
				units.push({
					isFilePath: true,
					toolName: tool.tool,
					id: `${message.ts}-${tool.tool}-${idx}`,
					type: tool.tool,
					label: isSkeleton ? "Get skeleton" : "Get function",
					subLabel: cleanPathPrefix(path),
					status,
					icon,
					isExpandable: true,
					content: tool.content || (tool.skeletons ? JSON.stringify(tool.skeletons, null, 2) : undefined),
					path,
				})
			})
			break
		}

		case "findSymbolReferences":
		case "find_symbol_references": {
			relPaths.forEach((path: string, idx: number) => {
				units.push({
					toolName: tool.tool,
					id: `${message.ts}-${tool.tool}-${idx}`,
					type: tool.tool,
					label: "References",
					subLabel: cleanPathPrefix(path),
					status,
					icon,
					isExpandable: true,
					content: tool.content || (tool.references ? JSON.stringify(tool.references, null, 2) : undefined),
					path,
				})
			})
			break
		}

		case "renameSymbol":
		case "rename_symbol": {
			const editSummaries = tool.editSummaries || (tool as any).editSummaries
			if (editSummaries && editSummaries.length > 0 && tool.diff) {
				const diffChunks: Record<string, string[]> = {}
				const lines = tool.diff.split("\n")
				let currentPath: string | null = null
				let currentChunk: string[] = []

				for (const line of lines) {
					const fileMatch = line.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/)
					if (fileMatch) {
						if (currentPath && currentChunk.length > 0) {
							diffChunks[currentPath] = (diffChunks[currentPath] || []).concat(currentChunk)
						}
						currentPath = fileMatch[1].trim()
						currentChunk = [line]
					} else if (currentPath) {
						currentChunk.push(line)
					}
				}
				if (currentPath && currentChunk.length > 0) {
					diffChunks[currentPath] = (diffChunks[currentPath] || []).concat(currentChunk)
				}

				editSummaries.forEach((summary: any, idx: number) => {
					const additions = summary.edits?.reduce((acc: number, e: any) => acc + (e.additions || 0), 0) || 0
					const deletions = summary.edits?.reduce((acc: number, e: any) => acc + (e.deletions || 0), 0) || 0
					const path = summary.path
					const fileDiff = diffChunks[path]?.join("\n") || tool.diff

					units.push({
						isFilePath: true,
						toolName: "renameSymbol",
						id: `${message.ts}-rename-${idx}`,
						type: "renameSymbol",
						label: "Rename",
						subLabel: `${tool.existing_symbol} → ${tool.new_symbol} in ${cleanPathPrefix(path)} (+${additions} -${deletions})`,
						status,
						icon,
						isExpandable: true,
						content: fileDiff,
						path: path,
						hunks: summary.hunks,
					})
				})
			} else {
				units.push({
					toolName: "renameSymbol",
					id: `${message.ts}-rename`,
					type: "renameSymbol",
					isFilePath: true,
					label: "Rename",
					subLabel: `${tool.existing_symbol} → ${tool.new_symbol}`,
					status,
					icon,
					isExpandable: true,
					content: tool.diff || tool.content,
					path: tool.path,
				})
			}
			break
		}

		case "replaceSymbol":
		case "replace_symbol": {
			const replacements = tool.replacements || (tool as any).replacements
			// v0.6 Sprint 1-F: ReplaceSymbol now emits editSummaries[] with per-file hunks.
			const editSummariesByPath = new Map<string, any>()
			const replaceSummaries = (tool.editSummaries || (tool as any).editSummaries) as any[] | undefined
			if (Array.isArray(replaceSummaries)) {
				for (const s of replaceSummaries) {
					if (s?.path) editSummariesByPath.set(s.path, s)
				}
			}
			if (replacements && Array.isArray(replacements)) {
				replacements.forEach((r: any, idx: number) => {
					const summary = editSummariesByPath.get(r.path)
					units.push({
						toolName: "replaceSymbol",
						id: `${message.ts}-replace-${idx}`,
						type: "replaceSymbol",
						isFilePath: true,
						label: "Replace",
						subLabel: `${r.symbol} in ${cleanPathPrefix(r.path || "")}`,
						symbol: r.symbol,
						status,
						icon,
						isExpandable: true,
						content: r.diff || r.text,
						path: r.path,
						hunks: summary?.hunks,
					})
				})
			} else {
				const summary = tool.path ? editSummariesByPath.get(tool.path) : undefined
				units.push({
					toolName: "replaceSymbol",
					id: `${message.ts}-replace`,
					type: "replaceSymbol",
					isFilePath: true,
					label: "Replace",
					subLabel: `${tool.symbol} in ${cleanPathPrefix(tool.path || "")}`,
					symbol: tool.symbol,
					status,
					icon,
					isExpandable: true,
					content: tool.diff || tool.content || (tool as any).newContent,
					path: tool.path,
					hunks: summary?.hunks ?? replaceSummaries?.[0]?.hunks,
				})
			}
			break
		}
		case "newFileCreated":
		case "editedExistingFile":
		case "fileDeleted": {
			// v0.6 Sprint 1-F: WriteToFile may now ship editSummaries[0].hunks
			// so we render structured +/- diff via DiffEditRow (EditFileOutput).
			const editSummary = (tool.editSummaries || (tool as any).editSummaries)?.[0]
			units.push({
				toolName: tool.tool,
				id: `${message.ts}-edit-0`,
				type: tool.tool,
				label: tool.tool === "newFileCreated" ? "Create" : tool.tool === "fileDeleted" ? "Delete" : "Edit",
				subLabel: cleanPathPrefix(tool.path || ""),
				status,
				icon,
				isExpandable: true,
				content: tool.content || tool.diff,
				path: tool.path,
				isFilePath: true,
				hunks: editSummary?.hunks,
			})
			break
		}


		case "browser_action":
		case "browser_action_result": {
			units.push({
				toolName: tool.tool || tool.browser_action?.action,
				id: `${message.ts}-browser`,
				type: tool.tool,
				label: "Browser",
				subLabel: tool.action || tool.browser_action?.action || "Action",
				status,
				icon,
				isExpandable: true,
				content: tool.content,
			})
			break
		}


		case "diagnosticsScan":
		case "diagnostics_scan": {
			const label = relPaths.length > 0 ? `Diagnostics Scan for ${relPaths.map((p) => cleanPathPrefix(p)).join(", ")}` : "Diagnostics Scan"
			units.push({
				toolName: "diagnosticsScan",
				id: `${message.ts}-diag`,
				type: "diagnosticsScan",
				label: "Scan",
				subLabel: `${relPaths.length > 0 ? relPaths.map((p) => cleanPathPrefix(p)).join(", ") : ""}${tool.diagnostics?.fixedCount || (tool as any).fixedCount ? ` (fixed ${tool.diagnostics?.fixedCount || (tool as any).fixedCount})` : ""}`,
				status,
				icon,
				isExpandable: true,
				content: tool.content || tool.diagnostics?.newProblemsMessage,
			})
			break
		}

		case "subagent": {
			units.push({
				toolName: "subagent",
				id: `${message.ts}-subagent`,
				type: "subagent",
				label: "Subagent",
				status,
				icon,
				isExpandable: true,
				content: tool.content,
			})
			break
		}

		default: {
			// Unknown tool or non-tool message absorbed into group - return nothing
			return []
		}
	}

	return units
}
