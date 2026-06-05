import type { IsaacMessage } from "@shared/ExtensionMessage"
import { render } from "ink-testing-library"
import React from "react"
import { describe, expect, it, vi } from "vitest"
import { ChatMessage } from "./ChatMessage"

vi.mock("../hooks/useTerminalSize", () => ({
	useTerminalSize: () => ({
		columns: 120,
		rows: 40,
		resizeKey: 0,
	}),
}))

describe("ChatMessage subagent rendering", () => {
	it("renders subagent approval prompts as a tree", () => {
		const message: IsaacMessage = {
			ts: Date.now(),
			type: "ask",
			ask: "use_subagents",
			text: JSON.stringify({
				prompts: [
					"Find codebase stats and size",
					"Find funny comments and easter eggs",
					"Find unusual patterns and history",
				],
			}),
		}

		const { lastFrame } = render(React.createElement(ChatMessage, { message, mode: "act" }))
		const frame = lastFrame() || ""

		expect(frame).toContain("ISAAC wants to run subagents")
		expect(frame).toContain("├─   Find codebase stats and size")
		expect(frame).toContain("├─   Find funny comments and easter eggs")
		expect(frame).toContain("└─   Find unusual patterns and history")
	})

	it("renders subagent progress rows with compact token stats and completion checks", () => {
		const message: IsaacMessage = {
			ts: Date.now(),
			type: "say",
			say: "subagent",
			text: JSON.stringify({
				status: "running",
				total: 3,
				completed: 1,
				successes: 1,
				failures: 0,
				toolCalls: 21,
				inputTokens: 0,
				outputTokens: 0,
				contextWindow: 0,
				maxContextTokens: 0,
				maxContextUsagePercentage: 0,
				items: [
					{
						index: 1,
						prompt: "Find codebase stats and size",
						status: "completed",
						toolCalls: 5,
						inputTokens: 0,
						outputTokens: 0,
						totalCost: 0.034,
						contextTokens: 24400,
						contextWindow: 200000,
						contextUsagePercentage: 12.2,
					},
					{
						index: 2,
						prompt: "Find funny comments and easter eggs",
						status: "running",
						toolCalls: 11,
						inputTokens: 0,
						outputTokens: 0,
						totalCost: 0.056,
						contextTokens: 31600,
						contextWindow: 200000,
						contextUsagePercentage: 15.8,
					},
					{
						index: 3,
						prompt: "Find unusual patterns and history",
						status: "pending",
						toolCalls: 5,
						inputTokens: 0,
						outputTokens: 0,
						totalCost: 0,
						contextTokens: 28900,
						contextWindow: 200000,
						contextUsagePercentage: 14.4,
					},
				],
			}),
		}

		const { lastFrame } = render(React.createElement(ChatMessage, { isStreaming: true, message, mode: "act" }))
		const frame = lastFrame() || ""

		expect(frame).toContain("ISAAC is running subagents")
		expect(frame).toContain("✓ Find codebase stats and size")
		expect(frame).toContain("5 tool uses · 24.4k tokens · $0.03")
		expect(frame).toContain("11 tool uses · 31.6k tokens · $0.06")
		expect(frame).toContain("5 tool uses · 28.9k tokens · $0.00")
	})
})

describe("ChatMessage reasoning rendering", () => {
	it("renders the reasoning (chain-of-thought) text instead of hiding it", () => {
		const message: IsaacMessage = {
			ts: Date.now(),
			type: "say",
			say: "reasoning",
			text: "Let me first inspect the failing test before editing.",
		}
		const { lastFrame } = render(React.createElement(ChatMessage, { message, mode: "act" }))
		const frame = lastFrame() || ""
		expect(frame).toContain("Let me first inspect the failing test before editing.")
	})

	it("renders streaming reasoning while partial", () => {
		const message: IsaacMessage = {
			ts: Date.now(),
			type: "say",
			say: "reasoning",
			text: "Thinking through the approach",
			partial: true,
		}
		const { lastFrame } = render(React.createElement(ChatMessage, { message, mode: "act", isStreaming: true }))
		expect(lastFrame() || "").toContain("Thinking through the approach")
	})

	it("renders nothing for empty reasoning", () => {
		const message: IsaacMessage = { ts: Date.now(), type: "say", say: "reasoning", text: "   " }
		const { lastFrame } = render(React.createElement(ChatMessage, { message, mode: "act" }))
		expect((lastFrame() || "").trim()).toBe("")
	})
})

describe("ChatMessage activity journal", () => {
	it("shows the queried model for api_req_started", () => {
		const message = {
			ts: Date.now(),
			type: "say",
			say: "api_req_started",
			text: "{}",
			modelInfo: { modelId: "ailiance-reasoning-r1" },
		} as unknown as IsaacMessage
		const { lastFrame } = render(React.createElement(ChatMessage, { message, mode: "act" }))
		expect(lastFrame() || "").toContain("querying ailiance-reasoning-r1")
	})

	it("shows a checkpoint marker", () => {
		const message: IsaacMessage = { ts: Date.now(), type: "say", say: "checkpoint_created" }
		const { lastFrame } = render(React.createElement(ChatMessage, { message, mode: "act" }))
		expect(lastFrame() || "").toContain("checkpoint saved")
	})

	it("shows a retry marker", () => {
		const message: IsaacMessage = { ts: Date.now(), type: "say", say: "api_req_retried" }
		const { lastFrame } = render(React.createElement(ChatMessage, { message, mode: "act" }))
		expect(lastFrame() || "").toContain("retrying")
	})
})
