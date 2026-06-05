import { LiteLlmHandler } from "@core/api/providers/litellm"
import { StateManager } from "@core/storage/StateManager"
import { expect } from "chai"
import sinon from "sinon"
import * as instanceModule from "@/services/local-router/instance"
import type { LocalRouter } from "@/services/local-router/LocalRouter"
import { IsaacStorageMessage } from "@/shared/messages/content"
import { mockFetchForTesting } from "@/shared/net"

// Minimal fake LocalRouter
function makeFakeRouter(streamChunks?: string[], streamError?: Error): LocalRouter {
	async function* fakeStream() {
		if (streamError) throw streamError
		for (const text of streamChunks ?? ["local response"]) {
			yield { type: "text" as const, text }
		}
	}
	const router: Partial<LocalRouter> = {
		start: sinon.stub(),
		dispose: sinon.stub(),
		chat: sinon.stub().rejects(new Error("chat() should not be called — use chatStream()")),
		chatStream: sinon.stub().callsFake(fakeStream),
		pickWorker: sinon.stub().returns(null),
	}
	return router as LocalRouter
}

describe("LiteLlmHandler — LocalRouter integration", () => {
	const mockFetch = sinon.stub()
	let doneMockingFetch: (value: any) => void = () => {}
	let getLocalRouterStub: sinon.SinonStub
	let resetStub: sinon.SinonStub

	const fakeOpenAIClient = {
		chat: {
			completions: {
				create: sinon.stub(),
			},
		},
		baseURL: "https://fake.example",
	}

	beforeEach(() => {
		fakeOpenAIClient.chat.completions.create.resetHistory()
		mockFetch.reset()

		const stateManagerStub = sinon.createStubInstance(StateManager)
		stateManagerStub.getModelInfo.returns(undefined)
		sinon.stub(StateManager, "get").returns(stateManagerStub as any)

		// Mock fetch: model info endpoint returns empty data (no prompt caching)
		mockFetch.resolves({
			ok: true,
			json: () => Promise.resolve({ data: [] }),
		})

		mockFetchForTesting(mockFetch, () => {
			return new Promise((resolve) => {
				doneMockingFetch = resolve
			})
		})

		// Default: HTTP proxy path returns a minimal streaming response
		fakeOpenAIClient.chat.completions.create.resolves({
			[Symbol.asyncIterator]: async function* () {
				yield { choices: [{ delta: { content: "http response" } }] }
				yield { choices: [{}], usage: { prompt_tokens: 5, completion_tokens: 5 } }
			},
		})
	})

	afterEach(() => {
		sinon.restore()
		doneMockingFetch(void 0)
		instanceModule.__resetLocalRouterForTest()
	})

	describe("useLocalRouter: false (default)", () => {
		it("uses HTTP proxy when useLocalRouter is not set", async () => {
			const handler = new LiteLlmHandler({
				liteLlmApiKey: "test-key",
				liteLlmBaseUrl: "http://localhost:4000",
				liteLlmModelId: "some-model",
			})
			sinon.stub(handler, "ensureClient" as any).returns(fakeOpenAIClient)

			const messages: IsaacStorageMessage[] = [{ role: "user", content: "hello" }]
			const chunks = []
			for await (const chunk of handler.createMessage("system", messages)) {
				chunks.push(chunk)
			}

			sinon.assert.calledOnce(fakeOpenAIClient.chat.completions.create)
			expect(chunks.some((c) => c.type === "text" && c.text === "http response")).to.be.true
		})
	})

	describe("useLocalRouter: true", () => {
		it("calls localRouter.chatStream() instead of HTTP proxy for text-only messages", async () => {
			const fakeRouter = makeFakeRouter()
			getLocalRouterStub = sinon.stub(instanceModule, "getLocalRouter").returns(fakeRouter)

			const handler = new LiteLlmHandler({
				liteLlmApiKey: "test-key",
				liteLlmBaseUrl: "http://localhost:4000",
				liteLlmModelId: "some-model",
				useLocalRouter: true,
			})

			const messages: IsaacStorageMessage[] = [{ role: "user", content: "hello" }]
			const chunks = []
			for await (const chunk of handler.createMessage("system", messages)) {
				chunks.push(chunk)
			}

			sinon.assert.calledOnce(fakeRouter.chatStream as sinon.SinonStub)
			sinon.assert.notCalled(fakeOpenAIClient.chat.completions.create)

			const textChunks = chunks.filter((c) => c.type === "text")
			expect(textChunks).to.have.length(1)
			expect((textChunks[0] as any).text).to.equal("local response")

			const usageChunks = chunks.filter((c) => c.type === "usage")
			expect(usageChunks).to.have.length(1)
			expect((usageChunks[0] as any).inputTokens).to.equal(0)
			expect((usageChunks[0] as any).outputTokens).to.equal(0)
		})

		it("passes systemPrompt and messages to localRouter.chatStream()", async () => {
			const fakeRouter = makeFakeRouter()
			sinon.stub(instanceModule, "getLocalRouter").returns(fakeRouter)

			const handler = new LiteLlmHandler({
				liteLlmApiKey: "test-key",
				liteLlmBaseUrl: "http://localhost:4000",
				liteLlmModelId: "some-model",
				useLocalRouter: true,
			})

			const messages: IsaacStorageMessage[] = [
				{ role: "user", content: "what is 2+2?" },
				{ role: "assistant", content: "4" },
				{ role: "user", content: "thanks" },
			]
			for await (const _ of handler.createMessage("be helpful", messages)) {
			}

			const callArg = (fakeRouter.chatStream as sinon.SinonStub).getCall(0).args[0]
			expect(callArg.messages[0]).to.deep.equal({ role: "system", content: "be helpful" })
			expect(callArg.messages[1]).to.deep.equal({ role: "user", content: "what is 2+2?" })
			expect(callArg.messages[2]).to.deep.equal({ role: "assistant", content: "4" })
			expect(callArg.stream).to.equal(true)
		})

		it("falls back to HTTP proxy when localRouter.chatStream() throws", async () => {
			const fakeRouter = makeFakeRouter(undefined, new Error("no worker available"))
			sinon.stub(instanceModule, "getLocalRouter").returns(fakeRouter)

			const handler = new LiteLlmHandler({
				liteLlmApiKey: "test-key",
				liteLlmBaseUrl: "http://localhost:4000",
				liteLlmModelId: "some-model",
				useLocalRouter: true,
			})
			sinon.stub(handler, "ensureClient" as any).returns(fakeOpenAIClient)

			const messages: IsaacStorageMessage[] = [{ role: "user", content: "hello" }]
			const chunks = []
			for await (const chunk of handler.createMessage("system", messages)) {
				chunks.push(chunk)
			}

			sinon.assert.calledOnce(fakeRouter.chatStream as sinon.SinonStub)
			sinon.assert.calledOnce(fakeOpenAIClient.chat.completions.create)

			const textChunks = chunks.filter((c) => c.type === "text")
			expect(textChunks.some((c) => (c as any).text === "http response")).to.be.true
		})

		it("skips LocalRouter for messages with non-text content and uses HTTP proxy", async () => {
			const fakeRouter = makeFakeRouter()
			sinon.stub(instanceModule, "getLocalRouter").returns(fakeRouter)

			const handler = new LiteLlmHandler({
				liteLlmApiKey: "test-key",
				liteLlmBaseUrl: "http://localhost:4000",
				liteLlmModelId: "some-model",
				useLocalRouter: true,
			})
			sinon.stub(handler, "ensureClient" as any).returns(fakeOpenAIClient)

			// Message with image block → non-text, should skip LocalRouter
			const messages: IsaacStorageMessage[] = [
				{
					role: "user",
					content: [{ type: "image", source: { type: "base64", mediaType: "image/png", data: "abc" } }] as any,
				},
			]
			for await (const _ of handler.createMessage("system", messages)) {
			}

			sinon.assert.notCalled(fakeRouter.chatStream as sinon.SinonStub)
			sinon.assert.calledOnce(fakeOpenAIClient.chat.completions.create)
		})
	})
})
