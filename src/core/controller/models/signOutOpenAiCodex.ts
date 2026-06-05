import { Empty, EmptyRequest } from "@shared/proto/isaac/common"
import { openAiCodexOAuthManager } from "@/integrations/openai-codex/oauth"
import { Logger } from "@/shared/services/Logger"
import type { Controller } from "../index"

/**
 * Signs out from OpenAI Codex
 * @param controller The controller instance
 * @param _request The empty request
 * @returns Empty response
 */
export async function signOutOpenAiCodex(controller: Controller, _request: EmptyRequest): Promise<Empty> {
	try {
		Logger.log("[openai-codex-oauth] Signing out...")
		await openAiCodexOAuthManager.clearCredentials()

		// Post updated state to webview
		await controller.postStateToWebview()

		return Empty.create({})
	} catch (error) {
		Logger.error("[openai-codex-oauth] Sign out failed:", error)
		throw error
	}
}
