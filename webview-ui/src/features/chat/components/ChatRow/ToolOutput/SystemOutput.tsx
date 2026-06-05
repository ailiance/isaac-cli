import { IsaacMessage } from "@shared/ExtensionMessage"
import { BaseToolOutputProps } from "./shared"

interface SystemOutputProps extends BaseToolOutputProps {
	message: IsaacMessage
}

export const SystemOutput = ({ tool, isExpanded, onToggleExpand, message }: SystemOutputProps) => {
	switch (tool.tool) {
		case "summarizeTask":
		case "subagent":
			return (
				<div className="bg-code overflow-hidden border border-editor-group-border rounded-[3px]">
					<div className="text-description py-2 px-2.5 select-text">
						<span className="ph-no-capture break-words whitespace-pre-wrap">{tool.content}</span>
					</div>
				</div>
			)



		case "useSkill":
			return (
				<div className="bg-code border border-editor-group-border overflow-hidden rounded-xs py-[9px] px-2.5">
					<span className="ph-no-capture font-medium">{tool.path}</span>
				</div>
			)

		case "listSkills":
			return (
				<div className="bg-code overflow-hidden border border-editor-group-border rounded-[3px]">
					<div className="text-description py-2 px-2.5 select-text">
						<span className="ph-no-capture break-words whitespace-pre-wrap">{tool.content}</span>
					</div>
				</div>
			)

		case "diagnosticsScan":
		case "diagnostics_scan":
			return (
				<div className="bg-code overflow-hidden border border-editor-group-border rounded-[3px]">
					<div className="text-description py-2 px-2.5 select-text">
						<span className="ph-no-capture break-words whitespace-pre-wrap">{tool.content}</span>
					</div>
				</div>
			)

		default:
			return null
	}
}
