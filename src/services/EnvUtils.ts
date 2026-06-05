import { isMultiRootWorkspace } from "@/core/workspace/utils/workspace-detection"
import { HostProvider } from "@/hosts/host-provider"
import { ExtensionRegistryInfo } from "@/registry"
import { EmptyRequest } from "@/shared/proto/isaac/common"
import { Logger } from "@/shared/services/Logger"

// Canonical header names for extra client/host context
export const IsaacHeaders = {
	PLATFORM: "X-PLATFORM",
	PLATFORM_VERSION: "X-PLATFORM-VERSION",
	CLIENT_VERSION: "X-CLIENT-VERSION",
	CLIENT_TYPE: "X-CLIENT-TYPE",
	CORE_VERSION: "X-CORE-VERSION",
	IS_MULTIROOT: "X-IS-MULTIROOT",
} as const
export type IsaacHeaderName = (typeof IsaacHeaders)[keyof typeof IsaacHeaders]

export function buildExternalBasicHeaders(): Record<string, string> {
	return {
		"User-Agent": `Isaac/${ExtensionRegistryInfo.version}`,
	}
}

export async function buildBasicIsaacHeaders(): Promise<Record<string, string>> {
	const headers: Record<string, string> = buildExternalBasicHeaders()
	try {
		const host = await HostProvider.env.getHostVersion(EmptyRequest.create({}))
		headers[IsaacHeaders.PLATFORM] = host.platform || "unknown"
		headers[IsaacHeaders.PLATFORM_VERSION] = host.version || "unknown"
		headers[IsaacHeaders.CLIENT_TYPE] = host.diracType || "unknown"
		headers[IsaacHeaders.CLIENT_VERSION] = host.diracVersion || "unknown"
	} catch (error) {
		Logger.log("Failed to get IDE/platform info via HostBridge EnvService.getHostVersion", error)
		headers[IsaacHeaders.PLATFORM] = "unknown"
		headers[IsaacHeaders.PLATFORM_VERSION] = "unknown"
		headers[IsaacHeaders.CLIENT_TYPE] = "unknown"
		headers[IsaacHeaders.CLIENT_VERSION] = "unknown"
	}
	headers[IsaacHeaders.CORE_VERSION] = ExtensionRegistryInfo.version

	return headers
}

export async function buildIsaacExtraHeaders(): Promise<Record<string, string>> {
	const headers = await buildBasicIsaacHeaders()

	try {
		const isMultiRoot = await isMultiRootWorkspace()
		headers[IsaacHeaders.IS_MULTIROOT] = isMultiRoot ? "true" : "false"
	} catch (error) {
		Logger.log("Failed to detect multi-root workspace", error)
		headers[IsaacHeaders.IS_MULTIROOT] = "false"
	}

	return headers
}
