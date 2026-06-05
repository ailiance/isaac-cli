import { EmptyRequest } from "@shared/proto/isaac/common"
import { StackSnapshot } from "@shared/proto/isaac/stack"
import { stackMonitor } from "@/services/local-stack/StackMonitor"
import type { Controller } from "../index"

/**
 * Returns a full snapshot of the local stack state (proxy, router, models, routes, MCP servers, plugins, logs).
 */
export async function getStackSnapshot(controller: Controller, _request: EmptyRequest): Promise<StackSnapshot> {
	const enabledMcpServers = controller.stateManager.getGlobalSettingsKey("enabledMcpServers")
	const useLocalStack = controller.stateManager.getGlobalSettingsKey("useLocalStack") ?? false

	return stackMonitor.snapshot(enabledMcpServers, useLocalStack)
}
