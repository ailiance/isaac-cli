import { Empty, StringArrayRequest } from "@shared/proto/isaac/common"
import type { Controller } from "../index"

/**
 * Updates the MCP tool allowlist.
 */
export async function setMcpToolAllowlist(controller: Controller, request: StringArrayRequest): Promise<Empty> {
	const list = request.value.length > 0 ? request.value : undefined
	controller.stateManager.setGlobalState("mcpToolAllowlist", list)
	return {}
}
