import path from "node:path"
import fs from "node:fs/promises"
import { setTimeout as setTimeoutPromise } from "node:timers/promises"
import type { ToolUse } from "@core/assistant-message"
import { formatResponse } from "@core/prompts/responses"
import { getWorkspaceBasename, resolveWorkspacePath } from "@core/workspace"
import { processFilesIntoText } from "@integrations/misc/extract-text"
import { DiracSayTool } from "@shared/ExtensionMessage"
import { getLastApiReqTotalTokens } from "@shared/getApiMetrics"
import { stripHashes } from "@utils/line-hashing"
import { arePathsEqual, getReadablePath, isLocatedInWorkspace } from "@utils/path"
import { applyPatch } from "diff"
import { computeDiffFromContents, type DiffStructure } from "@shared/utils/diff"
import { telemetryService } from "@/services/telemetry"
import { DiracDefaultTool } from "@/shared/tools"
import type { ToolResponse } from "../../index"
import { showNotificationForApproval } from "../../utils"
import type { IFullyManagedTool } from "../ToolExecutorCoordinator"
import type { ToolValidator } from "../ToolValidator"
import type { TaskConfig } from "../types/TaskConfig"
import type { StronglyTypedUIHelpers } from "../types/UIHelpers"
import { captureAccepted, captureRejected, getModelInfo } from "../utils/AiOutputTelemetry"
import { applyModelContentFixes } from "../utils/ModelContentProcessor"
import { ToolResultUtils } from "../utils/ToolResultUtils"

export class WriteToFileToolHandler implements IFullyManagedTool {
	readonly name = DiracDefaultTool.FILE_NEW // This handler supports write_to_file and new_rule

	constructor(private validator: ToolValidator) {}

	getDescription(block: ToolUse): string {
		return `[${block.name} for '${block.params.path}']`
	}

	async handlePartialBlock(block: ToolUse, uiHelpers: StronglyTypedUIHelpers): Promise<void> {
		const rawRelPath = block.params.path as string | undefined
		const rawContent = block.params.content // for write_to_file

		// Early return if we don't have enough data yet
		if (!rawRelPath || !rawContent) {
			// Wait until we have the path and content
			return
		}

		const config = uiHelpers.getConfig()

		// Creates file if it doesn't exist, and opens editor to stream content in. We don't want to handle this in the try/catch below since the error handler for it resets the diff view, which wouldn't be open if this failed.
		const result = await this.validateAndPrepareFileOperation(config, block, rawRelPath, undefined, rawContent)
		if ("error" in result) {
			return
		}

		try {
			const { relPath, absolutePath, fileExists, content, newContent } = result

			// Create and show partial UI message
			const sharedMessageProps: DiracSayTool = {
				tool: fileExists ? "editedExistingFile" : "newFileCreated",
				path: getReadablePath(
					config.cwd,
					uiHelpers.removeClosingTag(block, "path", relPath),
				),
				content: content,
				operationIsLocatedInWorkspace: await isLocatedInWorkspace(relPath),
				startLineNumbers: undefined,
			}
			const partialMessage = JSON.stringify(sharedMessageProps)

			// Handle auto-approval vs manual approval for partial
			const shouldAutoApprove = await uiHelpers.shouldAutoApproveToolWithPath(block.name, relPath)
			if (shouldAutoApprove) {
				await uiHelpers.removeLastPartialMessageIfExistsWithType("ask", "tool") // in case the user changes auto-approval settings mid stream
				await uiHelpers.say("tool", partialMessage, undefined, undefined, block.partial)
			} else {
				await uiHelpers.removeLastPartialMessageIfExistsWithType("say", "tool")
				await uiHelpers.ask("tool", partialMessage, block.partial).catch(() => {})
			}

			// CRITICAL: Open editor and stream content in real-time (from original code)
			if (!(shouldAutoApprove && config.backgroundEditEnabled)) {
				if (!config.services.diffViewProvider.isEditing) {
					// Open the editor and prepare to stream content in
					await config.services.diffViewProvider.open(relPath)
				}
				// Editor is open, stream content in real-time (false = don't finalize yet)
				await config.services.diffViewProvider.update(newContent, false)
			}
		} catch (error) {
			// Reset diff view on error
			await config.services.diffViewProvider.revertChanges()
			throw error
		}
	}

