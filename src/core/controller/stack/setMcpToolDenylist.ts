import { Empty, StringArrayRequest } from "@shared/proto/isaac/common"
import type { Controller } from "../index"

/**
 * Updates the MCP tool denylist.
 */
export async function setMcpToolDenylist(controller: Controller, request: StringArrayRequest): Promise<Empty> {
	const list = request.value.length > 0 ? request.value : undefined
	controller.stateManager.setGlobalState("mcpToolDenylist", list)
	return {}
}
