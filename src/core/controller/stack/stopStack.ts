import { EmptyRequest } from "@shared/proto/isaac/common"
import { StackActionResult } from "@shared/proto/isaac/stack"
import { localStackManager } from "@/services/local-stack/LocalStackManager"
import type { Controller } from "../index"

/**
 * Stops the local stack (Jina router + LiteLLM proxy).
 */
export async function stopStack(_controller: Controller, _request: EmptyRequest): Promise<StackActionResult> {
	const result = await localStackManager.stop()
	return {
		ok: result.ok,
		message: result.msg,
		proxy: undefined,
		router: undefined,
	}
}
