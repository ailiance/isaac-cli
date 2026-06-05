import { EmptyRequest } from "@shared/proto/isaac/common"
import { StackActionResult } from "@shared/proto/isaac/stack"
import { localStackManager } from "@/services/local-stack/LocalStackManager"
import type { Controller } from "../index"

/**
 * Starts the local stack (LiteLLM proxy + Jina router).
 */
export async function startStack(_controller: Controller, _request: EmptyRequest): Promise<StackActionResult> {
	const result = await localStackManager.start()
	const status = result.status
	return {
		ok: result.ok,
		message: result.msg,
		proxy: status?.proxy ? { running: status.proxy.running, url: status.proxy.url } : undefined,
		router: status?.router ? { running: status.router.running, url: status.router.url } : undefined,
	}
}
