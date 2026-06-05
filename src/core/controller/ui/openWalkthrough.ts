import type { EmptyRequest } from "@shared/proto/isaac/common"
import { Empty } from "@shared/proto/isaac/common"
import * as vscode from "vscode"
import { ExtensionRegistryInfo } from "@/registry"
import { telemetryService } from "@/services/telemetry"
import { Logger } from "@/shared/services/Logger"
import type { Controller } from "../index"

/**
 * Opens the Isaac walkthrough in VSCode
 * @param controller The controller instance
 * @param request Empty request
 * @returns Empty response
 */
export async function openWalkthrough(_controller: Controller, _request: EmptyRequest): Promise<Empty> {
	try {
		// ailiance-agent fork: walkthrough id rebrand
		await vscode.commands.executeCommand(
			"workbench.action.openWalkthrough",
			`dirac-run.${ExtensionRegistryInfo.name}#AgentKikiWalkthrough`,
		)
		telemetryService.captureButtonClick("webview_openWalkthrough")
		return Empty.create({})
	} catch (error) {
		Logger.error(`Failed to open walkthrough: ${error}`)
		throw error
	}
}
