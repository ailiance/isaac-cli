import type { IsaacTool } from "@/shared/tools"
import { IsaacToolSet } from ".."
import { registerIsaacToolSets } from "../tools/init"
import type { SystemPromptContext } from "../types"
import { PromptBuilder } from "./PromptBuilder"

export class PromptRegistry {
	private static instance: PromptRegistry
	public nativeTools: IsaacTool[] | undefined = undefined

	private constructor() {
		registerIsaacToolSets()
	}

	static getInstance(): PromptRegistry {
		if (!PromptRegistry.instance) {
			PromptRegistry.instance = new PromptRegistry()
		}
		return PromptRegistry.instance
	}

	/**
	 * Get unified system prompt
	 */
	async get(context: SystemPromptContext): Promise<string> {
		this.nativeTools = IsaacToolSet.getNativeTools(context)

		const builder = new PromptBuilder(context)
		return await builder.build()
	}

	public static dispose(): void {
		PromptRegistry.instance = null as unknown as PromptRegistry
	}
}
