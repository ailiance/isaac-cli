import { strict as assert } from "node:assert"
import * as api from "@core/api"
import { IsaacToolSet } from "@core/prompts/system-prompt/registry/IsaacToolSet"
import type { TaskConfig } from "@core/task/tools/types/TaskConfig"
import { afterEach, describe, it } from "mocha"
import sinon from "sinon"
import { IsaacDefaultTool } from "@/shared/tools"
import { AgentConfigLoader } from "../AgentConfigLoader"
import { SUBAGENT_DEFAULT_ALLOWED_TOOLS, SUBAGENT_SYSTEM_SUFFIX, SubagentBuilder } from "../SubagentBuilder"

function createTaskConfig(mode: "act" | "plan", provider: string): TaskConfig {
	return {
		ulid: "ulid-123",
		services: {
			stateManager: {
				getGlobalSettingsKey: (key: string) => (key === "mode" ? mode : undefined),
				getApiConfiguration: () => ({
					actModeApiProvider: provider,
					planModeApiProvider: provider,
					actModeApiModelId: "act-default",
					planModeApiModelId: "plan-default",
					actModeOpenAiModelId: "openai-act-default",
					planModeOpenRouterModelId: "openrouter-plan-default",
				}),
			},
		},
	} as unknown as TaskConfig
}

describe("SubagentBuilder", () => {
	afterEach(() => {
		sinon.restore()
	})

	it("uses cached config by subagent name and applies act-mode provider model override", () => {
		sinon.stub(AgentConfigLoader, "getInstance").returns({
			getCachedConfig: (subagentName?: string) =>
				subagentName === "cached-agent"
					? {
							name: "cached-agent",
							description: "cached description",
							tools: [IsaacDefaultTool.LIST_FILES],
							modelId: "gpt-5",
							systemPrompt: "cached system prompt",
						}
					: undefined,
		} as unknown as AgentConfigLoader)

		const fakeHandler = { getModel: sinon.stub(), createMessage: sinon.stub() }
		const buildApiHandlerStub = sinon.stub(api, "buildApiHandler").returns(fakeHandler as never)

		const builder = new SubagentBuilder(createTaskConfig("act", "openai"), "cached-agent")

		assert.equal(buildApiHandlerStub.callCount, 1)
		const [effectiveApiConfig, selectedMode] = buildApiHandlerStub.firstCall.args
		assert.equal(selectedMode, "act")
		assert.equal((effectiveApiConfig as Record<string, unknown>).ulid, "ulid-123")
		assert.equal((effectiveApiConfig as Record<string, unknown>).actModeOpenAiModelId, "gpt-5")
		assert.equal((effectiveApiConfig as Record<string, unknown>).actModeApiModelId, "act-default")

		assert.deepEqual(builder.getAllowedTools(), [IsaacDefaultTool.LIST_FILES, IsaacDefaultTool.ATTEMPT])
		const prompt = builder.buildSystemPrompt("generated system prompt")
		assert.match(prompt, /# Agent Profile/)
		assert.match(prompt, /Name: cached-agent/)
		assert.match(prompt, /Description: cached description/)
		assert.match(prompt, /cached system prompt/)
		assert.match(prompt, new RegExp(SUBAGENT_SYSTEM_SUFFIX.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
	})

	it("uses defaults when no cached config is provided", () => {
		sinon.stub(AgentConfigLoader, "getInstance").returns({
			getCachedConfig: () => undefined,
		} as unknown as AgentConfigLoader)

		sinon.stub(api, "buildApiHandler").returns({ getModel: sinon.stub(), createMessage: sinon.stub() } as never)
		const builder = new SubagentBuilder(createTaskConfig("act", "anthropic"))

		assert.deepEqual(builder.getAllowedTools(), SUBAGENT_DEFAULT_ALLOWED_TOOLS)
		const prompt = builder.buildSystemPrompt("generated prompt")
		assert.equal(prompt, `generated prompt${SUBAGENT_SYSTEM_SUFFIX}`)
	})

	it("applies plan-mode openrouter model override fields", () => {
		sinon.stub(AgentConfigLoader, "getInstance").returns({
			getCachedConfig: (subagentName?: string) =>
				subagentName === "openrouter-agent"
					? {
							name: "openrouter-agent",
							description: "openrouter plan agent",
							tools: [IsaacDefaultTool.FILE_READ],
							modelId: "openrouter/custom-model",
							systemPrompt: "plan system",
						}
					: undefined,
		} as unknown as AgentConfigLoader)

		const buildApiHandlerStub = sinon.stub(api, "buildApiHandler").returns({
			getModel: sinon.stub(),
			createMessage: sinon.stub(),
		} as never)

		new SubagentBuilder(createTaskConfig("plan", "openrouter"), "openrouter-agent")

		const [effectiveApiConfig, selectedMode] = buildApiHandlerStub.firstCall.args
		assert.equal(selectedMode, "plan")
		assert.equal((effectiveApiConfig as Record<string, unknown>).planModeOpenRouterModelId, "openrouter/custom-model")
		assert.equal((effectiveApiConfig as Record<string, unknown>).planModeApiModelId, "plan-default")
		assert.equal((effectiveApiConfig as Record<string, unknown>).actModeApiModelId, "act-default")
	})

	it("builds native tools by converting all enabled tool specs", () => {
		sinon.stub(AgentConfigLoader, "getInstance").returns({
			getCachedConfig: (subagentName?: string) =>
				subagentName === "tools-agent"
					? {
							name: "tools-agent",
							description: "tool-limited",
							tools: [IsaacDefaultTool.LIST_FILES],
							modelId: "sonnet",
							systemPrompt: "tool prompt",
						}
					: undefined,
		} as unknown as AgentConfigLoader)
		sinon.stub(api, "buildApiHandler").returns({ getModel: sinon.stub(), createMessage: sinon.stub() } as never)

		const getEnabledToolSpecsStub = sinon.stub(IsaacToolSet, "getEnabledToolSpecs").returns([
			{
				id: IsaacDefaultTool.LIST_FILES,
				contextRequirements: () => true,
			},
			{
				id: IsaacDefaultTool.SEARCH,
				contextRequirements: () => true,
			},
		] as any)
		const converter = sinon.stub().callsFake((tool: { id: string }) => ({ converted: tool.id }))
		const getConverterStub = sinon.stub(IsaacToolSet, "getNativeConverter").returns(converter as never)

		const builder = new SubagentBuilder(createTaskConfig("act", "anthropic"), "tools-agent")

		const context = {
			providerInfo: {
				providerId: "anthropic",
				model: { id: "m1" },
			},
		} as never

		const result = builder.buildNativeTools(context)
		assert.equal(getEnabledToolSpecsStub.callCount, 1)
		assert.equal(getConverterStub.callCount, 1)
		// Subagents now receive all tools, so it should include both LIST_FILES and SEARCH
		assert.deepEqual(result, [{ converted: IsaacDefaultTool.LIST_FILES }, { converted: IsaacDefaultTool.SEARCH }])
	})
})
