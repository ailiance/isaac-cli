import { setTimeout as setTimeoutPromise } from "node:timers/promises"
import { ToolUse } from "@core/assistant-message"
import { formatResponse } from "@core/prompts/responses"
import { resolveWorkspacePath } from "@core/workspace"
import type { DiffStructure } from "@shared/utils/diff"
import { computeDiff } from "@shared/utils/diff"
import { AnchorStateManager } from "@utils/AnchorStateManager"
import { contentHash } from "@utils/line-hashing"
import { isLocatedInWorkspace } from "@utils/path"
import * as fs from "fs/promises"
import * as path from "path"
import { HostProvider } from "@/hosts/host-provider"
import { getDiagnosticsProviders } from "@/integrations/diagnostics/getDiagnosticsProviders"
import { IsaacSayTool } from "@/shared/ExtensionMessage"
import { IsaacDefaultTool } from "@/shared/tools"
import { IsaacAskResponse } from "@/shared/WebviewMessage"
import { ToolResponse } from "../../../index"
import { showNotificationForApproval } from "../../../utils"
import { ToolValidator } from "../../ToolValidator"
import { TaskConfig } from "../../types/TaskConfig"
import { extractLastKnownHashFromHistory } from "../../utils/extractLastKnownHash"
import { ToolResultUtils } from "../../utils/ToolResultUtils"
import { EditExecutor } from "./EditExecutor"
import { EditFormatter } from "./EditFormatter"
import { FailedEdit, FileEdit, FuzzyCandidate, PreparedEdits, PreparedFileBatch, ResolvedEdit } from "./types"

export class BatchProcessor {
	constructor(
		private validator: ToolValidator,
		private executor: EditExecutor,
		private formatter: EditFormatter,
		private useLinterOnlyForSyntax: boolean,
		private diagnosticsTimeoutMs: number,
		private diagnosticsDelayMs: number,
		private diffMode: "full" | "additions-only",
	) {}

	resolvePath(config: TaskConfig, relPath: string): { absolutePath: string; displayPath: string } {
		const pathResult = resolveWorkspacePath(config, relPath, "EditFileToolHandler.resolvePath")
		return typeof pathResult === "string" ? { absolutePath: pathResult, displayPath: relPath } : pathResult
	}

	groupBlocksByPath(config: TaskConfig): Map<string, PreparedFileBatch> {
		const allBlocks = config.taskState.assistantMessageContent.filter(
			(b: any): b is ToolUse => b.type === "tool_use" && b.name === IsaacDefaultTool.EDIT_FILE,
		)

		const groups = new Map<string, PreparedFileBatch>()

		for (const b of allBlocks) {
			const fileEdits: FileEdit[] = []

			let files = b.params.files
			let wasStringified = false
			if (typeof files === "string") {
				try {
					files = JSON.parse(files)
					b.params.files = files
					wasStringified = true
				} catch (e) {}
			}

			if (Array.isArray(files)) {
				fileEdits.push(...files)
			}

			for (const fe of fileEdits) {
				let editsWasStringified = false
				if (typeof fe.edits === "string") {
					try {
						fe.edits = JSON.parse(fe.edits)
						editsWasStringified = true
					} catch (e) {}
				}

				const { absolutePath, displayPath } = this.resolvePath(config, fe.path)
				if (!groups.has(absolutePath)) {
					groups.set(absolutePath, {
						absolutePath,
						displayPath,
						blocks: [],
						wasStringified: wasStringified || editsWasStringified,
					})
				} else if (wasStringified || editsWasStringified) {
					groups.get(absolutePath)!.wasStringified = true
				}

				groups.get(absolutePath)!.blocks.push({
					...b,
					params: { ...b.params, path: fe.path, edits: fe.edits },
				} as any)
			}
		}
		return groups
	}

