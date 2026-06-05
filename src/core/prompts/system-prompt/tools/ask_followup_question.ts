import { IsaacDefaultTool } from "@/shared/tools"
import type { IsaacToolSpec } from "../spec"
import type { ParamNames } from "../tool-unit"

const id = IsaacDefaultTool.ASK

export const ask_followup_question = {
	id,
	name: "ask_followup_question",
	description: "Asks the user a clarifying question when you encounter ambiguities or need more details.",
	parameters: [
		{
			name: "question",
			required: true,
			instruction: "The question to ask the user.",
			usage: "Your question here",
		},
		{
			name: "options",
			required: false,
			instruction: "Optional array of 2-5 predefined answer options. DO NOT include options to toggle Act mode.",
			usage: '["Option 1", "Option 2"]',
		},
	],
} as const satisfies IsaacToolSpec

/**
 * Lot E: typed param-name union derived from the spec literal above.
 * The handler reads the scalar `question`/`options` params through this contract;
 * a rename/removal of a spec parameter changes this union and breaks the handler
 * compile (kills drift).
 */
export type AskFollowupQuestionParam = ParamNames<typeof ask_followup_question>

export const ask_followup_question_variants = [ask_followup_question]
