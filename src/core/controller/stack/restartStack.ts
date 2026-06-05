import { EmptyRequest } from "@shared/proto/isaac/common"
import { StackActionResult } from "@shared/proto/isaac/stack"
import { localStackManager } from "@/services/local-stack/LocalStackManager"
import type { Controller } from "../index"

/**
 * Restarts the local stack (stop then start).
 */
export async function restartStack(_controller: Controller, _request: EmptyRequest): Promise<StackActionResult> {
	const stopResult = await localStackManager.stop()
	if (!stopResult.ok) {
		return { ok: false, message: `Failed to stop stack: ${stopResult.msg}` }
	}
	const startResult = await localStackManager.start()
	const status = startResult.status
	return {
		ok: startResult.ok,
		message: startResult.msg,
		proxy: status?.proxy ? { running: status.proxy.running, url: status.proxy.url } : undefined,
		router: status?.router ? { running: status.router.running, url: status.router.url } : undefined,
	}
}