	async executeMultiFileBatch(
		config: TaskConfig,
		allBatches: Map<string, PreparedFileBatch>,
	): Promise<Map<string, ToolResponse>> {
		const results = new Map<string, ToolResponse>()
		const preparedBatches: PreparedFileBatch[] = []

		for (const batch of allBatches.values()) {
			const { error, prepared } = await this.validateAndPrepare(config, batch.absolutePath, batch.displayPath, batch.blocks)
			if (error) {
				results.set(batch.absolutePath, error)
			} else if (prepared) {
				// Apply all edits in memory for this batch
				const { finalLines, appliedEdits } = this.executor.applyEdits(prepared.lines, prepared.resolvedEdits)
				prepared.finalLines = finalLines
				prepared.finalContent = finalLines.join("\n")
				prepared.appliedEdits = appliedEdits

				// Generate diff for the summary
				let diff = `*** Update File: ${batch.displayPath}\n\n`

				const sortedEdits = [...appliedEdits].sort((a, b) => a.originalStartIdx - b.originalStartIdx)

				for (const applied of sortedEdits) {
					const editType = applied.edit.edit_type
					let searchLines: string[] = []
					let replaceLines: string[] = []

					const replaceTextLines = applied.edit.text === "" ? [] : applied.edit.text.split("\n")

					if (editType === "insert_after") {
						searchLines = [prepared.lines[applied.originalStartIdx]]
						replaceLines = [prepared.lines[applied.originalStartIdx], ...replaceTextLines]
					} else if (editType === "insert_before") {
						searchLines = [prepared.lines[applied.originalStartIdx]]
						replaceLines = [...replaceTextLines, prepared.lines[applied.originalStartIdx]]
					} else {
						searchLines = prepared.lines.slice(applied.originalStartIdx, applied.originalEndIdx + 1)
						replaceLines = replaceTextLines
					}

					const contextBeforeStart = Math.max(0, applied.originalStartIdx - 2)
					const contextBefore = prepared.lines.slice(contextBeforeStart, applied.originalStartIdx)

					let afterStartIdx = applied.originalEndIdx + 1
					if (editType === "insert_after" || editType === "insert_before") {
						afterStartIdx = applied.originalStartIdx + 1
					}
					const contextAfterEnd = Math.min(prepared.lines.length, afterStartIdx + 2)
					const contextAfter = prepared.lines.slice(afterStartIdx, contextAfterEnd)

					const searchContent = [...contextBefore, ...searchLines, ...contextAfter].join("\n")
					const replaceContent = [...contextBefore, ...replaceLines, ...contextAfter].join("\n")

					const startLineNumber = contextBeforeStart + 1

					diff += `<<<<<<< SEARCH:${startLineNumber}\n${searchContent}\n=======\n${replaceContent}\n>>>>>>> REPLACE\n\n`
				}
				prepared.diff = diff

				preparedBatches.push({ ...batch, prepared })
			}
		}

		if (preparedBatches.length === 0) {
			return results
		}
		const providers = getDiagnosticsProviders(this.useLinterOnlyForSyntax, this.diagnosticsTimeoutMs, this.diagnosticsDelayMs)

		// 1. Capture pre-save diagnostics for all files once
		const preDiagnostics = (await Promise.all(providers.map((p) => p.capturePreSaveState()))).flat()

		const allAutoApproved = await this.checkAutoApproval(config, preparedBatches)

		if (allAutoApproved && config.backgroundEditEnabled) {
			// FAST PATH: All files auto-approved, apply them all silently
			const appliedResults = new Map<string, any>()
			let anyFailed = false
			let anySucceeded = false

			for (const batch of preparedBatches) {
				try {
					const applied = await this.applyAndSave(config, batch, { silent: true })
					appliedResults.set(batch.absolutePath, applied)
					anySucceeded = true
				} catch (error) {
					anyFailed = true
					const errorMessage = error instanceof Error ? error.message : String(error)
					results.set(
						batch.absolutePath,
						formatResponse.toolError(`Error applying edits to ${batch.displayPath}: ${errorMessage}`),
					)
				} finally {
					await config.services.diffViewProvider.reset().catch(() => {})
				}
			}

			if (anyFailed) {
				config.taskState.consecutiveMistakeCount++
			} else if (anySucceeded) {
				config.taskState.consecutiveMistakeCount = 0
			}

			// Run diagnostics and format results
			await this.processDiagnosticsAndFormatResults(
				config,
				preparedBatches,
				appliedResults,
				providers,
				preDiagnostics,
				results,
			)

			await config.callbacks.removeLastPartialMessageIfExistsWithType("say", "tool")
			await config.callbacks.removeLastPartialMessageIfExistsWithType("ask", "tool")

			const successfulBatches = preparedBatches.filter((b) => appliedResults.has(b.absolutePath))
			const finalMessage = await this.buildEditMessage(config, successfulBatches)
			await config.callbacks.say("tool", JSON.stringify(finalMessage), undefined, undefined, false)

			return results
		}

		// ITERATIVE PATH: At least one file needs approval
		let forceAutoApproveRemaining = false
		const appliedResults = new Map<string, any>()
		let anyFailed = false
		let anySucceeded = false

		try {
			for (const batch of preparedBatches) {
				const shouldAutoApprove = forceAutoApproveRemaining || (await this.checkAutoApproval(config, [batch]))

				if (!shouldAutoApprove) {
					await config.callbacks.removeLastPartialMessageIfExistsWithType("say", "tool")
					await config.callbacks.removeLastPartialMessageIfExistsWithType("ask", "tool", false)

					// Show the diff for this specific file
					await config.services.diffViewProvider.showReview([
						{
							absolutePath: batch.absolutePath,
							displayPath: batch.displayPath,
							content: batch.prepared!.finalContent,
						},
					])

					const intermediateMessage = await this.buildEditMessage(config, [batch])
					await config.callbacks.say("tool", JSON.stringify(intermediateMessage), undefined, undefined, true)

					const approvalResult = await this.requestCombinedApproval(config, [batch])
					const { didApprove, response, text, userEdits } = approvalResult

					if (!didApprove && response !== "messageResponse") {
						await config.services.diffViewProvider.hideReview()
					}

					if (response === "yesButtonClicked" && config.services.stateManager.getGlobalSettingsKey("yoloModeToggled")) {
						forceAutoApproveRemaining = true
					}

					if (response === "messageResponse") {
						results.set(batch.absolutePath, formatResponse.toolDeniedWithFeedback(text || ""))
						continue
					}

					if (!didApprove) {
						results.set(batch.absolutePath, formatResponse.toolDenied())

						// Fill remaining files with skipped message
						const currentIndex = preparedBatches.indexOf(batch)
						for (let i = currentIndex + 1; i < preparedBatches.length; i++) {
							const rb = preparedBatches[i]
							results.set(rb.absolutePath, "Skipped due to rejection of a previous file in the same batch.")
						}
						break
					}

					if (userEdits && userEdits[batch.displayPath] !== undefined) {
						batch.prepared!.finalContent = userEdits[batch.displayPath]
						batch.prepared!.finalLines = batch.prepared!.finalContent.split(/\r?\n/)
					}

					if (didApprove) {
						// Don't call hideReview here if we are about to apply and save,
						// as it clears the CodeLenses and closes the editor we need.
						// hideReview() will be called implicitly by reset() in the finally block or after the loop.
					}
				}

				// Apply and save this file
				try {
					const applied = await this.applyAndSave(config, batch, {
						silent: shouldAutoApprove && config.backgroundEditEnabled,
					})
					appliedResults.set(batch.absolutePath, applied)
					anySucceeded = true
				} catch (error) {
					anyFailed = true
					const errorMessage = error instanceof Error ? error.message : String(error)
					results.set(
						batch.absolutePath,
						formatResponse.toolError(`Error applying edits to ${batch.displayPath}: ${errorMessage}`),
					)
				} finally {
					await config.services.diffViewProvider.reset().catch(() => {})
				}
			}
		} finally {
			await config.callbacks.removeLastPartialMessageIfExistsWithType("say", "tool")
			await config.callbacks.removeLastPartialMessageIfExistsWithType("ask", "tool", false)
		}

		if (anyFailed) {
			config.taskState.consecutiveMistakeCount++
		} else if (anySucceeded) {
			config.taskState.consecutiveMistakeCount = 0
		}

		// Run diagnostics and format results for all successfully applied files
		await this.processDiagnosticsAndFormatResults(config, preparedBatches, appliedResults, providers, preDiagnostics, results)

		const successfulBatches = preparedBatches.filter((b) => appliedResults.has(b.absolutePath))
		const finalMessage = await this.buildEditMessage(config, successfulBatches)
		await config.callbacks.say("tool", JSON.stringify(finalMessage), undefined, undefined, false)

		return results
	}

