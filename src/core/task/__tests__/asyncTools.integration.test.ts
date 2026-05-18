import { strict as assert } from "node:assert"
import { spawn } from "node:child_process"
import type { DiracSayTool } from "@shared/ExtensionMessage"
import { describe, it } from "mocha"
import sinon from "sinon"
import { DiracDefaultTool } from "@/shared/tools"
import { TaskState } from "../TaskState"
import { ExecuteCommandToolHandler } from "../tools/handlers/ExecuteCommandToolHandler"
import { GetToolResultToolHandler } from "../tools/handlers/GetToolResultToolHandler"
import { ToolValidator } from "../tools/ToolValidator"
import type { TaskConfig } from "../tools/types/TaskConfig"

/**
 * Sprint 2 — task H: end-to-end async-tool flow.
 *
 * Integrates ExecuteCommandToolHandler + PendingToolRegistry + AsyncToolNotifier
 * + GetToolResultToolHandler with a real `executeCommandTool` callback that
 * spawns a bash subprocess. We do NOT mount a full `Task` (too heavy and
 * tightly coupled to the webview/storage/host stack). Direct handler
 * invocation provides everything we need:
 *  - real PendingToolRegistry events,
 *  - real AsyncToolNotifier listener wiring,
 *  - real fast-path → background timeout race (500 ms),
 *  - real abort signal honored by child_process.
 *
 * Skipped on Windows: the test relies on `sleep` semantics + POSIX SIGTERM.
 */

interface CapturedSay {
	type: string
	text: string | undefined
	partial: boolean | undefined
}

function makeRealisticConfig(): {
	config: TaskConfig
	taskState: TaskState
	sayCalls: CapturedSay[]
	storedMessages: any[]
} {
	const taskState = new TaskState()
	const sayCalls: CapturedSay[] = []
	const storedMessages: any[] = []

	// Minimal but real `executeCommandTool` — actually spawn the command and
	// honor abortSignal. Returns [userRejected, output] like the production
	// callback.
	const realExecuteCommandTool = (
		command: string,
		_timeoutSeconds: number | undefined,
		options?: { abortSignal?: AbortSignal; onOutputLine?: (line: string) => void },
	): Promise<[boolean, string]> => {
		return new Promise((resolve, reject) => {
			const child = spawn("bash", ["-c", command], { stdio: ["ignore", "pipe", "pipe"] })
			let stdout = ""
			let stderr = ""
			child.stdout.on("data", (b) => {
				const s = b.toString()
				stdout += s
				options?.onOutputLine?.(s.trimEnd())
			})
			child.stderr.on("data", (b) => {
				stderr += b.toString()
			})
			child.on("error", (err) => reject(err))
			child.on("close", (code, signal) => {
				if (signal === "SIGTERM" || signal === "SIGKILL") {
					const err: any = new Error("aborted")
					err.name = "AbortError"
					reject(err)
					return
				}
				if (code === 0) {
					resolve([false, stdout + stderr])
				} else {
					resolve([false, `${stdout}${stderr}\n[exit ${code}]`])
				}
			})
			if (options?.abortSignal) {
				options.abortSignal.addEventListener(
					"abort",
					() => {
						try {
							child.kill("SIGTERM")
						} catch {
							// ignore
						}
					},
					{ once: true },
				)
			}
		})
	}

	const callbacks = {
		say: sinon.stub().callsFake(async (type: string, text?: string, _i?: any, _f?: any, partial?: boolean) => {
			sayCalls.push({ type, text, partial })
			return Date.now()
		}),
		ask: sinon.stub().resolves({ response: "yesButtonClicked", text: "ok" }),
		sayAndCreateMissingParamError: sinon.stub().resolves("missing"),
		removeLastPartialMessageIfExistsWithType: sinon.stub().resolves(),
		executeCommandTool: realExecuteCommandTool,
		getDiracMessages: () => storedMessages,
		updateDiracMessage: sinon.stub().resolves(),
	}

	const config = {
		taskId: "task-async-itest",
		ulid: "01ASYNC",
		cwd: "/tmp",
		mode: "act",
		yoloModeToggled: true,
		isSubagentExecution: false,
		taskState,
		api: { getModel: () => ({ id: "test-model", info: { supportsImages: false } }) },
		services: {
			stateManager: {
				getGlobalSettingsKey: (key: string) => {
					if (key === "mode") return "act"
					if (key === "autoApproveAllToggled") return true
					if (key === "hooksEnabled") return false
					return undefined
				},
				getApiConfiguration: () => ({
					planModeApiProvider: "openai",
					actModeApiProvider: "openai",
				}),
			},
			commandPermissionController: { validateCommand: () => ({ allowed: true }) },
			diracIgnoreController: { validateCommand: () => undefined },
		},
		callbacks,
		autoApprovalSettings: { enableNotifications: false },
		autoApprover: { shouldAutoApproveTool: () => [true, true] as [boolean, boolean] },
	} as unknown as TaskConfig

	return { config, taskState, sayCalls, storedMessages }
}

function makeBashBlock(command: string): any {
	return {
		type: "tool_use",
		call_id: "block-1",
		name: DiracDefaultTool.BASH,
		params: { commands: [command] },
		partial: false,
	}
}

function makeGetResultBlock(params: Record<string, unknown>): any {
	return { name: "get_tool_result", params, partial: false }
}

function parseTaskIdFromResponse(response: unknown): string | undefined {
	const text = String(response)
	const m = text.match(/task_id:\s*([0-9A-HJKMNP-TV-Z]+)/i)
	return m?.[1]
}

const DESCRIBE = process.platform === "win32" ? describe.skip : describe

