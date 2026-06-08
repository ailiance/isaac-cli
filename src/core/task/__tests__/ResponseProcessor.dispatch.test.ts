// ailiance-agent: integration-style tests for ResponseProcessor.
//
// Issue #21 — P0-2. These tests cover the two fork-critical paths in
// ResponseProcessor.presentAssistantMessage that previously had zero
// dedicated unit coverage:
//
// T3: hallucinated-XML rattrapage (lines 218-275) dispatches the
//     synthesized ToolUse to toolExecutor.executeTool exactly once.
// T4: double-dispatch guard (lines 239-243) — when the same stream
//     already produced a native tool_use block, the XML branch must
//     NOT also fire.
//
// We mock every TaskState/dependency surface that presentAssistantMessage
// touches. The real ResponseProcessor instance is exercised end-to-end
// over its own logic; only the world around it is faked.

import { strict as assert } from "assert"
import { beforeEach, describe, it } from "mocha"
import sinon from "sinon"
import { ResponseProcessor } from "../ResponseProcessor"
import { TaskState } from "../TaskState"

function makeTaskState(): TaskState {
	const s = new TaskState()
	s.didCompleteReadingStream = true
	return s
}

function makeDeps(taskState: TaskState, toolExecutor: any): any {
	return {
		taskState,
		messageStateHandler: {
			getIsaacMessages: () => [],
			updateIsaacMessage: sinon.stub().resolves(),
			saveIsaacMessagesAndUpdateHistory: sinon.stub().resolves(),
			addToApiConversationHistory: sinon.stub().resolves(),
		},
		api: { getModel: () => ({ id: "stub", info: { contextWindow: 1024 } }) },
		stateManager: { getGlobalSettingsKey: () => undefined },
		taskId: "test-task",
		ulid: "test-ulid",
		say: sinon.stub().resolves(undefined),
		ask: sinon.stub().resolves({ response: "yesButtonClicked" }),
		postStateToWebview: sinon.stub().resolves(),
		diffViewProvider: { isEditing: false, revertChanges: sinon.stub().resolves(), reset: sinon.stub().resolves() },
		streamHandler: {
			getHandlers: () => ({ reasonsHandler: { getCurrentReasoning: () => undefined }, toolUseHandler: {} }),
			getOrderedBlocks: () => [],
			requestId: "stub-req",
			reset: sinon.stub(),
			setRequestId: sinon.stub(),
			processReasoningDelta: sinon.stub(),
			processToolUseDelta: sinon.stub(),
			processTextDelta: sinon.stub(),
		},
		withStateLock: <T>(fn: () => T | Promise<T>) => Promise.resolve(fn()),
		getCurrentProviderInfo: () => ({ model: { id: "stub", info: {} }, providerId: "test", mode: "act" }),
		getApiRequestIdSafe: () => "stub-req-id",
		toolExecutor,
	}
}

describe("ResponseProcessor — hallucinated XML dispatch (issue #21)", () => {
	let sandbox: sinon.SinonSandbox
	let executeTool: sinon.SinonStub

	beforeEach(() => {
		sandbox = sinon.createSandbox()
		executeTool = sandbox.stub().resolves()
	})

	afterEach(() => {
		sandbox.restore()
	})

	it("T3: dispatches a hallucinated <function=NAME> XML block exactly once", async () => {
		// The model emitted Mistral-style flat XML instead of a native FC.
		// The rattrapage at ResponseProcessor.ts:218-275 should parse it,
		// canonicalise the tool name, synthesise a ToolUse, and call
		// toolExecutor.executeTool exactly once.
		const taskState = makeTaskState()
		taskState.assistantMessageContent = [
			{
				type: "text",
				content:
					"Sure, I will list the files.\n" +
					"<function=list_files>\n" +
					"<parameter=path>.</parameter>\n" +
					"</function>",
				partial: false,
			} as any,
		]
		taskState.currentStreamingContentIndex = 0
		taskState.useNativeToolCalls = false

		const deps = makeDeps(taskState, { executeTool })
		const processor = new ResponseProcessor(deps)

		await processor.presentAssistantMessage()

		assert.equal(executeTool.callCount, 1, "executeTool should be called exactly once")
		const call = executeTool.firstCall.args[0]
		assert.equal(call.type, "tool_use")
		assert.equal(call.name, "list_files")
		assert.equal(call.params.path, ".")
		assert.equal(call.isNativeToolCall, false)
	})

	it("T4: skips XML dispatch when a native tool_use block is already present (anti-double-dispatch guard)", async () => {
		// Defense for the guard at lines 239-243. With useNativeToolCalls=true
		// AND a native tool_use sibling in assistantMessageContent, the XML
		// branch must NOT dispatch — otherwise the same tool would run twice.
		const taskState = makeTaskState()
		taskState.useNativeToolCalls = true
		taskState.assistantMessageContent = [
			{
				type: "text",
				content: "I'll list the files.\n" + "<function=list_files>\n" + "<parameter=path>.</parameter>\n" + "</function>",
				partial: false,
			} as any,
			{
				// Native tool_use sibling — the OpenAI FC channel already
				// surfaced the call. Dispatch must happen exactly once
				// (via the tool_use branch on the next iteration), never twice.
				type: "tool_use",
				name: "list_files",
				params: { path: "." },
				partial: false,
				isNativeToolCall: true,
			} as any,
		]
		taskState.currentStreamingContentIndex = 0

		const deps = makeDeps(taskState, { executeTool })
		const processor = new ResponseProcessor(deps)

		// Drive presentation: text block first (must NOT dispatch via XML
		// because of the guard) then tool_use block (dispatches once natively).
		await processor.presentAssistantMessage()

		assert.equal(
			executeTool.callCount,
			1,
			`executeTool should fire exactly once via the native path, not twice. Got ${executeTool.callCount}`,
		)
		const call = executeTool.firstCall.args[0]
		assert.equal(call.name, "list_files")
		assert.equal(call.isNativeToolCall, true, "the single dispatch should come from the native tool_use block")
	})
})