	private async processDiagnosticsAndFormatResults(
		config: TaskConfig,
		preparedBatches: PreparedFileBatch[],
		appliedResults: Map<string, any>,
		providers: any[],
		preDiagnostics: any[],
		results: Map<string, ToolResponse>,
	): Promise<void> {
		const successfulBatches = preparedBatches.filter((b) => appliedResults.has(b.absolutePath))
		if (successfulBatches.length === 0) return

		const diagnosticsData = successfulBatches.map((b) => {
			const applied = appliedResults.get(b.absolutePath)!
			return {
				filePath: b.absolutePath,
				content: applied.finalContent,
				hashes: applied.newLineHashes,
			}
		})

		const providerDiagnostics = await Promise.all(
			providers.map((p) => p.getDiagnosticsFeedbackForFiles(diagnosticsData, preDiagnostics)),
		)

		for (let i = 0; i < successfulBatches.length; i++) {
			const batch = successfulBatches[i]
			const applied = appliedResults.get(batch.absolutePath)!
			const finalDiagnosticsResult = { newProblemsMessage: "", fixedCount: 0 }

			for (const resultsOfProvider of providerDiagnostics) {
				const res = resultsOfProvider[i]
				if (res.newProblemsMessage && !finalDiagnosticsResult.newProblemsMessage) {
					finalDiagnosticsResult.newProblemsMessage = res.newProblemsMessage
				}
				finalDiagnosticsResult.fixedCount += res.fixedCount
			}

			batch.diagnostics = finalDiagnosticsResult

			const result = this.formatter.createResultsResponse(
				batch.prepared!,
				applied.finalLines,
				applied.newLineHashes,
				finalDiagnosticsResult,
				this.diffMode,
				applied.saveResult.autoFormattingEdits,
				applied.saveResult.userEdits,
				batch.wasStringified,
			)
			results.set(batch.absolutePath, result)
		}
	}

