import path from "node:path"
import type { ToolUse } from "@core/assistant-message"
import { formatResponse } from "@core/prompts/responses"
import { getWorkspaceBasename, resolveWorkspacePath } from "@core/workspace"
import { type FileInfo, listFiles } from "@services/glob/list-files"
import { arePathsEqual, getReadablePath, isLocatedInWorkspace } from "@utils/path"
import { telemetryService } from "@/services/telemetry"
import { Logger } from "@/shared/services/Logger"
import { DiracDefaultTool } from "@/shared/tools"
import { notifyAsyncTool } from "../../AsyncToolNotifier"
import type { ToolResponse } from "../../index"
import type { TaskMessenger } from "../../TaskMessenger"
import { showNotificationForApproval } from "../../utils"
import type { IFullyManagedTool } from "../ToolExecutorCoordinator"
import type { ToolValidator } from "../ToolValidator"
import type { TaskConfig } from "../types/TaskConfig"
import type { StronglyTypedUIHelpers } from "../types/UIHelpers"
import { ToolResultUtils } from "../utils/ToolResultUtils"

// Sprint 2 — task E: async-by-default list_files when recursive=true.
// Mirrors S2-C / S2-D pattern. Non-recursive listing stays synchronous
// (fast path, single globby call) — no overhead.
const ASYNC_FAST_PATH_MS = 500

interface PerPathListing {
	relDirPath: string
	displayPath: string
	absolutePath: string
	usedWorkspaceHint: boolean
	fileInfos: FileInfo[]
	didHitLimit: boolean
	error?: string
}

export class ListFilesToolHandler implements IFullyManagedTool {
	private static readonly MAX_FILES_LIMIT = 200
	readonly name = DiracDefaultTool.LIST_FILES

	constructor(private validator: ToolValidator) {}

	getDescription(block: ToolUse): string {
		const relPaths = Array.isArray(block.params.paths)
			? block.params.paths
			: block.params.paths
				? [block.params.paths as string]
				: []
		return `[${block.name} for ${relPaths.map((p) => `'${p}'`).join(", ")}]`
	}

	async handlePartialBlock(block: ToolUse, uiHelpers: StronglyTypedUIHelpers): Promise<void> {
		const relPaths = Array.isArray(block.params.paths)
			? block.params.paths
			: block.params.paths
				? [block.params.paths as string]
				: []

		// Get config access for services
		const config = uiHelpers.getConfig()
		if (config.isSubagentExecution) {
			return
		}

		// Create and show partial UI message
		const recursiveRaw = block.params.recursive
		const recursive = String(recursiveRaw ?? "").toLowerCase() === "true"
		const sharedMessageProps = {
			tool: recursive ? "listFilesRecursive" : "listFilesTopLevel",
			paths: relPaths.map((p) => getReadablePath(config.cwd, uiHelpers.removeClosingTag(block, "paths", p))),
			content: "",
			operationIsLocatedInWorkspace: (await Promise.all(relPaths.map((p) => isLocatedInWorkspace(p)))).every(Boolean),
		}

		const partialMessage = JSON.stringify(sharedMessageProps)

		// Handle auto-approval vs manual approval for partial
		const shouldAutoApprove =
			config.isSubagentExecution ||
			(await Promise.all(relPaths.map((p) => uiHelpers.shouldAutoApproveToolWithPath(block.name, p)))).every(Boolean)

		if (shouldAutoApprove) {
			await uiHelpers.removeLastPartialMessageIfExistsWithType("ask", "tool")
			await uiHelpers.say("tool", partialMessage, undefined, undefined, block.partial)
		} else {
			await uiHelpers.removeLastPartialMessageIfExistsWithType("say", "tool")
			await uiHelpers.ask("tool", partialMessage, block.partial).catch(() => {})
		}
	}

