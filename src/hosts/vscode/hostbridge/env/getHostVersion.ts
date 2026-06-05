import { EmptyRequest } from "@shared/proto/isaac/common"
import * as vscode from "vscode"
import { ExtensionRegistryInfo } from "@/registry"
import { IsaacClient } from "@/shared/dirac"
import { GetHostVersionResponse } from "@/shared/proto/index.host"

export async function getHostVersion(_: EmptyRequest): Promise<GetHostVersionResponse> {
	return {
		platform: vscode.env.appName,
		version: vscode.version,
		diracType: IsaacClient.VSCode,
		diracVersion: ExtensionRegistryInfo.version,
	}
}
