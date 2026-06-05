import fs from "node:fs/promises"
import path from "node:path"
import type { ToolUse } from "@core/assistant-message"
import { formatResponse } from "@core/prompts/responses"
import { resolveWorkspacePath } from "@core/workspace"
import { extractFileContent } from "@integrations/misc/extract-file-content"
import { contentHash, hashLines, stripHashes } from "@utils/line-hashing"
import { arePathsEqual, getReadablePath, isLocatedInWorkspace } from "@utils/path"
import { telemetryService } from "@/services/telemetry"
import { IsaacSayTool } from "@/shared/ExtensionMessage"
import { IsaacStorageMessage } from "@/shared/messages"
import { IsaacDefaultTool } from "@/shared/tools"
import type { ToolResponse } from "../../index"
import { showNotificationForApproval } from "../../utils"
import type { IFullyManagedTool } from "../ToolExecutorCoordinator"
import type { ToolValidator } from "../ToolValidator"
import type { TaskConfig } from "../types/TaskConfig"
import type { StronglyTypedUIHelpers } from "../types/UIHelpers"
import { coerceToStringArray } from "../utils/coerceArray"
import { extractLastKnownHashFromHistory } from "../utils/extractLastKnownHash"
import { ToolResultUtils } from "../utils/ToolResultUtils"
import { sliceContentLines } from "./readFilePagination"

const DEFAULT_MAX_FILE_READ_SIZE = 50_000 // 50KB default for full file reads
const ABSOLUTE_MAX_FILE_READ_SIZE = 5_000_000 // 5MB hard cap regardless of user setting
// Backwards-compatible export kept for tooling that imported the old name.
export const MAX_FILE_READ_SIZE = DEFAULT_MAX_FILE_READ_SIZE

function resolveMaxFileReadSize(config: TaskConfig): number {
	let configured: number | undefined
	try {
		configured = config.services.stateManager.getGlobalSettingsKey("readFileMaxSize" as any) as number | undefined
	} catch {
		configured = undefined
	}
	const value =
		typeof configured === "number" && Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_MAX_FILE_READ_SIZE
	return Math.min(value, ABSOLUTE_MAX_FILE_READ_SIZE)
}

export class ReadFileToolHandler implements IFullyManagedTool {
	readonly name = IsaacDefaultTool.FILE_READ

	constructor(private validator: ToolValidator) {}

	getDescription(block: ToolUse): string {
		const relPaths = coerceToStringArray(block.params.paths)
		const range =
			block.params.start_line || block.params.end_line
				? ` lines ${block.params.start_line || 1}-${block.params.end_line || "?"}`
				: ""
		return `[${block.name} for ${relPaths.map((p) => `'${p}'`).join(", ")}${range}]`
	}

	async handlePartialBlock(block: ToolUse, uiHelpers: StronglyTypedUIHelpers): Promise<void> {
		const relPaths = coerceToStringArray(block.params.paths)
		const config = uiHelpers.getConfig()
		if (config.isSubagentExecution) {
			return
		}

		// Create and show partial UI message
		const sharedMessageProps = {
			tool: "readFile",
			paths: relPaths.map((p) => getReadablePath(config.cwd, uiHelpers.removeClosingTag(block, "paths", p))),
			content: undefined,
			operationIsLocatedInWorkspace: (await Promise.all(relPaths.map((p) => isLocatedInWorkspace(p)))).every(Boolean),
			startLine: uiHelpers.removeClosingTag(block, "start_line", block.params.start_line),
			endLine: uiHelpers.removeClosingTag(block, "end_line", block.params.end_line),
			readFileResults: relPaths.map((p) => ({
				path: getReadablePath(config.cwd, uiHelpers.removeClosingTag(block, "paths", p)),
				status: "success" as const,
				label: "Reading...",
			})),
		}
		const partialMessage = JSON.stringify(sharedMessageProps)

		// Handle auto-approval vs manual approval for partial
		const firstPath = relPaths[0] || ""
		if (await uiHelpers.shouldAutoApproveToolWithPath(block.name, firstPath)) {
			await uiHelpers.removeLastPartialMessageIfExistsWithType("ask", "tool")
			await uiHelpers.say("tool", partialMessage, undefined, undefined, block.partial)
		} else {
			await uiHelpers.removeLastPartialMessageIfExistsWithType("say", "tool")
			await uiHelpers.ask("tool", partialMessage, block.partial).catch(() => {})
		}
	}

	private extractLastKnownHashFromHistory(history: IsaacStorageMessage[], targetPath: string): string | undefined {
		return extractLastKnownHashFromHistory(history, targetPath, this.name)
	}