	/**
	 * Run listFiles across all requested paths. Honors abortSignal between
	 * paths and is forwarded into globbyLevelByLevel for early cancellation.
	 */
	private async listAll(
		config: TaskConfig,
		relPaths: string[],
		recursive: boolean,
		abortSignal?: AbortSignal,
	): Promise<PerPathListing[]> {
		const out: PerPathListing[] = []
		for (const relDirPath of relPaths) {
			if (abortSignal?.aborted) {
				const err = new Error("Aborted")
				err.name = "AbortError"
				throw err
			}

			// Check diracignore access before performing any IO.
			const accessValidation = this.validator.checkDiracIgnorePath(relDirPath)
			if (!accessValidation.ok) {
				out.push({
					relDirPath,
					displayPath: relDirPath,
					absolutePath: path.resolve(config.cwd, relDirPath),
					usedWorkspaceHint: false,
					fileInfos: [],
					didHitLimit: false,
					error: `Access to ${relDirPath} is blocked by .diracignore settings.`,
				})
				continue
			}

			try {
				const pathResult = resolveWorkspacePath(config, relDirPath, "ListFilesToolHandler.execute")
				const { absolutePath, displayPath } =
					typeof pathResult === "string" ? { absolutePath: pathResult, displayPath: relDirPath } : pathResult
				const usedWorkspaceHint = typeof pathResult !== "string"

				const [fileInfos, didHitLimit] = await listFiles(
					absolutePath,
					recursive,
					ListFilesToolHandler.MAX_FILES_LIMIT,
					abortSignal,
				)
				out.push({
					relDirPath,
					displayPath,
					absolutePath,
					usedWorkspaceHint,
					fileInfos,
					didHitLimit,
				})
			} catch (error) {
				if ((error as any)?.name === "AbortError") {
					throw error
				}
				const errorMessage = error instanceof Error ? error.message : String(error)
				out.push({
					relDirPath,
					displayPath: relDirPath,
					absolutePath: path.resolve(config.cwd, relDirPath),
					usedWorkspaceHint: false,
					fileInfos: [],
					didHitLimit: false,
					error: `Error listing files in ${relDirPath}: ${errorMessage}`,
				})
			}
		}
		return out
	}

	private formatListings(config: TaskConfig, listings: PerPathListing[]): string {
		const results: string[] = []
		for (const l of listings) {
			if (l.error) {
				results.push(l.error)
				continue
			}
			const formattedList = formatResponse.formatFilesList(
				l.absolutePath,
				l.fileInfos,
				l.didHitLimit,
				config.services.diracIgnoreController,
			)
			results.push(`Contents of ${l.relDirPath}:\n${formattedList}`)
		}
		return results.join(`\n\n${"=".repeat(20)}\n\n`)
	}

