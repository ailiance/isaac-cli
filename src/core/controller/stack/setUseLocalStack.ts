import { BooleanRequest, Empty } from "@shared/proto/isaac/common"
import type { Controller } from "../index"

/**
 * Enables or disables the useLocalStack setting.
 */
export async function setUseLocalStack(controller: Controller, request: BooleanRequest): Promise<Empty> {
	controller.stateManager.setGlobalState("useLocalStack", request.value)
	return {}
}