	async execute(config: TaskConfig, block: ToolUse): Promise<ToolResponse> {
		const rawRelPath = block.params.path as string | undefined
		const rawContent = block.params.content // for write_to_file

		// Extract provider information for telemetry
		const { providerId, modelId } = getModelInfo(config)

		// Validate required parameters based on tool type
		if (!rawRelPath) {
			config.taskState.consecutiveMistakeCount++
			await config.services.diffViewProvider.reset()
			return await config.callbacks.sayAndCreateMissingParamError(
				block.name,
				"path",
			)
		}

		if (block.name === DiracDefaultTool.FILE_NEW && !rawContent) {
			config.taskState.consecutiveMistakeCount++
			await config.services.diffViewProvider.reset()

			// Use progressive error with token budget awareness
			const relPath = rawRelPath || "unknown"
			const contextWindow = config.api.getModel().info.contextWindow ?? 128_000
			const lastApiReqTotalTokens = getLastApiReqTotalTokens(config.messageState.getDiracMessages())
			const contextUsagePercent = contextWindow > 0 ? Math.round((lastApiReqTotalTokens / contextWindow) * 100) : undefined
			const errorMessage = formatResponse.writeToFileMissingContentError(
				relPath,
				config.taskState.consecutiveMistakeCount,
				contextUsagePercent,
			)

			await config.callbacks.say(
				"error",
				`Dirac tried to use write_to_file for '${relPath}' without providing a value for 'content'. ${
					config.taskState.consecutiveMistakeCount >= 2
						? "This has happened multiple times — Dirac will try a different approach."
						: "Retrying..."
				}`,
			)
			return formatResponse.toolError(errorMessage)
		}

		if (block.name === "new_rule" && !rawContent) {
			config.taskState.consecutiveMistakeCount++
			await config.services.diffViewProvider.reset()
			return await config.callbacks.sayAndCreateMissingParamError(block.name, "content")
		}

		// NOTE: Do NOT reset consecutiveMistakeCount here - it should only be reset after successful completion
		// The reset was moved to after saveChanges() succeeds to properly track consecutive failures

		try {
			const result = await this.validateAndPrepareFileOperation(config, block, rawRelPath, undefined, rawContent)
			if ("error" in result) {
				return result.error
			}

			const { relPath, absolutePath, fileExists, content, newContent, workspaceContext } = result

			// Handle approval flow
			const sharedMessageProps: DiracSayTool = {
				tool: fileExists ? "editedExistingFile" : "newFileCreated",
				path: getReadablePath(config.cwd, relPath),
				content: content,
				operationIsLocatedInWorkspace: await isLocatedInWorkspace(relPath),
				startLineNumbers: undefined,
			}
			// showOmissionWarning(this.diffViewProvider.originalContent || "", newContent)

			// v0.6 Sprint 1-F: structured hunks for unified +/- rendering in webview/CLI.
			// Compute from originalContent (empty for new files) and newContent.
			const originalForDiff = fileExists ? config.services.diffViewProvider.originalContent || "" : ""
			let editSummaries: DiracSayTool["editSummaries"]
			// Performance guard mirroring BatchProcessor (skip when buffers are huge)
			if (originalForDiff.length + newContent.length <= 1_000_000) {
				const computed = computeDiffFromContents(originalForDiff, newContent)
				const hunks: DiffStructure = {
					path: relPath,
					totalAdditions: computed.totalAdditions,
					totalDeletions: computed.totalDeletions,
					blocks: computed.blocks,
				}
				editSummaries = [
					{
						path: relPath,
						edits: [{ additions: computed.totalAdditions, deletions: computed.totalDeletions }],
						hunks,
					},
				]
			}

			const completeMessage = JSON.stringify({
				...sharedMessageProps,
				content: content,
				operationIsLocatedInWorkspace: await isLocatedInWorkspace(relPath),
				editSummaries,
			} satisfies DiracSayTool)

			const shouldAutoApprove = await config.callbacks.shouldAutoApproveToolWithPath(block.name, relPath)
			if (shouldAutoApprove) {
				// Auto-approval flow
				await config.callbacks.removeLastPartialMessageIfExistsWithType("ask", "tool")
				await config.callbacks.say("tool", completeMessage, undefined, undefined, false)

				// Capture telemetry
				telemetryService.captureToolUsage(
					config.ulid,
					block.name,
					modelId,
					providerId,
					true,
					true,
					workspaceContext,
					block.isNativeToolCall,
				)
				// Capture AI output accepted telemetry with line diff stats (auto-approval)
				captureAccepted({
					ulid: config.ulid,
					tool: block.name,
					source: "agent",
					beforeContent: config.services.diffViewProvider.originalContent || "",
					afterContent: newContent,
					providerId,
					modelId,
					filesCreated: fileExists ? 0 : 1,
				})
			} else {
				// Manual approval flow with detailed feedback handling
				const notificationMessage = `Dirac wants to ${fileExists ? "edit" : "create"} ${getWorkspaceBasename(relPath, "WriteToFile.notification")}`

				// Show notification
				showNotificationForApproval(notificationMessage, config.autoApprovalSettings.enableNotifications)

				await config.callbacks.removeLastPartialMessageIfExistsWithType("say", "tool")
				await config.callbacks.removeLastPartialMessageIfExistsWithType("ask", "tool")

				// Need a more customized tool response for file edits to highlight the fact that the file was not updated (particularly important for deepseek)

				const { response, text, images, files } = await config.callbacks.ask("tool", completeMessage, false)

				if (response !== "yesButtonClicked") {
					// Handle rejection with detailed messages
					const fileDeniedNote = fileExists
						? "The file was not updated, and maintains its original contents."
						: "The file was not created."

					// Process user feedback if provided (with file content processing)
					if (text || (images && images.length > 0) || (files && files.length > 0)) {
						let fileContentString = ""
						if (files && files.length > 0) {
							fileContentString = await processFilesIntoText(files)
						}

						// Push additional tool feedback using existing utilities
						ToolResultUtils.pushAdditionalToolFeedback(
							config.taskState.userMessageContent,
							text,
							images,
							fileContentString,
						)
						await config.callbacks.say("user_feedback", text, images, files)
					}

					config.taskState.didRejectTool = true
					telemetryService.captureToolUsage(
						config.ulid,
						block.name,
						modelId,
						providerId,
						false,
						false,
						workspaceContext,
						block.isNativeToolCall,
					)

					// Capture AI output rejected telemetry with line diff stats
					captureRejected({
						ulid: config.ulid,
						tool: block.name,
						source: "agent",
						beforeContent: config.services.diffViewProvider.originalContent || "",
						afterContent: newContent,
						providerId,
						modelId,
						filesCreated: fileExists ? 0 : 1,
					})

					await config.services.diffViewProvider.revertChanges()
					return `The user denied this operation. ${fileDeniedNote}`
				}
				// User hit the approve button, and may have provided feedback
				if (text || (images && images.length > 0) || (files && files.length > 0)) {
					let fileContentString = ""
					if (files && files.length > 0) {
						fileContentString = await processFilesIntoText(files)
					}

					// Push additional tool feedback using existing utilities
					ToolResultUtils.pushAdditionalToolFeedback(
						config.taskState.userMessageContent,
						text,
						images,
						fileContentString,
					)
					await config.callbacks.say("user_feedback", text, images, files)
				}

				telemetryService.captureToolUsage(
					config.ulid,
					block.name,
					modelId,
					providerId,
					false,
					true,
					workspaceContext,
					block.isNativeToolCall,
				)

				// Capture AI output accepted telemetry with line diff stats (manual approval)
				captureAccepted({
					ulid: config.ulid,
					tool: block.name,
					source: "agent",
					beforeContent: config.services.diffViewProvider.originalContent || "",
					afterContent: newContent,
					providerId,
					modelId,
					filesCreated: fileExists ? 0 : 1,
				})
			}

			// Run PreToolUse hook after approval but before execution
			try {
				const { ToolHookUtils } = await import("../utils/ToolHookUtils")
				await ToolHookUtils.runPreToolUseIfEnabled(config, block)
			} catch (error) {
				const { PreToolUseHookCancellationError } = await import("@core/hooks/PreToolUseHookCancellationError")
				if (error instanceof PreToolUseHookCancellationError) {
					await config.services.diffViewProvider.revertChanges()
					return formatResponse.toolDenied()
				}
				throw error
			}

			// Mark the file as edited by Dirac
			config.services.fileContextTracker.markFileAsEditedByDirac(relPath)

			// Save the changes and get the result
			let saveResult: { newProblemsMessage?: string; userEdits?: string; autoFormattingEdits?: string; finalContent?: string }
			if (shouldAutoApprove && config.backgroundEditEnabled) {
				saveResult = await config.services.diffViewProvider.applyAndSaveSilently(absolutePath, newContent)
			} else {
				// if isEditingFile false, that means we have the full contents of the file already.
				// it's important to note how this function works, you can't make the assumption that the block.partial conditional will always be called since it may immediately get complete, non-partial data. So this part of the logic will always be called.
				// in other words, you must always repeat the block.partial logic here
				if (!config.services.diffViewProvider.isEditing) {
					// show gui message before showing edit animation
					const partialMessage = JSON.stringify(sharedMessageProps)
					await config.callbacks.ask("tool", partialMessage, true).catch(() => {}) // sending true for partial even though it's not a partial, this shows the edit row before the content is streamed into the editor
					await config.services.diffViewProvider.open(relPath)
				}
				await config.services.diffViewProvider.update(newContent, true)
				await setTimeoutPromise(300) // wait for diff view to update
				await config.services.diffViewProvider.scrollToFirstDiff()

				saveResult = await config.services.diffViewProvider.saveChanges()
			}
			const { newProblemsMessage, userEdits, autoFormattingEdits, finalContent } = saveResult

			// Reset consecutive mistake counter on successful file operation
			config.taskState.consecutiveMistakeCount = 0

			config.taskState.didEditFile = true // used to determine if we should wait for busy terminal to update before sending api request

			// Track file edit operation
			await config.services.fileContextTracker.trackFileContext(relPath, "dirac_edited")

			// Reset the diff view
			await config.services.diffViewProvider.reset()

			// Handle user edits if any
			if (userEdits) {
				await config.services.fileContextTracker.trackFileContext(relPath, "user_edited")
				await config.callbacks.say(
					"user_feedback_diff",
					JSON.stringify({
						tool: fileExists ? "editedExistingFile" : "newFileCreated",
						path: relPath,
						diff: userEdits,
					}),
				)

				// Capture human edit telemetry: diff between agent's proposed content and user's pre-save edits
				// Use applyPatch to reconstruct pre-save content from userEdits, excluding auto-formatting noise
				const preSaveContent = applyPatch(newContent, userEdits)
				captureAccepted({
					ulid: config.ulid,
					tool: block.name,
					source: "human",
					beforeContent: newContent,
					afterContent: preSaveContent || finalContent || "",
					providerId,
					modelId,
				})

				return formatResponse.fileEditWithUserChanges(relPath, userEdits, autoFormattingEdits, newProblemsMessage)
			}
			return formatResponse.fileEditWithoutUserChanges(relPath, autoFormattingEdits, newProblemsMessage)
		} catch (error) {
			// Reset diff view on error
			await config.services.diffViewProvider.revertChanges()
			throw error
		}
	}

