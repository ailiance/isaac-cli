import type { StackPluginInfo } from "@shared/proto/isaac/stack"
import { useStackStore } from "../store/stackStore"

export function PluginsList() {
	const { snapshot } = useStackStore()
	const plugins: StackPluginInfo[] = snapshot?.plugins ?? []

	if (plugins.length === 0) {
		return (
			<p className="text-xs text-vscode-descriptionForeground italic">
				No plugins found. Install Claude Code plugins to see them here.
			</p>
		)
	}

	return (
		<div className="space-y-2">
			{plugins.map((plugin) => (
				<div key={plugin.name} className="rounded-md border border-vscode-panel-border p-3 space-y-1">
					<div className="text-sm font-medium text-vscode-foreground">{plugin.name}</div>
					<div className="flex gap-3 text-xs text-vscode-descriptionForeground">
						{plugin.skillsCount > 0 && <span>{plugin.skillsCount} skill(s)</span>}
						{plugin.commandsCount > 0 && <span>{plugin.commandsCount} command(s)</span>}
						{plugin.agentsCount > 0 && <span>{plugin.agentsCount} agent(s)</span>}
						{plugin.hooksCount > 0 && <span>{plugin.hooksCount} hook(s)</span>}
					</div>
					<div className="text-xs text-vscode-descriptionForeground truncate" title={plugin.path}>
						{plugin.path}
					</div>
				</div>
			))}
		</div>
	)
}