	async execute(config: TaskConfig, block: ToolUse): Promise<ToolResponse> {
		const relPaths = Array.isArray(block.params.paths)
			? block.params.paths
			: block.params.paths
				? [block.params.paths as string]
				: []
		const recursiveRaw = block.params.recursive
		const recursive = String(recursiveRaw ?? "").toLowerCase() === "true"

		// Extract provider using the proven pattern from ReportBugHandler
		const apiConfig = config.services.stateManager.getApiConfiguration()
		const currentMode = config.services.stateManager.getGlobalSettingsKey("mode")
		const provider = (currentMode === "plan" ? apiConfig.planModeApiProvider : apiConfig.actModeApiProvider) as string

		// Validate required parameters
		const validation: { ok: boolean; error?: string; paramName?: string } = {
			...this.validator.assertRequiredParams(block, "paths"),
			paramName: "paths",
		}

		if (!validation.ok) {
			config.taskState.consecutiveMistakeCount++
			if (validation.paramName) {
				return await config.callbacks.sayAndCreateMissingParamError(this.name, validation.paramName as any)
			}
			await config.callbacks.say("error", `Dirac tried to use ${this.name} without providing any paths. Retrying...`)
			return formatResponse.toolError(validation.error!)
		}

		// Sprint 2-E: async-by-default ONLY when recursive=true. Non-recursive
		// listing remains synchronous (the fast top-level glob is cheap, no
		// reason to incur registry/notifier overhead).
		const registry = config.taskState?.pendingTools
		const useAsync = recursive && registry !== undefined

		let asyncEntry: ReturnType<NonNullable<typeof registry>["register"]> | undefined
		let abortSignal: AbortSignal | undefined
		let asyncHandleDispose: (() => void) | undefined

		if (useAsync) {
			asyncEntry = registry.register({ toolName: "list_files", blockId: block.call_id })
			abortSignal = asyncEntry.abortController.signal

			const messengerAdapter = {
				say: (type: any, text?: string, images?: string[], files?: string[], partial?: boolean) =>
					config.callbacks.say(type, text, images, files, partial),
			} as unknown as TaskMessenger

			try {
				const handle = await notifyAsyncTool({
					messenger: messengerAdapter,
					registry,
					entry: asyncEntry,
					initialPayload: {
						tool: "listFilesRecursive" as any,
						paths: relPaths.map((p) => getReadablePath(config.cwd, p)),
						path: getReadablePath(config.cwd, relPaths[0] || ""),
						content: "",
						operationIsLocatedInWorkspace: (await Promise.all(relPaths.map((p) => isLocatedInWorkspace(p)))).every(
							Boolean,
						),
					},
				})
				asyncHandleDispose = handle.dispose
			} catch (err) {
				Logger.warn(
					`[ListFilesToolHandler] notifyAsyncTool failed (continuing sync): ${err instanceof Error ? err.message : String(err)}`,
				)
			}
		}

		// Kick off the listing. In async mode we race it with a fast-path timer.
		const listingPromise = this.listAll(config, relPaths, recursive, abortSignal)

		let listings: PerPathListing[] | "timeout"
		if (useAsync && asyncEntry) {
			let timeoutHandle: NodeJS.Timeout | undefined
			const timeoutPromise = new Promise<"timeout">((resolve) => {
				timeoutHandle = setTimeout(() => resolve("timeout"), ASYNC_FAST_PATH_MS)
			})
			listings = await Promise.race([listingPromise, timeoutPromise])
			if (timeoutHandle) {
				clearTimeout(timeoutHandle)
			}
		} else {
			try {
				listings = await listingPromise
			} catch (err) {
				// Sync path with no registry: surface as tool error.
				config.taskState.consecutiveMistakeCount++
				const msg = err instanceof Error ? err.message : String(err)
				return formatResponse.toolError(`Error listing files: ${msg}`)
			}
		}

		// ── Slow-path: recursive listing past the budget. Hand off to background.
		if (listings === "timeout") {
			const taskId = asyncEntry!.taskId

			// Background settlement.
			void listingPromise
				.then((settled) => {
					try {
						const allErrored =
							settled.length > 0 && settled.every((s) => s.error !== undefined && s.fileInfos.length === 0)
						const formatted = this.formatListings(config, settled)
						if (allErrored) {
							registry!.fail(taskId, formatted || "All listings failed.")
						} else {
							registry!.complete(taskId, formatted)
						}
					} catch (err) {
						registry!.fail(taskId, err instanceof Error ? err.message : String(err))
					}
				})
				.catch((err: unknown) => {
					if ((err as any)?.name === "AbortError") {
						return
					}
					registry!.fail(taskId, err instanceof Error ? err.message : String(err))
				})

			const placeholderContent =
				`List recursive of "${relPaths[0] || ""}" launched in background.\n` +
				`task_id: ${taskId}\n` +
				`status: running\n` +
				`To retrieve the result, call get_tool_result with this task_id.`

			const placeholderProps = {
				tool: "listFilesRecursive",
				paths: relPaths.map((p) => getReadablePath(config.cwd, p)),
				path: getReadablePath(config.cwd, relPaths[0] || ""),
				content: "",
				operationIsLocatedInWorkspace: (await Promise.all(relPaths.map((p) => isLocatedInWorkspace(p)))).every(Boolean),
			}
			const placeholderMessage = JSON.stringify(placeholderProps)

			const workspaceContextAsync = {
				isMultiRootEnabled: config.isMultiRootEnabled || false,
				usedWorkspaceHint: false,
				resolvedToNonPrimary: false,
				resolutionMethod: "primary_fallback" as const,
			}

			const shouldAutoApproveAsync =
				config.isSubagentExecution ||
				(await Promise.all(relPaths.map((p) => config.callbacks.shouldAutoApproveToolWithPath(block.name, p)))).every(
					Boolean,
				)

			if (shouldAutoApproveAsync) {
				if (!config.isSubagentExecution) {
					await config.callbacks.removeLastPartialMessageIfExistsWithType("ask", "tool")
					await config.callbacks.say("tool", placeholderMessage, undefined, undefined, false)
				}
				telemetryService.captureToolUsage(
					config.ulid,
					block.name,
					config.api.getModel().id,
					provider,
					true,
					true,
					workspaceContextAsync,
					block.isNativeToolCall,
				)
			} else {
				const notificationMessage =
					relPaths.length > 1
						? `Dirac wants to view ${relPaths.length} directories`
						: `Dirac wants to view directory ${relPaths[0]}/`
				showNotificationForApproval(notificationMessage, config.autoApprovalSettings.enableNotifications)
				await config.callbacks.removeLastPartialMessageIfExistsWithType("say", "tool")
				const { didApprove } = await ToolResultUtils.askApprovalAndPushFeedback("tool", placeholderMessage, config)
				if (!didApprove) {
					registry!.cancel(taskId)
					if (asyncHandleDispose) {
						asyncHandleDispose()
					}
					telemetryService.captureToolUsage(
						config.ulid,
						block.name,
						config.api.getModel().id,
						provider,
						false,
						false,
						workspaceContextAsync,
						block.isNativeToolCall,
					)
					return formatResponse.toolDenied()
				}
				telemetryService.captureToolUsage(
					config.ulid,
					block.name,
					config.api.getModel().id,
					provider,
					false,
					true,
					workspaceContextAsync,
					block.isNativeToolCall,
				)
			}

			// PreToolUse hook still fires before returning placeholder.
			try {
				const { ToolHookUtils } = await import("../utils/ToolHookUtils")
				await ToolHookUtils.runPreToolUseIfEnabled(config, block)
			} catch (error) {
				const { PreToolUseHookCancellationError } = await import("@core/hooks/PreToolUseHookCancellationError")
				if (error instanceof PreToolUseHookCancellationError) {
					registry!.cancel(taskId)
					if (asyncHandleDispose) {
						asyncHandleDispose()
					}
					return formatResponse.toolDenied()
				}
				throw error
			}

			return placeholderContent
		}

		// ── Fast-path (sync flow, recursive=false OR recursive finished in budget).
		const settledListings = listings
		const absolutePaths = settledListings.map((l) => l.absolutePath)
		const displayPaths = settledListings.map((l) => l.displayPath)
		const anyHitLimit = settledListings.some((l) => l.didHitLimit)
		const anyUsedWorkspaceHint = settledListings.some((l) => l.usedWorkspaceHint)
		const totalFilesFound = settledListings.reduce((acc, l) => acc + l.fileInfos.length, 0)
		const hasError = settledListings.some((l) => l.error !== undefined)
		const anyResolvedToNonPrimary = settledListings.some(
			(l) => !arePathsEqual(l.absolutePath, path.resolve(config.cwd, l.relDirPath)),
		)

		void anyHitLimit // (preserved for potential future telemetry; formatFilesList already uses it)

		if (hasError && settledListings.every((l) => l.error !== undefined) && totalFilesFound === 0) {
			config.taskState.consecutiveMistakeCount++
		} else {
			config.taskState.consecutiveMistakeCount = 0
		}

		const finalResult = this.formatListings(config, settledListings)

		// Settle the registry entry on the fast-path so it doesn't leak.
		if (useAsync && asyncEntry) {
			const allErrored =
				settledListings.length > 0 && settledListings.every((l) => l.error !== undefined && l.fileInfos.length === 0)
			if (allErrored) {
				registry.fail(asyncEntry.taskId, finalResult || "All listings failed.")
			} else {
				registry.complete(asyncEntry.taskId, finalResult)
			}
			if (asyncHandleDispose) {
				asyncHandleDispose()
			}
		}

		const workspaceContext = {
			isMultiRootEnabled: config.isMultiRootEnabled || false,
			usedWorkspaceHint: anyUsedWorkspaceHint,
			resolvedToNonPrimary: anyResolvedToNonPrimary,
			resolutionMethod: (anyUsedWorkspaceHint ? "hint" : "primary_fallback") as "hint" | "primary_fallback",
		}

		const sharedMessageProps = {
			tool: recursive ? "listFilesRecursive" : "listFilesTopLevel",
			paths: displayPaths.map((p) => getReadablePath(config.cwd, p)),
			content: finalResult,
			operationIsLocatedInWorkspace: (await Promise.all(relPaths.map((p) => isLocatedInWorkspace(p)))).every(Boolean),
			path: displayPaths[0],
		}

		const completeMessage = JSON.stringify(sharedMessageProps)

		const shouldAutoApprove =
			config.isSubagentExecution ||
			(await Promise.all(relPaths.map((p) => config.callbacks.shouldAutoApproveToolWithPath(block.name, p)))).every(Boolean)

		if (shouldAutoApprove) {
			if (!config.isSubagentExecution) {
				await config.callbacks.removeLastPartialMessageIfExistsWithType("ask", "tool")
				await config.callbacks.say("tool", completeMessage, undefined, undefined, false)
			}

			telemetryService.captureToolUsage(
				config.ulid,
				block.name,
				config.api.getModel().id,
				provider,
				true,
				true,
				workspaceContext,
				block.isNativeToolCall,
			)
		} else {
			const notificationMessage =
				relPaths.length > 1
					? `Dirac wants to view ${relPaths.length} directories`
					: `Dirac wants to view directory ${getWorkspaceBasename(absolutePaths[0], "ListFilesToolHandler.notification")}/`

			showNotificationForApproval(notificationMessage, config.autoApprovalSettings.enableNotifications)

			await config.callbacks.removeLastPartialMessageIfExistsWithType("say", "tool")
			await config.callbacks.removeLastPartialMessageIfExistsWithType("ask", "tool")

			const { didApprove } = await ToolResultUtils.askApprovalAndPushFeedback("tool", completeMessage, config)
			if (!didApprove) {
				telemetryService.captureToolUsage(
					config.ulid,
					block.name,
					config.api.getModel().id,
					provider,
					false,
					false,
					workspaceContext,
					block.isNativeToolCall,
				)
				return formatResponse.toolDenied()
			}
			telemetryService.captureToolUsage(
				config.ulid,
				block.name,
				config.api.getModel().id,
				provider,
				false,
				true,
				workspaceContext,
				block.isNativeToolCall,
			)
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

		return finalResult
	}
}
