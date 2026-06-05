import { Empty, StringArrayRequest } from "@shared/proto/isaac/common"
import type { Controller } from "../index"

/**
 * Updates the list of enabled MCP server IDs.
 */
export async function setEnabledMcpServers(controller: Controller, request: StringArrayRequest): Promise<Empty> {
	const ids = request.value.length > 0 ? request.value : undefined
	controller.stateManager.setGlobalState("enabledMcpServers", ids)
	return {}
}
