import { Logger } from "@/shared/services/Logger"
import { telemetryService } from "../../../services/telemetry"
import { HookInput, HookOutput } from "../../../shared/proto/isaac/hooks"
import { HookExecutionError } from "../HookError"
import { HookProcess } from "../HookProcess"
import {
	EXIT_CODE_SIGINT,
	exec,
	HOOK_EXECUTION_TIMEOUT_MS,
	HookName,
	HookRunner,
	HookStreamCallback,
	MAX_CONTEXT_MODIFICATION_SIZE,
	validateHookOutput,
} from "../hook-types"

/**
 * Executes a hook script as a child process with real-time output streaming.
 *
 * Key features:
 * - Spawns the hook script and communicates via stdin/stdout/stderr
 * - Streams output line-by-line via callback for real-time UI updates
 * - Enforces 30-second timeout (configurable via HOOK_EXECUTION_TIMEOUT_MS)
 * - Supports cancellation via AbortSignal
 * - Parses JSON output from stdout, attempting to extract it even if mixed with debug output
 * - Truncates context modifications that exceed 50KB to prevent prompt overflow
 * - Handles both successful and failed executions gracefully
 * - Emits per-hook telemetry with source attribution (global or workspace)
 *
 * Error handling:
 * - Treats hooks as "fail-open": only shouldContinue:false blocks tool execution
 * - Hook script errors (non-zero exit) don't block tools, only explicit JSON response does
 * - Timeout/cancellation errors are propagated to show "Failed" status in UI
 *
 * @template Name The type of hook this runner represents
 */
export class StdioHookRunner<Name extends HookName> extends HookRunner<Name> {
	constructor(
		hookName: Name,
		public readonly scriptPath: string,
		private readonly source: "global" | "workspace",
		private readonly streamCallback?: HookStreamCallback,
		private readonly abortSignal?: AbortSignal,
		private readonly taskId?: string,
		private readonly toolName?: string,
		private readonly cwd?: string,
	) {
		super(hookName)
	}

