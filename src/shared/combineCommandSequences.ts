import { IsaacMessage, COMMAND_OUTPUT_STRING } from "./ExtensionMessage"

export function combineCommandSequences(messages: IsaacMessage[]): IsaacMessage[] {
	const combinedMessages: IsaacMessage[] = []

	for (let i = 0; i < messages.length; i++) {
		const currentMsg = messages[i]

		if (currentMsg.ask === "command" || currentMsg.say === "command") {
			// If it's already a MultiCommandState JSON, don't try to combine it again
			if (currentMsg.multiCommandState) {
				combinedMessages.push(currentMsg)
				continue
			}

			let combinedText = currentMsg.text || ""
			let didAddOutput = false
			let j = i + 1

			// Check if this is a multi-command tool call by looking ahead for more commands
			const commandsInSequence: Array<{
				command: string
				status: "pending" | "running" | "completed" | "failed" | "skipped"
				output?: string
			}> = []

			// If the current message is a command, start the sequence
			if (
				currentMsg.text &&
				!currentMsg.text.includes(COMMAND_OUTPUT_STRING) &&
				!currentMsg.multiCommandState
			) {
				commandsInSequence.push({
					command: currentMsg.text || "",
					status: currentMsg.ask === "command" ? "pending" : "completed",
				})
			}

			while (j < messages.length) {
				const nextMsg = messages[j]

				if (nextMsg.ask === "command" || nextMsg.say === "command") {
					// If it's another command, add it to our sequence if it doesn't have output yet
					if (nextMsg.text && !nextMsg.text.includes(COMMAND_OUTPUT_STRING) && !nextMsg.multiCommandState) {
						commandsInSequence.push({
							command: nextMsg.text,
							status: nextMsg.ask === "command" ? "pending" : "completed",
						})
						j++
						continue
					}
					// If it has output or is already a multi-command state, it's likely the start of a new execution sequence
					break
				}

				if (nextMsg.ask === "command_output" || nextMsg.say === "command_output") {
					if (!didAddOutput) {
						combinedText += `\n${COMMAND_OUTPUT_STRING}`
						didAddOutput = true
					}
					const output = nextMsg.text || ""
					if (output.length > 0) {
						combinedText += "\n" + output
					}
					j++
					continue
				}

				// Stop if we encounter any other type of message
				break
			}

			if (commandsInSequence.length > 1) {
				// We found multiple commands in a row, combine them into a MultiCommandState
				const multiCommandState = {
					commands: commandsInSequence.map((cmd) => ({
						...cmd,
						requiresApproval: cmd.status === "pending",
					})),
				}
				combinedMessages.push({
					...currentMsg,
					text: undefined,
					multiCommandState,
				})
			} else {
				// Just a single command (possibly with output)
				combinedMessages.push({
					...currentMsg,
					text: combinedText,
				})
			}

			i = j - 1
		} else {
			combinedMessages.push(currentMsg)
		}
	}

	return combinedMessages
}
