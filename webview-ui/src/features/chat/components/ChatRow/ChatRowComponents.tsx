import { IsaacSayTool } from "@shared/ExtensionMessage"
import { LoaderCircleIcon } from "lucide-react"

export const ProgressIndicator = () => <LoaderCircleIcon className="size-2 mr-2 animate-spin" />

export const InvisibleSpacer = () => <div aria-hidden className="h-px" />


// not used presently
export const DebugToolRow = ({ tool }: { tool: IsaacSayTool }) => (
	<div className="bg-code border border-editor-group-border rounded-sm p-2 text-xs font-mono">
		<div className="text-warning font-bold mb-1 underline">DEBUG: Unknown Tool Output</div>
		<pre className="whitespace-pre-wrap">{JSON.stringify(tool, null, 2)}</pre>
	</div>
)