	async validateAndPrepare(
		config: TaskConfig,
		absolutePath: string,
		displayPath: string,
		blocks: ToolUse[],
	): Promise<{ error?: ToolResponse; prepared?: PreparedEdits }> {
		for (const block of blocks) {
			if (block.params.path === undefined || block.params.edits === undefined) {
				let files = block.params.files
				if (typeof files === "string") {
					try {
						files = JSON.parse(files)
					} catch (e) {}
				}
				if (!Array.isArray(files)) {
					config.taskState.consecutiveMistakeCount++
					return {
						error: formatResponse.toolError(
							"The 'files' parameter must be a valid JSON array of objects. If you provided a string, ensure it is valid JSON.",
						),
					}
				}
			}

			const edits = block.params.edits
			if (!Array.isArray(edits)) {
				config.taskState.consecutiveMistakeCount++
				return {
					error: formatResponse.toolError(
						"The 'edits' parameter must be a valid JSON array of objects. If you provided a string, ensure it is valid JSON.",
					),
				}
			}

			for (const edit of edits) {
				const editType = edit.edit_type
				const hasEndAnchor = !!edit.end_anchor
				const isReplace = editType === "replace" || !editType // default is replace

				if (!editType || !edit.anchor || (isReplace && !hasEndAnchor) || edit.text === undefined) {
					config.taskState.consecutiveMistakeCount++
					const missingField = !editType
						? "edit_type"
						: !edit.anchor
							? "anchor"
							: isReplace && !hasEndAnchor
								? "end_anchor"
								: "text"
					return { error: formatResponse.toolError(`Each edit must contain '${missingField}'.`) }
				}
			}
		}

		const preparedResult = await this.prepareEdits(config, absolutePath, displayPath, blocks)
		if ("error" in preparedResult) {
			return { error: preparedResult.error }
		}

		return { prepared: preparedResult }
	}