	/**
	 * Shared validation and preparation logic used by both handlePartialBlock and execute methods.
	 * This validates file access permissions, checks if the file exists, and constructs the new content
	 * from direct content. It handles both creation of new files and modifications
	 * to existing ones.
	 *
	 * @param config The task configuration containing services and state
	 * @param block The tool use block containing the operation parameters
	 * @param relPath The relative path to the target file
	 * @param _diff Ignored (legacy parameter)
	 * @param content Optional direct content for write operations
	 * @returns Object containing validated path, file existence status, content, and constructed new content,
	 *          or an object with an error message if validation fails
	 */
	async validateAndPrepareFileOperation(
		config: TaskConfig,
		block: ToolUse,
		relPath: string,
		_diff?: string,
		content?: string,
	): Promise<
		| {
				relPath: string
				absolutePath: string
				fileExists: boolean
				content: string | undefined
				newContent: string
				workspaceContext: any
		  }
		| { error: string }
	> {
		// Parse workspace hint and resolve path for multi-workspace support
		const pathResult = resolveWorkspacePath(config, relPath, "WriteToFileToolHandler.validateAndPrepareFileOperation")
		const { absolutePath, resolvedPath } =
			typeof pathResult === "string"
				? { absolutePath: pathResult, resolvedPath: relPath }
				: { absolutePath: pathResult.absolutePath, resolvedPath: pathResult.resolvedPath }

		// Determine workspace context for telemetry
		const fallbackAbsolutePath = path.resolve(config.cwd, relPath)
		const workspaceContext = {
			isMultiRootEnabled: config.isMultiRootEnabled || false,
			usedWorkspaceHint: typeof pathResult !== "string", // multi-root path result indicates hint usage
			resolvedToNonPrimary: !arePathsEqual(absolutePath, fallbackAbsolutePath),
			resolutionMethod: (typeof pathResult !== "string" ? "hint" : "primary_fallback") as "hint" | "primary_fallback",
		}

		// Check diracignore access first
		const accessValidation = this.validator.checkDiracIgnorePath(resolvedPath)
		if (!accessValidation.ok) {
			// Show error to user
			await config.callbacks.say("diracignore_error", resolvedPath)

			const errorResponse = formatResponse.toolError(formatResponse.diracIgnoreError(resolvedPath))

			if (!config.enableParallelToolCalling) {
				config.taskState.didAlreadyUseTool = true
			}

			return { error: errorResponse }
		}

		// Check if file exists to determine the correct UI message
		let fileExists: boolean
		if (config.services.diffViewProvider.editType !== undefined) {
			fileExists = config.services.diffViewProvider.editType === "modify"
		} else {
			const validation = await this.validateFileAccess(config, block, relPath, absolutePath)
			if (!validation.ok) {
				return { error: validation.errorResponse || "Unknown validation error" }
			}
			fileExists = validation.fileExists
		}

		let newContent: string
		if (content) {
			// Strip any line hashes that might have been included by the model
			content = stripHashes(content)

			// Handle write_to_file with direct content
			newContent = content

			// pre-processing newContent for cases where weaker models might add artifacts like markdown codeblock markers (deepseek/llama) or extra escape characters (gemini)
			if (newContent.startsWith("```")) {
				// this handles cases where it includes language specifiers like ```python ```js
				newContent = newContent.split("\n").slice(1).join("\n").trim()
			}
			if (newContent.endsWith("```")) {
				newContent = newContent.split("\n").slice(0, -1).join("\n").trim()
			}

			// Apply model-specific fixes (llama, gemini, and other models may add escape characters)
			newContent = applyModelContentFixes(newContent, config.api.getModel().id, resolvedPath)
		} else {
			// can't happen, since we already checked for content/diff above. but need to do this for type error
			return { error: "Missing content for file operation" }
		}

		return { relPath, absolutePath, fileExists, content, newContent, workspaceContext }
	}
	private async validateFileAccess(
		config: TaskConfig,
		block: ToolUse,
		relPath: string,
		absolutePath: string,
	): Promise<{ fileExists: boolean; ok: boolean; errorResponse?: string }> {
		try {
			const stats = await fs.stat(absolutePath)
			if (stats.isDirectory()) {
				const errorResponse = formatResponse.toolError(`Cannot write to '${relPath}' because it is a directory.`)
				await config.callbacks.say("error", `Dirac tried to write to '${relPath}', but it is a directory.`)
				return { fileExists: true, ok: false, errorResponse }
			}

			// If it's a file, check if we have write permission
			try {
				await fs.access(absolutePath, fs.constants.W_OK)
			} catch (error: any) {
				if (error.code === "EACCES") {
					const errorResponse = formatResponse.toolError(formatResponse.filePermissionError(relPath, "write to"))
					await config.callbacks.say("error", `Dirac tried to write to '${relPath}', but permission was denied.`)
					return { fileExists: true, ok: false, errorResponse }
				}
 else if (error.code === "EROFS") {
					const errorResponse = formatResponse.toolError(formatResponse.readOnlyError(relPath))
					await config.callbacks.say("error", `Dirac tried to write to '${relPath}', but the file system is read-only.`)
					return { fileExists: true, ok: false, errorResponse }
				}
				// Ignore other access errors here, they will be caught by the outer try/catch if they are critical
			}

			config.services.diffViewProvider.editType = "modify"
			return { fileExists: true, ok: true }
		} catch (error: any) {
			if (error.code === "ENOENT") {
				config.services.diffViewProvider.editType = "create"
				return { fileExists: false, ok: true }
			} else if (error.code === "ENOTDIR") {
				const errorResponse = formatResponse.toolError(formatResponse.pathConflictError(relPath))
				await config.callbacks.say("error", `Dirac tried to write to '${relPath}', but a parent component is not a directory.`)
				return { fileExists: false, ok: false, errorResponse }
			} else if (error.code === "EACCES") {
				const errorResponse = formatResponse.toolError(formatResponse.filePermissionError(relPath, "access"))
				await config.callbacks.say("error", `Dirac tried to access '${relPath}', but permission was denied.`)
				return { fileExists: false, ok: false, errorResponse }
			} else if (error.code === "EROFS") {
				const errorResponse = formatResponse.toolError(formatResponse.readOnlyError(relPath))
				await config.callbacks.say("error", `Dirac tried to write to '${relPath}', but the file system is read-only.`)
				return { fileExists: false, ok: false, errorResponse }
			} else {
				throw error
			}
		}
	}

}
