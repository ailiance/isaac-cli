import { CircleXIcon, HelpCircleIcon } from "lucide-react"
import { getIconForTool } from "../../utils/toolIcons"



export const getIconAndTitle = (type: string | undefined): [JSX.Element | null, JSX.Element | null] => {
	switch (type) {
		case "error": {
			const Icon = getIconForTool("error")
			return [
				<Icon className="text-error size-2" />,
				<span className="text-error font-bold">Error</span>,
			]
		}

		case "mistake_limit_reached":
			return [
				<CircleXIcon className="text-error size-2" />,
				<span className="text-error font-bold">Isaac is having trouble...</span>,
			]
		case "command": {
			const Icon = getIconForTool("executeCommand")
			return [
				<Icon className="text-foreground size-2" />,
				<span className="font-bold text-foreground">Isaac wants to execute:</span>,
			]
		}

		case "completion_result": {
			const Icon = getIconForTool("success")
			return [
				<Icon className="text-success size-2" />,
				<span className="text-success font-bold">Task Completed</span>,
			]
		}

		case "api_req_started":
			return [null, null]
		case "followup":
			return [
				<HelpCircleIcon className="text-foreground size-2" />,

				<span className="font-bold text-foreground">Isaac has a question:</span>,
			]
		default:
			return [null, null]
	}
}
