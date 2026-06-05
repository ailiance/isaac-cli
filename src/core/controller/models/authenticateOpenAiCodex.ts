import { Empty, EmptyRequest } from "@shared/proto/isaac/common"
import { openAiCodexOAuthManager } from "@/integrations/openai-codex/oauth"
import { openExternal } from "@/utils/env"
import { Logger } from "@/shared/services/Logger"
import type { Controller } from "../index"

/**
 * Authenticates with OpenAI Codex (ChatGPT subscription)
 * @param controller The controller instance
 * @param _request The empty request
 * @returns Empty response
 */
export async function authenticateOpenAiCodex(controller: Controller, _request: EmptyRequest): Promise<Empty> {
	try {
		Logger.log("[openai-codex-oauth] Starting authentication flow...")

		// 1. Start the authorization flow and get the URL
		const authUrl = openAiCodexOAuthManager.startAuthorizationFlow()

		// 2. Open the URL in the user's browser
		await openExternal(authUrl)

		// 3. Wait for the callback (this will block until auth is complete or times out)
		Logger.log("[openai-codex-oauth] Waiting for browser callback...")
		await openAiCodexOAuthManager.waitForCallback()

		Logger.log("[openai-codex-oauth] Authentication successful!")

		// 4. Post updated state to webview so it knows we're authenticated
		await controller.postStateToWebview()

		return Empty.create({})
	} catch (error) {
		Logger.error("[openai-codex-oauth] Authentication failed:", error)
		throw error
	}
}
