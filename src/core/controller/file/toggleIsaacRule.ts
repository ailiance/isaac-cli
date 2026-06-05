import { getWorkspaceBasename } from "@core/workspace"
import type { ToggleIsaacRuleRequest } from "@shared/proto/isaac/file"
import { RuleScope, ToggleIsaacRules } from "@shared/proto/isaac/file"
import { telemetryService } from "@/services/telemetry"
import { Logger } from "@/shared/services/Logger"
import type { Controller } from "../index"

/**
 * Toggles a Isaac rule (enable or disable)
 * @param controller The controller instance
 * @param request The toggle request
 * @returns The updated Isaac rule toggles
 */
export async function toggleIsaacRule(controller: Controller, request: ToggleIsaacRuleRequest): Promise<ToggleIsaacRules> {
	const { scope, rulePath, enabled } = request

	if (!rulePath || typeof enabled !== "boolean" || scope === undefined) {
		Logger.error("toggleIsaacRule: Missing or invalid parameters", {
			rulePath,
			scope,
			enabled: typeof enabled === "boolean" ? enabled : `Invalid: ${typeof enabled}`,
		})
		throw new Error("Missing or invalid parameters for toggleIsaacRule")
	}

	// Handle the three different scopes
	switch (scope) {
		case RuleScope.GLOBAL: {
			const toggles = controller.stateManager.getGlobalSettingsKey("globalDiracRulesToggles")
			toggles[rulePath] = enabled
			controller.stateManager.setGlobalState("globalDiracRulesToggles", toggles)
			break
		}
		case RuleScope.LOCAL: {
			const toggles = controller.stateManager.getWorkspaceStateKey("localDiracRulesToggles")
			toggles[rulePath] = enabled
			controller.stateManager.setWorkspaceState("localDiracRulesToggles", toggles)
			break
		}
		case RuleScope.REMOTE: {
			const toggles = controller.stateManager.getGlobalStateKey("remoteRulesToggles")
			toggles[rulePath] = enabled
			controller.stateManager.setGlobalState("remoteRulesToggles", toggles)
			break
		}
		default:
			throw new Error(`Invalid scope: ${scope}`)
	}

	// Track rule toggle telemetry with current task context
	if (controller.task?.ulid) {
		// Extract just the filename for privacy (no full paths)
		const ruleFileName = getWorkspaceBasename(rulePath, "Controller.toggleIsaacRule")
		const isGlobal = scope === RuleScope.GLOBAL
		telemetryService.captureIsaacRuleToggled(controller.task.ulid, ruleFileName, enabled, isGlobal)
	}

	// Get the current state to return in the response
	const globalToggles = controller.stateManager.getGlobalSettingsKey("globalDiracRulesToggles")
	const localToggles = controller.stateManager.getWorkspaceStateKey("localDiracRulesToggles")
	const remoteToggles = controller.stateManager.getGlobalStateKey("remoteRulesToggles")

	return ToggleIsaacRules.create({
		globalDiracRulesToggles: { toggles: globalToggles },
		localDiracRulesToggles: { toggles: localToggles },
		remoteRulesToggles: { toggles: remoteToggles },
	})
}