	override async [exec](input: HookInput): Promise<HookOutput> {
		const startTime = performance.now()
		const taskId = this.taskId // Local const for type narrowing in closures

		// Capture telemetry at the start of individual hook execution
		if (taskId) {
			telemetryService.safeCapture(
				() =>
					telemetryService.captureHookExecution(taskId, this.hookName, "started", {
						source: this.source,
						toolName: this.toolName,
					}),
				"HookFactory.exec.started",
			)
		}

		// Check if already aborted before starting
		if (this.abortSignal?.aborted) {
			throw HookExecutionError.cancellation(this.scriptPath)
		}

		// Serialize input to JSON
		// NOTE: Proto3 by default omits empty strings (default values) from toJSON()
		// To ensure hooks receive consistent data (e.g., {"prompt": ""} instead of {}),
		// we manually construct the JSON object and explicitly include empty string fields
		const jsonObj = HookInput.toJSON(input) as Record<string, any>

		// Ensure empty prompt strings are preserved in UserPromptSubmit data
		if (jsonObj.userPromptSubmit && jsonObj.userPromptSubmit.prompt === undefined) {
			jsonObj.userPromptSubmit.prompt = ""
		}

		const inputJson = JSON.stringify(jsonObj)

		// Create HookProcess for execution with streaming
		const hookProcess = new HookProcess(this.scriptPath, HOOK_EXECUTION_TIMEOUT_MS, this.abortSignal, this.cwd)

		// Set up streaming if callback is provided
		if (this.streamCallback) {
			const callback = this.streamCallback
			hookProcess.on("line", (line: string, stream: "stdout" | "stderr") => {
				// NOTE: HookProcess emits a synthetic empty line (""), used as a "start of output" marker.
				// Preserve it for now so downstream can keep existing behavior.
				callback(line, stream, {
					source: this.source,
					scriptPath: this.scriptPath,
				})
			})
		}

		try {
			// Execute the hook and wait for completion
			await hookProcess.run(inputJson)

			// Get the complete stdout for JSON parsing
			const stdout = hookProcess.getStdout()
			const stderr = hookProcess.getStderr()
			const exitCode = hookProcess.getExitCode()

			// Try to parse JSON output
			const parseJsonOutput = (): HookOutput | null => {
				try {
					const outputData = JSON.parse(stdout)

					// Validate structure before creating HookOutput
					const validation = validateHookOutput(outputData)
					if (!validation.valid) {
						// Return null to indicate parsing failed, let caller decide what to do based on exit code
						return null
					}

					const output = HookOutput.fromJSON(outputData)

					// Validate and truncate context modification if too large
					if (output.contextModification && output.contextModification.length > MAX_CONTEXT_MODIFICATION_SIZE) {
						Logger.warn(
							`Hook ${this.hookName} returned contextModification of ${output.contextModification.length} bytes, ` +
								`truncating to ${MAX_CONTEXT_MODIFICATION_SIZE} bytes`,
						)
						output.contextModification =
							output.contextModification.slice(0, MAX_CONTEXT_MODIFICATION_SIZE) +
							"\n\n[... context truncated due to size limit ...]"
					}

					return output
				} catch (parseError) {
					// Try to extract JSON from stdout (it might have debug output before/after)
					// Scan from the end to find the last complete JSON object
					// This handles cases where hooks output debug info before the actual JSON response

					const lines = stdout.split("\n")
					let jsonCandidate = ""
					let braceCount = 0
					let startCollecting = false

					// Scan from the end to find the last complete JSON object
					for (let i = lines.length - 1; i >= 0; i--) {
						const line = lines[i].trimEnd()

						// Count braces to track JSON object boundaries
						for (let j = line.length - 1; j >= 0; j--) {
							if (line[j] === "}") {
								braceCount++
								if (!startCollecting) {
									startCollecting = true
								}
							} else if (line[j] === "{") {
								braceCount--
							}
						}

						if (startCollecting) {
							jsonCandidate = line + "\n" + jsonCandidate
						}

						// If we've closed all braces, we have a complete JSON object
						if (startCollecting && braceCount === 0) {
							break
						}
					}

					if (jsonCandidate.trim()) {
						try {
							// Trim everything before the first opening bracket
							const trimmedCandidate = jsonCandidate.trim()
							const firstBraceIndex = trimmedCandidate.indexOf("{")
							const cleanedJson =
								firstBraceIndex !== -1 ? trimmedCandidate.slice(firstBraceIndex) : trimmedCandidate

							const outputData = JSON.parse(cleanedJson)

							// Validate structure
							const validation = validateHookOutput(outputData)
							if (!validation.valid) {
								// Return null to indicate parsing failed
								return null
							}

							const output = HookOutput.fromJSON(outputData)

							// Validate and truncate context modification if too large
							if (output.contextModification && output.contextModification.length > MAX_CONTEXT_MODIFICATION_SIZE) {
								Logger.warn(
									`Hook ${this.hookName} returned contextModification of ${output.contextModification.length} bytes, ` +
										`truncating to ${MAX_CONTEXT_MODIFICATION_SIZE} bytes`,
								)
								output.contextModification =
									output.contextModification.slice(0, MAX_CONTEXT_MODIFICATION_SIZE) +
									"\n\n[... context truncated due to size limit ...]"
							}

							return output
						} catch (_extractError) {
							// Couldn't extract valid JSON, return null
							return null
						}
					}

					// Couldn't parse JSON at all, return null
					return null
				}
			}

			const parsedOutput = parseJsonOutput()

			// If we have valid JSON, honor it regardless of exit code
			if (parsedOutput) {
				const durationMs = performance.now() - startTime

				// Log warning if non-zero exit but valid JSON (for developers)
				if (exitCode !== 0) {
					Logger.warn(`[Hook ${this.hookName}] Exited with code ${exitCode} but provided valid JSON response`)
					if (stderr) {
						Logger.warn(`[Hook ${this.hookName}] stderr: ${stderr}`)
					}
				}

				// Capture success/cancellation telemetry
				if (taskId) {
					if (parsedOutput.cancel) {
						telemetryService.safeCapture(
							() =>
								telemetryService.captureHookExecution(taskId, this.hookName, "completed", {
									source: this.source,
									toolName: this.toolName,
									durationMs,
									exitCode: exitCode ?? EXIT_CODE_SIGINT,
									cancelRequested: true,
									contextModified: !!parsedOutput.contextModification,
									contextSize: parsedOutput.contextModification?.length,
								}),
							"HookFactory.exec.completed.cancel",
						)
					} else {
						telemetryService.safeCapture(
							() =>
								telemetryService.captureHookExecution(taskId, this.hookName, "completed", {
									source: this.source,
									toolName: this.toolName,
									durationMs,
									exitCode: exitCode ?? 0,
									cancelRequested: false,
									contextModified: !!parsedOutput.contextModification,
									contextSize: parsedOutput.contextModification?.length,
								}),
							"HookFactory.exec.completed.success",
						)
					}
				}

				return parsedOutput
			}

			// No valid JSON found
			if (exitCode === 0) {
				// Hook succeeded but didn't provide JSON - allow execution (no cancellation)
				Logger.warn(`[Hook ${this.hookName}] Completed successfully but no JSON response found`)
				const durationMs = performance.now() - startTime

				// Capture success telemetry even without JSON
				if (taskId) {
					telemetryService.safeCapture(
						() =>
							telemetryService.captureHookExecution(taskId, this.hookName, "completed", {
								source: this.source,
								toolName: this.toolName,
								durationMs,
								exitCode: 0,
								cancelRequested: false,
								contextModified: false,
							}),
						"HookFactory.exec.completed.noJson",
					)
				}

				return HookOutput.create({
					cancel: false,
				})
			}
			// Hook failed with non-zero exit - include hook name in error
			throw HookExecutionError.execution(this.scriptPath, exitCode ?? 1, stderr, this.hookName)
		} catch (error) {
			const durationMs = performance.now() - startTime

			// If it's already a HookExecutionError, re-throw it
			if (HookExecutionError.isHookError(error)) {
				// Capture failure telemetry based on error type
				if (taskId) {
					if (error.errorInfo.type === "cancellation") {
						telemetryService.safeCapture(
							() =>
								telemetryService.captureHookExecution(taskId, this.hookName, "cancelled", {
									source: this.source,
									toolName: this.toolName,
								}),
							"HookFactory.exec.error.cancellation",
						)
					} else if (error.errorInfo.type === "timeout") {
						telemetryService.safeCapture(
							() =>
								telemetryService.captureHookExecution(taskId, this.hookName, "failed", {
									source: this.source,
									toolName: this.toolName,
									durationMs,
									errorType: "timeout",
									errorMessage: error.message,
								}),
							"HookFactory.exec.error.timeout",
						)
					} else {
						telemetryService.safeCapture(
							() =>
								telemetryService.captureHookExecution(taskId, this.hookName, "failed", {
									source: this.source,
									toolName: this.toolName,
									durationMs,
									exitCode: error.errorInfo.exitCode ?? 1,
									errorType: error.errorInfo.type as "execution" | "timeout" | "validation",
									errorMessage: error.message,
								}),
							"HookFactory.exec.error.failed",
						)
					}
				}
				throw error
			}

			// Hook execution failed - categorize the error
			const stderr = hookProcess.getStderr()
			const exitCode = hookProcess.getExitCode()

			// Check for timeout
			if (error instanceof Error && error.message.includes("timed out")) {
				if (taskId) {
					telemetryService.safeCapture(
						() =>
							telemetryService.captureHookExecution(taskId, this.hookName, "failed", {
								source: this.source,
								toolName: this.toolName,
								durationMs,
								errorType: "timeout",
								errorMessage: error.message,
							}),
						"HookFactory.exec.catch.timeout",
					)
				}
				throw HookExecutionError.timeout(this.scriptPath, HOOK_EXECUTION_TIMEOUT_MS, stderr, this.hookName)
			}

			// Check for cancellation
			if (error instanceof Error && error.message.includes("cancelled")) {
				if (taskId) {
					telemetryService.safeCapture(
						() =>
							telemetryService.captureHookExecution(taskId, this.hookName, "cancelled", {
								source: this.source,
								toolName: this.toolName,
							}),
						"HookFactory.exec.catch.cancelled",
					)
				}
				throw HookExecutionError.cancellation(this.scriptPath, this.hookName)
			}

			// Generic execution error - include hook name
			if (taskId) {
				telemetryService.safeCapture(
					() =>
						telemetryService.captureHookExecution(taskId, this.hookName, "failed", {
							source: this.source,
							toolName: this.toolName,
							durationMs,
							exitCode: exitCode ?? 1,
							errorType: "execution",
							errorMessage: error instanceof Error ? error.message : String(error),
						}),
					"HookFactory.exec.catch.execution",
				)
			}
			throw HookExecutionError.execution(this.scriptPath, exitCode ?? 1, stderr, this.hookName)
		}
	}
}