	async checkAutoApproval(config: TaskConfig, batches: PreparedFileBatch[]): Promise<boolean> {
		if (config.isSubagentExecution) return true
		for (const batch of batches) {
			const allowed = await config.callbacks.shouldAutoApproveToolWithPath(IsaacDefaultTool.EDIT_FILE, batch.displayPath)
			if (!allowed) return false
		}
		return true
	}

	async requestCombinedApproval(
		config: TaskConfig,
		batches: PreparedFileBatch[],
	): Promise<{ didApprove: boolean; response: IsaacAskResponse; text?: string; userEdits?: Record<string, string> }> {
		const totalRequestedEdits = batches.reduce(
			(acc, b) =>
				acc + b.blocks.reduce((acc2, b2) => acc2 + (Array.isArray(b2.params.edits) ? b2.params.edits.length : 0), 0),
			0,
		)

		const fileNames = batches.map((b) => path.basename(b.absolutePath)).join(", ")
		const notificationMessage =
			batches.length === 1
				? `Isaac wants to edit ${batches[0].displayPath} with ${totalRequestedEdits} anchored edits`
				: `Isaac wants to edit ${fileNames} with ${totalRequestedEdits} anchored edits`
		showNotificationForApproval(notificationMessage, config.autoApprovalSettings.enableNotifications)

		while (true) {
			const completeMessage = await this.buildEditMessage(config, batches)
			await config.callbacks.removeLastPartialMessageIfExistsWithType("say", "tool")
			await config.callbacks.removeLastPartialMessageIfExistsWithType("ask", "tool", false)

			const result = await ToolResultUtils.askApprovalAndPushFeedback("tool", JSON.stringify(completeMessage), config)
			const { response, userEdits } = result

			if (response === "editButtonClicked") {
				// Re-trigger showReview to ensure editors are open
				await config.services.diffViewProvider.showReview(
					batches.map((b) => ({
						absolutePath: b.absolutePath,
						displayPath: b.displayPath,
						content: b.prepared!.finalContent,
					})),
				)
				await config.services.diffViewProvider.scrollToFirstDiff()
				continue
			}

			if (response === "viewButtonClicked") {
				// Re-trigger showReview and scroll to first diff
				await config.services.diffViewProvider.showReview(
					batches.map((b) => ({
						absolutePath: b.absolutePath,
						displayPath: b.displayPath,
						content: b.prepared!.finalContent,
					})),
				)
				await config.services.diffViewProvider.scrollToFirstDiff()
				for (const batch of batches) {
					await config.services.diffViewProvider.scrollToFirstDiff()
				}
				continue
			}

			if (response === "undoButtonClicked") {
				await config.services.diffViewProvider.undoUserEdits()
				continue
			}

			return { didApprove: result.didApprove, response, text: result.text, userEdits }
		}
	}

	async buildEditMessage(config: TaskConfig, batches: PreparedFileBatch[]): Promise<IsaacSayTool> {
		const totalRequestedEdits = batches.reduce(
			(acc, b) =>
				acc + b.blocks.reduce((acc2, b2) => acc2 + (Array.isArray(b2.params.edits) ? b2.params.edits.length : 0), 0),
			0,
		)

		const warningCount = batches.reduce((acc, b) => acc + (b.prepared?.failedEdits.length || 0), 0)
		const warning = warningCount > 0 ? `\n\nWarning: ${warningCount} edit(s) failed to resolve and will be skipped.` : ""
		const diffs = batches.map((b) => b.prepared?.diff).join("\n\n")

		const editSummaries = await Promise.all(
			batches.map(async (b) => {
				const diffText = b.prepared?.diff
				let hunks: DiffStructure | undefined
				if (diffText && diffText.length <= 500_000) {
					const computed = computeDiff(diffText)
					hunks = {
						path: b.displayPath,
						totalAdditions: computed.totalAdditions,
						totalDeletions: computed.totalDeletions,
						blocks: computed.blocks,
					}
				}
				return {
					path: b.displayPath,
					edits:
						b.prepared?.appliedEdits.map((ae) => ({
							additions: ae.linesAdded,
							deletions: ae.linesDeleted,
						})) || [],
					diagnostics: b.diagnostics,
					diff: diffText,
					finalContent: b.prepared?.finalContent,
					hunks,
				}
			}),
		)

		const operationIsLocatedInWorkspace =
			batches.length === 1
				? await isLocatedInWorkspace(batches[0].absolutePath)
				: (await Promise.all(batches.map((b) => isLocatedInWorkspace(b.absolutePath)))).every(Boolean)

		return {
			tool: "editFile",
			path: batches.length === 1 ? batches[0].displayPath : "Multiple files",
			filesCount: batches.length,
			editsCount: totalRequestedEdits,
			diff: diffs + warning,
			editSummaries,
			operationIsLocatedInWorkspace,
			hint: "Review and edit in the editor before approving.",
		}
	}

