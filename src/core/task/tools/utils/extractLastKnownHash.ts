import path from "node:path"
import { arePathsEqual } from "@utils/path"
import type { DiracAssistantToolUseBlock, DiracStorageMessage, DiracUserToolResultContentBlock } from "@/shared/messages"
import { DiracDefaultTool } from "@/shared/tools"

/**
 * Walks the API conversation history backwards looking for the most recent
 * `read_file` call that targeted `targetPath`, then extracts the
 * `[File Hash: ...]` marker emitted by ReadFileToolHandler in the
 * corresponding tool_result. Returns the FNV-1a hex hash, or undefined when
 * no prior read is recorded for the path (legacy histories, fresh sessions,
 * or paths that were never read).
 *
 * Shared by ReadFileToolHandler (used to short-circuit re-reads of unchanged
 * files) and BatchProcessor (used to detect stale anchors before running an
 * edit_file). Behaviour is intentionally identical between callers — see
 * Sprint 3 task E for the rationale.
 */
export function extractLastKnownHashFromHistory(
	history: DiracStorageMessage[],
	targetPath: string,
	toolName: string = DiracDefaultTool.FILE_READ,
): string | undefined {
	const normalizeForComparison = (value: string): string => {
		const normalized = path.normalize(value)
		return normalized.startsWith(`.${path.sep}`) ? normalized.slice(2) : normalized
	}

	const doesPathMatch = (candidatePath: unknown): candidatePath is string => {
		if (typeof candidatePath !== "string") {
			return false
		}
		return (
			candidatePath === targetPath ||
			arePathsEqual(candidatePath, targetPath) ||
			normalizeForComparison(candidatePath) === normalizeForComparison(targetPath)
		)
	}

	for (let i = history.length - 1; i >= 0; i--) {
		const message = history[i]
		if (message.role !== "assistant" || !Array.isArray(message.content)) {
			continue
		}

		for (const block of message.content) {
			if (block.type !== "tool_use") {
				continue
			}
			const toolUseBlock = block as unknown as DiracAssistantToolUseBlock
			if (toolUseBlock.name !== toolName) {
				continue
			}
			const input = toolUseBlock.input as any
			const matchingPath = [input?.path, ...(Array.isArray(input?.paths) ? input.paths : [])].find((c) => doesPathMatch(c))
			if (!matchingPath) {
				continue
			}
			const toolUseId = toolUseBlock.id
			const nextMessage = history[i + 1]
			if (!nextMessage || nextMessage.role !== "user" || !Array.isArray(nextMessage.content)) {
				continue
			}
			const resultBlock = nextMessage.content.find(
				(c) => c.type === "tool_result" && (c as unknown as DiracUserToolResultContentBlock).tool_use_id === toolUseId,
			)
			if (!resultBlock || resultBlock.type !== "tool_result") {
				continue
			}
			const text =
				typeof resultBlock.content === "string"
					? resultBlock.content
					: Array.isArray(resultBlock.content)
						? (resultBlock.content.find((c: any) => c.type === "text") as any)?.text
						: undefined
			if (!text) {
				continue
			}
			let sectionText: string = text
			if (text.includes(`--- ${matchingPath} ---`)) {
				const parts = text.split(`--- ${matchingPath} ---`)
				if (parts.length > 1) {
					sectionText = parts[1].split("\n--- ")[0]
				}
			}
			const match = sectionText.match(/\[File Hash: ([a-f0-9]+)\]/)
			if (match) {
				return match[1]
			}
		}
	}
	return undefined
}
