// ailiance-agent fork: integration-style tests for AgentLoopRunner.
//
// Issue #21 — P0-2. These tests cover the two fork-critical paths in
// AgentLoopRunner.makeRequest that previously had zero unit coverage:
//
// T1: terminal `catch (error) { Logger.error(...); throw error }`
//     (lines 600-609) — non-regression of the PR #19 fix. Previously
//     this catch swallowed every uncaught exception and returned true
//     (didEndLoop=true), masking programming bugs / network panics /
//     JSON parse errors as a silent successful termination.
// T2: empty-output heuristic — when the assistant produced no tool_use
//     AND outputTokens === 0, consecutiveMistakeCount must increment
//     by 2 (not 1). This bounds the damage of structurally broken
//     backends (Mistral-Medium-128B MLX observed 2026-05-12).
//
// The tests build a hand-crafted AgentLoopRunnerContext stuffed with
// sinon stubs. AgentLoopRunner is the real class.

import { strict as assert } from "assert"
import { describe, it, beforeEach, afterEach } from "mocha"
import sinon from "sinon"
import { AgentLoopRunner } from "../AgentLoopRunner"
import { TaskState } from "../TaskState"

// Minimal async-iterable that yields nothing — emulates an empty
// ApiStream so StreamChunkCoordinator completes immediately without
// errors.
async function* emptyStream(): AsyncGenerator<any> {
	// nothing to yield
}

function makeContext(overrides: any = {}): { ctx: any; taskState: TaskState; stubs: any } {
	const taskState = new TaskState()
	const stubs = {
		say: sinon.stub().resolves(undefined),
		ask: sinon.stub().resolves({ response: "yesButtonClicked" }),
		postStateToWebview: sinon.stub().resolves(),
		reinitExistingTaskFromId: sinon.stub().resolves(),
		abortTask: sinon.stub().resolves(),
		attemptApiRequest: sinon.stub().returns(emptyStream()),
		processNativeToolCalls: sinon.stub().resolves(),
		presentAssistantMessage: sinon.stub().resolves(),
		processAssistantResponse: sinon.stub().resolves(true),
		handleEmptyAssistantResponse: sinon.stub().resolves(true),
		initializeCheckpoints: sinon.stub().resolves(),
		determineContextCompaction: sinon.stub().resolves(false),
		prepareApiRequest: sinon.stub().resolves({
			userContent: [],
			lastApiReqIndex: 0,
			isDirectResponse: false,
			directResponseText: undefined,
		}),
	}

	const ctx: any = {
		taskId: "test-task",
		ulid: "test-ulid",
		taskState,
		api: {
			getModel: () => ({ id: "stub-model", info: { contextWindow: 8192 } }),
			abort: sinon.stub(),
			getApiStreamUsage: undefined,
		},
		streamHandler: {
			getHandlers: () => ({
				toolUseHandler: {
					getPartialToolUsesAsContent: () => [],
				},
				reasonsHandler: {
					getCurrentReasoning: () => undefined,
				},
			}),
			reset: sinon.stub(),
			setRequestId: sinon.stub(),
			processReasoningDelta: sinon.stub(),
			processToolUseDelta: sinon.stub(),
			processTextDelta: sinon.stub(),
			requestId: undefined,
		},
		diffViewProvider: {
			isEditing: false,
			revertChanges: sinon.stub().resolves(),
			reset: sinon.stub().resolves(),
		},
		checkpointManager: undefined,
		toolExecutor: {
			recordPlannerTurn: sinon.stub(),
			executeTool: sinon.stub().resolves(),
		},
		messageStateHandler: (() => {
			// One pre-existing api_req_started so findLastIndex finds an
			// index and updateApiReqMsg can JSON.parse a `text` field.
			const messages: any[] = [{ ts: 1, type: "say", say: "api_req_started", text: "{}", partial: true }]
			return {
				getIsaacMessages: () => messages,
				updateIsaacMessage: sinon.stub().callsFake(async (idx: number, patch: any) => {
					Object.assign(messages[idx], patch)
				}),
				saveIsaacMessagesAndUpdateHistory: sinon.stub().resolves(),
				addToApiConversationHistory: sinon.stub().resolves(),
			}
		})(),
		modelContextTracker: { recordModelUsage: sinon.stub().resolves() },
		stateManager: {
			getGlobalSettingsKey: (key: string) => {
				if (key === "maxConsecutiveMistakes") {
					return 1
				}
				if (key === "yoloModeToggled") {
					return true // YOLO so handleMistakeLimitReached returns didEndLoop=true without ask()
				}
				if (key === "autoApprovalSettings") {
					return { enableNotifications: false }
				}
				return undefined
			},
		},
		controller: { task: undefined },
		postStateToWebview: stubs.postStateToWebview,
		reinitExistingTaskFromId: stubs.reinitExistingTaskFromId,
		abortTask: stubs.abortTask,
		getCurrentProviderInfo: () => ({
			model: { id: "stub-model", info: { contextWindow: 8192 } },
			providerId: "stub-provider",
			customPrompt: "default",
			mode: "act",
		}),
		attemptApiRequest: stubs.attemptApiRequest,
		processNativeToolCalls: stubs.processNativeToolCalls,
		presentAssistantMessage: stubs.presentAssistantMessage,
		processAssistantResponse: stubs.processAssistantResponse,
		handleEmptyAssistantResponse: stubs.handleEmptyAssistantResponse,
		initializeCheckpoints: stubs.initializeCheckpoints,
		determineContextCompaction: stubs.determineContextCompaction,
		prepareApiRequest: stubs.prepareApiRequest,
		say: stubs.say,
		ask: stubs.ask,
	}

	Object.assign(ctx, overrides)
	return { ctx, taskState, stubs }
}

