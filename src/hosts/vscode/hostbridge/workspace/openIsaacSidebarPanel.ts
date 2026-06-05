import * as vscode from "vscode"
import { ExtensionRegistryInfo } from "@/registry"
import { OpenIsaacSidebarPanelRequest, OpenIsaacSidebarPanelResponse } from "@/shared/proto/index.host"

export async function openIsaacSidebarPanel(_: OpenIsaacSidebarPanelRequest): Promise<OpenIsaacSidebarPanelResponse> {
	await vscode.commands.executeCommand(`${ExtensionRegistryInfo.views.Sidebar}.focus`)
	return {}
}