	async applyAndSave(
		config: TaskConfig,
		batch: PreparedFileBatch,
		options: { silent: boolean },
	): Promise<{
		saveResult: { finalContent: string; autoFormattingEdits?: string; userEdits?: string }
		finalContent: string
		finalLines: string[]
		newLineHashes: string[]
	}> {
		const { absolutePath, displayPath, prepared } = batch
		if (!prepared) throw new Error("Failed to prepare edits.")

		let { finalContent, finalLines } = prepared

		if (options.silent) {
			const saveResult = await config.services.diffViewProvider.applyAndSaveSilently(absolutePath, finalContent)
			const actualFinalContent = saveResult.finalContent || finalContent

			if (actualFinalContent !== finalContent) {
				finalContent = actualFinalContent
				finalLines = finalContent.split(/\r?\n/)
			}

			config.taskState.consecutiveMistakeCount = 0
			config.taskState.didEditFile = true
			config.services.fileContextTracker.markFileAsEditedByIsaac(displayPath)
			await config.services.fileContextTracker.trackFileContext(displayPath, "dirac_edited")

			const newLineHashes = AnchorStateManager.reconcile(absolutePath, finalLines, config.ulid)

			return {
				saveResult: {
					finalContent: actualFinalContent,
					autoFormattingEdits: saveResult.autoFormattingEdits,
					userEdits: saveResult.userEdits,
				},
				finalContent,
				finalLines,
				newLineHashes,
			}
		}

		config.services.diffViewProvider.editType = "modify"
		// Stage the changes in the diff view provider before saving
		if (!config.services.diffViewProvider.isEditing) {
			await config.services.diffViewProvider.open(absolutePath, { displayPath })
		}
		await config.services.diffViewProvider.update(finalContent, true)

		// Wait for the diff view to update before saving to ensure auto-formatting is triggered
		await setTimeoutPromise(200)

		// Save the changes and get the final content (including any auto-formatting)
		// Save the changes and get the final content (including any auto-formatting)
		// We skip diagnostics here because executeMultiFileBatch handles them in parallel for the whole batch
		const saveResult = await this.saveAndTrackChanges(config, absolutePath, displayPath, finalContent, {
			skipDiagnostics: true,
		})

		// Update finalContent and finalLines if they changed during save (e.g. auto-formatting)
		if (saveResult.finalContent !== finalContent) {
			finalContent = saveResult.finalContent
			finalLines = finalContent.split(/\r?\n/)
		}

		const newLineHashes = AnchorStateManager.reconcile(absolutePath, finalLines, config.ulid)

		return { saveResult, finalContent, finalLines, newLineHashes }
	}