DESCRIBE("asyncTools integration (execute_command + registry + notifier + get_tool_result)", function () {
	this.timeout(15_000)

	it("end-to-end: long command goes async, completes in background, retrievable via get_tool_result", async () => {
		const { config, taskState, sayCalls } = makeRealisticConfig()
		const validator = new ToolValidator({ validateAccess: () => true } as any)
		const handler = new ExecuteCommandToolHandler(validator)

		// `sleep 1` exceeds the 500ms fast-path → handler returns a placeholder
		// with task_id while the command keeps running in the background.
		const result = await handler.execute(config, makeBashBlock("sleep 1 && echo done"))

		// Phase 1 assertions: handler returned a "running" placeholder
		const text = String(result)
		assert.match(text, /task_id:\s*[0-9A-Z]+/i, "expected task_id in placeholder")
		assert.match(text, /status: running/, "expected status: running")
		assert.match(text, /get_tool_result/, "expected hint to call get_tool_result")
		const taskId = parseTaskIdFromResponse(result)!
		assert.ok(taskId, "could not parse task_id")

		// Registry has a running entry for execute_command
		const running = taskState.pendingTools.list({ status: "running" })
		assert.equal(running.length, 1)
		assert.equal(running[0].toolName, "execute_command")
		assert.equal(running[0].taskId, taskId)

		// AsyncToolNotifier pushed a partial:true running say with asyncStatus.
		const runningSay = sayCalls.find((s) => {
			if (s.type !== "tool" || !s.text) return false
			try {
				const p = JSON.parse(s.text) as DiracSayTool
				return p.asyncStatus === "running" && p.asyncTaskId === taskId
			} catch {
				return false
			}
		})
		assert.ok(runningSay, "expected an async-running say")
		assert.equal(runningSay.partial, true)

		// Phase 2: poll up to 3s for the registry entry to flip to completed.
		const deadline = Date.now() + 3000
		while (Date.now() < deadline) {
			if (taskState.pendingTools.get(taskId)?.status === "completed") break
			await new Promise((r) => setTimeout(r, 50))
		}
		const entry = taskState.pendingTools.get(taskId)!
		assert.equal(entry.status, "completed", `entry never completed: ${entry.status}`)
		assert.ok(entry.finishedAt && entry.startedAt && entry.finishedAt - entry.startedAt >= 900)
		assert.match(String(entry.result ?? ""), /done/)

		// Allow the notifier listener microtask to flush.
		await new Promise((r) => setImmediate(r))

		const completionSay = sayCalls.find((s) => {
			if (s.type !== "tool" || !s.text) return false
			try {
				const p = JSON.parse(s.text) as DiracSayTool
				return p.asyncStatus === "completed" && p.asyncTaskId === taskId
			} catch {
				return false
			}
		})
		assert.ok(completionSay, "expected an async-completed say")
		assert.equal(completionSay.partial, false)
		const completionPayload = JSON.parse(completionSay.text!) as DiracSayTool
		assert.ok(
			completionPayload.asyncDurationMs !== undefined && completionPayload.asyncDurationMs >= 900,
			`expected duration >= 900ms, got ${completionPayload.asyncDurationMs}`,
		)

		// Phase 3: GetToolResultToolHandler retrieves it with no wait needed.
		const getResult = new GetToolResultToolHandler()
		const fetched = await getResult.execute(config, makeGetResultBlock({ task_id: taskId }))
		const fetchedText = String(fetched)
		assert.match(fetchedText, /completed in/)
		assert.match(fetchedText, /done/)
	})

	it("get_tool_result with wait=true blocks on a running task and returns the result on completion", async () => {
		const { config, taskState } = makeRealisticConfig()
		const validator = new ToolValidator({ validateAccess: () => true } as any)
		const handler = new ExecuteCommandToolHandler(validator)

		// Slightly slower than fast-path so we get the async placeholder.
		const placeholder = await handler.execute(config, makeBashBlock("sleep 0.7 && echo waited"))
		const taskId = parseTaskIdFromResponse(placeholder)!
		assert.ok(taskId)
		assert.equal(taskState.pendingTools.get(taskId)?.status, "running")

		const getResult = new GetToolResultToolHandler()
		const startedAt = Date.now()
		const fetched = await getResult.execute(config, makeGetResultBlock({ task_id: taskId, wait: true, timeout_ms: 3000 }))
		const elapsed = Date.now() - startedAt
		assert.ok(elapsed >= 100, `expected wait to actually block, only waited ${elapsed}ms`)
		assert.match(String(fetched), /waited/)
		assert.equal(taskState.pendingTools.get(taskId)?.status, "completed")
	})

	it("cancellation: cancelling a running entry aborts the subprocess and transitions to cancelled", async () => {
		const { config, taskState } = makeRealisticConfig()
		const validator = new ToolValidator({ validateAccess: () => true } as any)
		const handler = new ExecuteCommandToolHandler(validator)

		const placeholder = await handler.execute(config, makeBashBlock("sleep 5 && echo never"))
		const taskId = parseTaskIdFromResponse(placeholder)!
		assert.ok(taskId)
		assert.equal(taskState.pendingTools.get(taskId)?.status, "running")

		const cancelled = taskState.pendingTools.cancel(taskId)
		assert.equal(cancelled, true)
		assert.equal(taskState.pendingTools.get(taskId)?.status, "cancelled")

		// Wait briefly to ensure the background settlement does NOT overwrite
		// the cancelled status (registry guards against non-running transitions).
		await new Promise((r) => setTimeout(r, 300))
		assert.equal(taskState.pendingTools.get(taskId)?.status, "cancelled")

		const getResult = new GetToolResultToolHandler()
		const fetched = await getResult.execute(config, makeGetResultBlock({ task_id: taskId }))
		assert.match(String(fetched), /was cancelled/)
	})
})