	async execute(config: TaskConfig, block: ToolUse): Promise<ToolResponse> {
		const relPaths = coerceToStringArray(block.params.paths)
		const startLineNum = block.params.start_line ? Number.parseInt(String(block.params.start_line)) : undefined
		const endLineNum = block.params.end_line ? Number.parseInt(String(block.params.end_line)) : undefined
		const rawOffset = (block.params as any).offset
		const rawLimit = (block.params as any).limit
		const offsetNum = rawOffset !== undefined && rawOffset !== "" ? Number.parseInt(String(rawOffset)) : undefined
		const limitNum = rawLimit !== undefined && rawLimit !== "" ? Number.parseInt(String(rawLimit)) : undefined

		const hasLineRange = startLineNum !== undefined || endLineNum !== undefined
		const hasOffsetLimit = offsetNum !== undefined || limitNum !== undefined
		const maxFileReadSize = resolveMaxFileReadSize(config)

		const emitParamError = async (error: string) => {
			config.taskState.consecutiveMistakeCount++
			const sharedMessageProps = {
				tool: "readFile",
				paths: relPaths.map((p) => getReadablePath(config.cwd, p)),
				content: error,
				operationIsLocatedInWorkspace: true,
				path: relPaths[0],
				startLine: block.params.start_line?.toString(),
				endLine: block.params.end_line?.toString(),
				readFileResults: relPaths.map((p) => ({
					path: getReadablePath(config.cwd, p),
					status: "error" as const,
					label: "Invalid parameters",
				})),
			} satisfies IsaacSayTool
			await config.callbacks.removeLastPartialMessageIfExistsWithType("ask", "tool")
			await config.callbacks.removeLastPartialMessageIfExistsWithType("say", "tool")
			await config.callbacks.say("tool", JSON.stringify(sharedMessageProps), undefined, undefined, false)
			return formatResponse.toolError(error)
		}

		if (hasLineRange && hasOffsetLimit) {
			return await emitParamError(
				"Cannot combine start_line/end_line with offset/limit. Choose one pagination style: start_line/end_line (1-based inclusive) OR offset/limit (0-based).",
			)
		}

		if (offsetNum !== undefined && (Number.isNaN(offsetNum) || offsetNum < 0)) {
			return await emitParamError("Invalid offset. Must be a non-negative integer.")
		}
		if (limitNum !== undefined && (Number.isNaN(limitNum) || limitNum <= 0)) {
			return await emitParamError("Invalid limit. Must be a positive integer.")
		}

		if ((block.params.start_line && isNaN(startLineNum!)) || (block.params.end_line && isNaN(endLineNum!))) {
			config.taskState.consecutiveMistakeCount++
			const error = "Invalid line numbers. Please provide valid integers for start_line and end_line."

			// Ensure UI is updated to mark the tool call as complete (avoiding "stuck" state)
			const sharedMessageProps = {
				tool: "readFile",
				paths: relPaths.map((p) => getReadablePath(config.cwd, p)),
				content: error,
				operationIsLocatedInWorkspace: true,
				path: relPaths[0],
				startLine: block.params.start_line?.toString(),
				endLine: block.params.end_line?.toString(),
				readFileResults: relPaths.map((p) => ({
					path: getReadablePath(config.cwd, p),
					status: "error" as const,
					label: "Invalid line numbers",
				})),
			} satisfies IsaacSayTool
			const completeMessage = JSON.stringify(sharedMessageProps)

			await config.callbacks.removeLastPartialMessageIfExistsWithType("ask", "tool")
			await config.callbacks.removeLastPartialMessageIfExistsWithType("say", "tool")
			await config.callbacks.say("tool", completeMessage, undefined, undefined, false)

			return formatResponse.toolError(error)
		}

		// Ensure apiConversationHistory is passed into TaskConfig from the main Isaac instance
		const history = config.messageState.getApiConversationHistory() || []

		// Extract provider information for telemetry
		const apiConfig = config.services.stateManager.getApiConfiguration()
		const currentMode = config.services.stateManager.getGlobalSettingsKey("mode")
		const provider = (currentMode === "plan" ? apiConfig.planModeApiProvider : apiConfig.actModeApiProvider) as string

		// Validate required parameters
		const pathValidation = this.validator.assertRequiredParams(block, "paths")

		if (!pathValidation.ok) {
			config.taskState.consecutiveMistakeCount++
			return await config.callbacks.sayAndCreateMissingParamError(this.name, "paths")
		}

		const absolutePaths: string[] = []
		const displayPaths: string[] = []
		const workspaceContexts: any[] = []
		const results: string[] = []
		const readFileResults: any[] = []

		const imageBlocks: any[] = []
		let anyFailed = false
		let anySucceeded = false

		const supportsImages = config.api.getModel().info.supportsImages ?? false

		for (let i = 0; i < relPaths.length; i++) {
			const relPath = relPaths[i]
			const header = relPaths.length > 1 ? `--- ${relPath} ---\n` : ""

			try {
				// 1. Check diracignore access
				const accessValidation = this.validator.checkIsaacIgnorePath(relPath)
				if (!accessValidation.ok) {
					if (!config.isSubagentExecution) {
						await config.callbacks.say("diracignore_error", relPath)
					}
					results.push(`${header}${formatResponse.diracIgnoreError(relPath)}`)
					readFileResults.push({
						path: relPath,
						status: "error",
						label: "Isaacignore prevented file read",
					})
					anyFailed = true

					// Fill telemetry/UI fallbacks
					absolutePaths.push("")
					displayPaths.push(relPath)
					workspaceContexts.push({
						isMultiRootEnabled: !!config.isMultiRootEnabled,
						resolutionMethod: "ignored",
					})
					continue
				}

				// 2. Resolve the absolute path
				const pathResult = resolveWorkspacePath(config, relPath, "ReadFileToolHandler.execute")
				const { absolutePath, displayPath } =
					typeof pathResult === "string" ? { absolutePath: pathResult, displayPath: relPath } : pathResult

				absolutePaths.push(absolutePath)
				displayPaths.push(displayPath)

				// Determine workspace context for telemetry
				const fallbackAbsolutePath = path.resolve(config.cwd, relPath)
				workspaceContexts.push({
					isMultiRootEnabled: config.isMultiRootEnabled || false,
					usedWorkspaceHint: typeof pathResult !== "string",
					resolvedToNonPrimary: !arePathsEqual(absolutePath, fallbackAbsolutePath),
					resolutionMethod: (typeof pathResult !== "string" ? "hint" : "primary_fallback") as
						| "hint"
						| "primary_fallback",
				})

				// 3. Safety check: prevent reading files too large
				if (!hasLineRange && !hasOffsetLimit) {
					const stats = await fs.stat(absolutePath)
					const ext = path.extname(absolutePath).toLowerCase()
					const isImage = [".png", ".jpg", ".jpeg", ".webp"].includes(ext)
					if (stats.isFile() && !isImage && stats.size > maxFileReadSize) {
						const estimatedLines = Math.max(1, Math.ceil(stats.size / 80))
						const message =
							`File ${displayPath} is ${stats.size} bytes which exceeds the read limit (${maxFileReadSize} bytes).\n` +
							`To read this file, use one of:\n` +
							`  - start_line / end_line (1-based, inclusive): read_file path="${displayPath}" start_line=1 end_line=200\n` +
							`  - offset / limit (0-based): read_file path="${displayPath}" offset=0 limit=200\n` +
							`  - Or increase the readFileMaxSize setting if the full file is needed.\n` +
							`File has approximately ${estimatedLines} lines (estimated).`
						results.push(`${header}${message}`)
						readFileResults.push({
							path: displayPath,
							status: "error",
							label: `File too large (> ${maxFileReadSize} bytes)`,
						})
						anyFailed = true
						continue
					}
				}

				// 4. Execute the file read operation
				const providedHash = this.extractLastKnownHashFromHistory(history, relPath)
				const fileContent = await extractFileContent(absolutePath, supportsImages)

				// Track file read operation
				await config.services.fileContextTracker.trackFileContext(relPath, "read_tool")
				anySucceeded = true

				// Store image blocks to push after potential approval
				if (fileContent.imageBlock) {
					imageBlocks.push(fileContent.imageBlock)
				}

				const currentHash = contentHash(fileContent.text)

				if (providedHash === currentHash && !hasLineRange && !hasOffsetLimit) {
					results.push(`${header}no changes have been made to the file since your last read (Hash: ${providedHash})`)
				} else {
					const hashedContent = sliceContentLines(hashLines(fileContent.text, absolutePath, config.ulid), {
						startLineNum,
						endLineNum,
						offsetNum,
						limitNum,
					})
					results.push(`${header}[File Hash: ${currentHash}]\n${hashedContent}`)
				}

				const range = hasLineRange
					? `lines ${startLineNum || 1} to ${endLineNum || "end"}`
					: hasOffsetLimit
						? `offset ${offsetNum ?? 0} limit ${limitNum ?? "all"}`
						: "full file"
				readFileResults.push({
					path: displayPath,
					status: "success",
					label: `Read ${range}`,
				})
			} catch (error) {
				anyFailed = true
				const errorMessage = error instanceof Error ? error.message : String(error)
				const normalizedMessage = errorMessage.startsWith("Error reading file:")
					? errorMessage
					: `Error reading file: ${errorMessage}`
				results.push(`${header}${normalizedMessage}`)

				// Ensure arrays are filled for telemetry/UI if they haven't been yet
				if (absolutePaths.length <= i) absolutePaths.push("")
				if (displayPaths.length <= i) displayPaths.push(relPath)
				if (workspaceContexts.length <= i)
					workspaceContexts.push({ isMultiRootEnabled: !!config.isMultiRootEnabled, resolutionMethod: "error" })

				readFileResults.push({
					path: displayPaths[i] || relPath,
					status: "error",
					label: normalizedMessage,
				})
			}
		}

		if (anyFailed) {
			config.taskState.consecutiveMistakeCount++
		} else if (anySucceeded) {
			config.taskState.consecutiveMistakeCount = 0
		}

		const finalResult = results.join("\n\n")

		// Handle approval flow
		const sharedMessageProps = {
			tool: "readFile",
			paths: displayPaths.map((p) => getReadablePath(config.cwd, p)),
			content: stripHashes(finalResult),
			operationIsLocatedInWorkspace: (await Promise.all(relPaths.map((p) => isLocatedInWorkspace(p)))).every(Boolean),
			path: displayPaths[0],
			startLine: startLineNum?.toString(),
			endLine: endLineNum?.toString(),
			readFileResults: readFileResults.map((r) => ({
				...r,
				path: getReadablePath(config.cwd, r.path),
			})),
		} satisfies IsaacSayTool

		const completeMessage = JSON.stringify(sharedMessageProps)

		const shouldAutoApprove =
			config.isSubagentExecution ||
			(await Promise.all(relPaths.map((p) => config.callbacks.shouldAutoApproveToolWithPath(block.name, p)))).every(Boolean)

		if (shouldAutoApprove) {
			// Auto-approval flow
			if (!config.isSubagentExecution) {
				await config.callbacks.removeLastPartialMessageIfExistsWithType("ask", "tool")
				await config.callbacks.say("tool", completeMessage, undefined, undefined, false)
			}

			// Capture telemetry for each path
			for (let i = 0; i < relPaths.length; i++) {
				telemetryService.captureToolUsage(
					config.ulid,
					block.name,
					config.api.getModel().id,
					provider,
					true,
					true,
					workspaceContexts[i],
					block.isNativeToolCall,
				)
			}
		} else {
			// Manual approval flow
			const range = startLineNum || endLineNum ? ` lines ${startLineNum || 1}-${endLineNum || "?"}` : ""
			const notificationMessage = `Isaac wants to read ${relPaths.length} file(s)${range}`
			showNotificationForApproval(notificationMessage, config.autoApprovalSettings.enableNotifications)

			await config.callbacks.removeLastPartialMessageIfExistsWithType("say", "tool")

			const { didApprove } = await ToolResultUtils.askApprovalAndPushFeedback("tool", completeMessage, config)
			if (!didApprove) {
				for (let i = 0; i < relPaths.length; i++) {
					telemetryService.captureToolUsage(
						config.ulid,
						block.name,
						config.api.getModel().id,
						provider,
						false,
						false,
						workspaceContexts[i],
						block.isNativeToolCall,
					)
				}
				return formatResponse.toolDenied()
			}

			for (let i = 0; i < relPaths.length; i++) {
				telemetryService.captureToolUsage(
					config.ulid,
					block.name,
					config.api.getModel().id,
					provider,
					false,
					true,
					workspaceContexts[i],
					block.isNativeToolCall,
				)
			}
		}

		// Run PreToolUse hook after approval but before execution
		try {
			const { ToolHookUtils } = await import("../utils/ToolHookUtils")
			await ToolHookUtils.runPreToolUseIfEnabled(config, block)
		} catch (error) {
			const { PreToolUseHookCancellationError } = await import("@core/hooks/PreToolUseHookCancellationError")
			if (error instanceof PreToolUseHookCancellationError) {
				return formatResponse.toolDenied()
			}
			throw error
		}

		// Push image blocks to task state after approval
		for (const imageBlock of imageBlocks) {
			config.taskState.userMessageContent.push(imageBlock)
		}

		return finalResult
	}
}