describe("AgentLoopRunner — error handling and mistake counting (issue #21)", () => {
	let sandbox: sinon.SinonSandbox

	beforeEach(() => {
		sandbox = sinon.createSandbox()
	})

	afterEach(() => {
		sandbox.restore()
	})

	it("T1: propagates errors thrown by processAssistantResponse (PR #19 non-regression)", async () => {
		// Without the PR #19 fix, the terminal catch returned true and
		// the task silently terminated as if successful. With the fix,
		// the exception bubbles up so the controller can surface it.
		const { ctx, stubs } = makeContext()
		const boom = new Error("synthetic planner failure")
		stubs.processAssistantResponse.rejects(boom)

		const runner = new AgentLoopRunner(ctx)

		let caught: unknown
		try {
			await runner.makeRequest([{ type: "text", text: "hello" }] as any)
			assert.fail("makeRequest should have thrown — the terminal catch must rethrow, not swallow")
		} catch (err) {
			caught = err
		}

		assert.equal(caught, boom, "the original error must propagate verbatim")
	})

	it("T1b: propagates errors thrown by prepareApiRequest (outer-scope failure)", async () => {
		// Belt-and-braces: errors thrown before the outer try block must
		// also propagate. This guards against anyone adding a wider catch
		// in the future that would re-introduce the swallow-all bug.
		const { ctx, stubs } = makeContext()
		const boom = new Error("synthetic prepare failure")
		stubs.prepareApiRequest.rejects(boom)

		const runner = new AgentLoopRunner(ctx)

		let caught: unknown
		try {
			await runner.makeRequest([{ type: "text", text: "hello" }] as any)
			assert.fail("makeRequest should have thrown")
		} catch (err) {
			caught = err
		}
		assert.equal(caught, boom)
	})

	it("T2: empty-output heuristic increments consecutiveMistakeCount by 2 (not 1)", async () => {
		// When the model returns zero output tokens AND no tool_use, the
		// fork doubles the mistake increment to abort 2x faster against
		// structurally-broken backends. To observe a single bump we'd
		// need to break the recursive makeRequest call — so we wire YOLO
		// mode + maxConsecutiveMistakes=1, so on recursion the mistake
		// limit short-circuits to didEndLoop=true.
		const { ctx, taskState, stubs } = makeContext()
		taskState.consecutiveMistakeCount = 0

		// Empty assistantMessageContent => no tool_use block.
		// processAssistantResponse returns true (assistantHasContent).
		// outputTokens stays at 0 because no usage chunk is delivered
		// and getApiStreamUsage is undefined.
		// userMessageContentReady must flip to true so pWaitFor resolves.
		stubs.processAssistantResponse.callsFake(async () => {
			taskState.userMessageContentReady = true
			return true
		})

		const runner = new AgentLoopRunner(ctx)
		await runner.makeRequest([{ type: "text", text: "hi" }] as any)

		// After one iteration with empty output and no tool_use, the
		// counter should jump by 2. The recursive call then hits the
		// mistake limit (1) under YOLO mode and ends the loop.
		assert.equal(
			taskState.consecutiveMistakeCount,
			2,
			"empty output + no tool_use must double-increment consecutiveMistakeCount",
		)
	}).timeout(5000)
})