	/**
	 * Stale anchor detection.
	 *
	 * Compares the current on-disk hash against the last `[File Hash: ...]`
	 * the model saw via `read_file`. When they differ, the file mutated
	 * between the read and this edit (manual edit, hook, sibling agent, …).
	 * Anchors resolved against the previous content can collide with similar
	 * lines elsewhere or silently miss, so we abort with a re-read prompt
	 * rather than apply edits to outdated context.
	 *
	 * Behaviour A (strict): refuse and ask for a re-read. Behaviour B
	 * (auto-refresh by recomputing line hashes) is intentionally NOT
	 * implemented — semantic drift would let the model edit a wrong region.
	 *
	 * Backward compat: when no `lastKnownHash` is recorded for this path
	 * (legacy history, never-read file, history slicing), the check is
	 * skipped and previous behaviour is preserved.
	 *
	 * `consecutiveMistakeCount` is intentionally NOT incremented — the model
	 * did not misuse the tool, the world changed under it.
	 */
	private detectStaleAnchorContext(
		config: TaskConfig,
		absolutePath: string,
		displayPath: string,
		content: string,
	): ToolResponse | undefined {
		const history = config.messageState?.getApiConversationHistory?.() || []
		if (!history.length) {
			return undefined
		}
		const lastKnownHash = extractLastKnownHashFromHistory(history, displayPath)
		if (!lastKnownHash) {
			// No prior read recorded — preserve legacy behaviour.
			return undefined
		}
		const currentHash = contentHash(content)
		if (currentHash === lastKnownHash) {
			return undefined
		}
		const message =
			`File ${displayPath} has changed since the last read.\n` +
			`Previously known hash: ${lastKnownHash}\n` +
			`Current hash:          ${currentHash}\n` +
			`Edit aborted to prevent applying anchors to outdated content.\n` +
			`Suggested action: re-read the file with read_file path="${displayPath}" and re-issue the edit.`
		return formatResponse.toolError(message)
	}

