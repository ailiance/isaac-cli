import { DiracMessage } from "@shared/ExtensionMessage"
import { DiffEditRow } from "../../DiffEditRow"
import { BaseToolOutputProps } from "./shared"
import { FileServiceClient } from "@/shared/api/grpc-client"
import { StringRequest } from "@shared/proto/dirac/common"

const handlePathClick = (path: string) => {
	FileServiceClient.openFileRelativePath(StringRequest.create({ value: path })).catch((err: any) =>
		console.error("Failed to open file:", err)
	)
}

interface EditFileOutputProps extends BaseToolOutputProps {
	message: DiracMessage
	backgroundEditEnabled?: boolean
}

export const EditFileOutput = ({ tool, unit, message, backgroundEditEnabled }: EditFileOutputProps) => {
	if (tool.tool === "editedExistingFile" || tool.tool === "newFileCreated") {
		return (
			<div className="flex flex-col gap-2">
				{tool.content && (
					<DiffEditRow
						hunks={unit.hunks}
						isLoading={message.partial}
						patch={tool.content}
						isHeadless={true}
						path={tool.path!}
						startLineNumbers={(tool as any).startLineNumbers}
					/>
				)}
			</div>
		)
	}

	if (tool.tool === "fileDeleted") {
		const diff = unit.content || tool.diff
		return (
			<div className="flex flex-col gap-1 min-w-0">
				{diff && (
					<div className="mt-1">
						<DiffEditRow hunks={unit.hunks} patch={diff} path={unit.path || tool.path!} isHeadless={true} />
					</div>
				)}
			</div>
		)
	}

	if (tool.tool === "editFile") {
		const diff = unit.content || tool.diff
		return (
			<div className="flex flex-col gap-1 min-w-0">
				{diff && (
					<div className="mt-1">
						<DiffEditRow hunks={unit.hunks} patch={diff} path={unit.path || tool.path!} isHeadless={true} />
					</div>
				)}
			</div>
		)
	}

	return null
}
