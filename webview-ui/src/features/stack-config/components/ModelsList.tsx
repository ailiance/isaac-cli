import type { StackModel } from "@shared/proto/isaac/stack"
import { CheckCircle2, XCircle } from "lucide-react"
import { useStackStore } from "../store/stackStore"

export function ModelsList() {
	const { snapshot } = useStackStore()
	const models: StackModel[] = snapshot?.models ?? []

	if (models.length === 0) {
		return (
			<p className="text-xs text-vscode-descriptionForeground italic">
				No models found. Ensure the LiteLLM proxy is configured (~/.isaac/litellm/config.yaml).
			</p>
		)
	}

	return (
		<div className="space-y-1">
			{models.map((model) => (
				<div key={model.name} className="flex items-center gap-2 rounded-sm px-2 py-1 hover:bg-vscode-list-hoverBackground">
					{model.reachable ? (
						<CheckCircle2 className="h-3 w-3 flex-shrink-0 text-vscode-testing-iconPassed" />
					) : (
						<XCircle className="h-3 w-3 flex-shrink-0 text-vscode-descriptionForeground" />
					)}
					<span className="text-sm text-vscode-foreground">{model.name}</span>
					{!model.reachable && (
						<span className="ml-auto text-xs text-vscode-descriptionForeground">proxy down</span>
					)}
				</div>
			))}
		</div>
	)
}
