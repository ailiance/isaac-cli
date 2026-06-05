import type { McpServerInfo } from "@shared/proto/isaac/stack"
import { StringArrayRequest } from "@shared/proto/isaac/common"
import { useState } from "react"
import { StackServiceClient } from "@/shared/api/grpc-client"
import { Switch } from "@/shared/ui/switch"
import { useStackStore } from "../store/stackStore"

interface McpServersListProps {
	onRefresh: () => void
}

export function McpServersList({ onRefresh }: McpServersListProps) {
	const { snapshot } = useStackStore()
	const servers: McpServerInfo[] = snapshot?.mcpServers ?? []
	const [saving, setSaving] = useState(false)

	async function handleToggle(serverId: string, enabled: boolean) {
		if (!snapshot) return
		setSaving(true)
		try {
			const current = servers.map((s) => ({ ...s, enabled: s.id === serverId ? enabled : s.enabled }))
			const enabledIds = current.filter((s) => s.enabled).map((s) => s.id)
			await StackServiceClient.setEnabledMcpServers(StringArrayRequest.create({ value: enabledIds }))
			onRefresh()
		} catch {
			// ignore
		} finally {
			setSaving(false)
		}
	}

	if (servers.length === 0) {
		return (
			<p className="text-xs text-vscode-descriptionForeground italic">
				No MCP servers discovered. Install Claude Code plugins with MCP server definitions.
			</p>
		)
	}

	return (
		<div className="space-y-2">
			{servers.map((server) => (
				<div key={server.id} className="flex items-center justify-between rounded-md border border-vscode-panel-border p-3">
					<div>
						<div className="text-sm font-medium text-vscode-foreground">{server.name}</div>
						<div className="text-xs text-vscode-descriptionForeground">
							{server.toolCount > 0 ? `${server.toolCount} tool(s)` : "ID: " + server.id}
						</div>
					</div>
					<Switch checked={server.enabled} onCheckedChange={(v) => handleToggle(server.id, v)} disabled={saving} />
				</div>
			))}
		</div>
	)
}