	async prepareEdits(
		config: TaskConfig,
		absolutePath: string,
		displayPath: string,
		blocks: ToolUse[],
	): Promise<PreparedEdits | { error: ToolResponse }> {
		try {
			await HostProvider.workspace.saveOpenDocumentIfDirty({ filePath: absolutePath })
			const content = await fs.readFile(absolutePath, "utf8")

			// Stale anchor detection. If the file has changed since the model's
			// last `read_file`, abort before resolving anchors against an
			// outdated mental model. Backward compat: if no prior read is
			// recorded (legacy histories, fresh session, never-read file),
			// skip the check.
			const staleError = this.detectStaleAnchorContext(config, absolutePath, displayPath, content)
			if (staleError) {
				return { error: staleError }
			}

			const lines = content.split(/\r?\n/)
			const lineHashes = AnchorStateManager.reconcile(absolutePath, lines, config.ulid)

			const { resolvedEdits, failedEdits } = this.executor.resolveEdits(blocks, lines, lineHashes)

			// Fuzzy fallback: for each failed edit that has a high-confidence
			// Levenshtein candidate, request user approval. On approval, promote
			// to resolved; on refusal, keep as failed (per-anchor granularity,
			// never penalises sibling edits).
			const { promotedEdits, remainingFailedEdits } = await this.requestFuzzyApprovals(
				config,
				displayPath,
				failedEdits,
				lineHashes.map((h) => h.trim()),
				lines,
			)
			resolvedEdits.push(...promotedEdits)

			if (resolvedEdits.length === 0) {
				const failureMessages = remainingFailedEdits.map((f) => this.executor.formatFailureMessage(f.edit, f.error))
				return { error: formatResponse.toolError(failureMessages.join("\n\n")) }
			}

			return {
				content,
				finalContent: content, // Placeholder
				diff: "", // Placeholder
				resolvedEdits,
				failedEdits: remainingFailedEdits,
				appliedEdits: [], // Placeholder
				lines,
				lineHashes,
				finalLines: lines, // Placeholder
				displayPath,
			}
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error)
			return { error: formatResponse.toolError(`Error preparing edits: ${errorMessage}`) }
		}
	}

	/**
	 * Fuzzy fallback approval loop.
	 *
	 * For each FailedEdit carrying a high-confidence Levenshtein candidate
	 * (`fuzzyCandidates` populated by EditExecutor), prompt the user once per
	 * candidate. On approval, re-resolve the edit with the candidate's
	 * actualLineIdx pinned and add to `promotedEdits`. On refusal, leave the
	 * edit in `remainingFailedEdits` with its original diagnostic.
	 *
	 * Granularity is per-anchor: refusing a fuzzy match only skips that one
	 * edit, never affects sibling edits in the same batch.
	 */
	private async requestFuzzyApprovals(
		config: TaskConfig,
		displayPath: string,
		failedEdits: FailedEdit[],
		normalizedLineHashes: string[],
		lines: string[],
	): Promise<{ promotedEdits: ResolvedEdit[]; remainingFailedEdits: FailedEdit[] }> {
		const promotedEdits: ResolvedEdit[] = []
		const remainingFailedEdits: FailedEdit[] = []

		for (const failed of failedEdits) {
			const candidates = failed.fuzzyCandidates
			if (!candidates || candidates.length === 0) {
				remainingFailedEdits.push(failed)
				continue
			}

			// Ask once per fuzzy side. If any side is refused, the whole edit
			// stays failed (we can't apply with a half-approved range).
			const approvedCandidates = new Map<"anchor" | "end_anchor", FuzzyCandidate>()
			let anyRefused = false
			for (const candidate of candidates) {
				const approved = await this.askFuzzyApproval(config, displayPath, candidate)
				if (approved) {
					approvedCandidates.set(candidate.type, candidate)
				} else {
					anyRefused = true
					break
				}
			}

			if (anyRefused) {
				remainingFailedEdits.push(failed)
				continue
			}

			const promoted = this.executor.resolveFuzzyEdit(failed, approvedCandidates, normalizedLineHashes, lines)
			if (promoted) {
				promotedEdits.push(promoted)
			} else {
				// Fuzzy approval succeeded but the edit still has unrelated
				// diagnostics (range error, etc.) — keep the original failure.
				remainingFailedEdits.push(failed)
			}
		}

		return { promotedEdits, remainingFailedEdits }
	}

	/**
	 * Issue a single per-anchor fuzzy-match approval prompt. Returns true iff
	 * the user clicked the equivalent of "yes". Auto-approved when the
	 * workspace already auto-approves edits for this path (no double prompt).
	 */
	private async askFuzzyApproval(config: TaskConfig, displayPath: string, candidate: FuzzyCandidate): Promise<boolean> {
		// Subagent / fully auto-approved workspace: skip the prompt.
		if (config.isSubagentExecution) return true
		const autoApproved = await config.callbacks.shouldAutoApproveToolWithPath(IsaacDefaultTool.EDIT_FILE, displayPath)
		if (autoApproved) return true

		const message = {
			tool: "editFile",
			path: displayPath,
			fuzzyMatch: {
				anchor: candidate.anchorName,
				anchorType: candidate.type,
				provided: candidate.provided,
				actualLine: candidate.actualLineIdx + 1,
				actualContent: candidate.actualContent,
				similarity: Number(candidate.similarity.toFixed(2)),
			},
			hint: `Anchor "${candidate.anchorName}" did not match exactly. Apply on the similar line?`,
		}
		const { response } = await config.callbacks.ask("tool", JSON.stringify(message), false)
		return response === "yesButtonClicked"
	}

	async saveAndTrackChanges(
		config: TaskConfig,
		absolutePath: string,
		displayPath: string,
		finalContent: string,
		options?: { skipDiagnostics?: boolean },
	): Promise<{ finalContent: string; autoFormattingEdits?: string; userEdits?: string }> {
		// Use DiffViewProvider to save changes, which handles auto-formatting and VS Code document synchronization
		const saveResult = await config.services.diffViewProvider.saveChanges(options)
		const actualFinalContent = saveResult.finalContent || finalContent

		config.taskState.consecutiveMistakeCount = 0
		config.taskState.didEditFile = true
		config.services.fileContextTracker.markFileAsEditedByIsaac(displayPath)
		await config.services.fileContextTracker.trackFileContext(displayPath, "dirac_edited")

		return {
			finalContent: actualFinalContent,
			autoFormattingEdits: saveResult.autoFormattingEdits,
			userEdits: saveResult.userEdits,
		}
	}
}
