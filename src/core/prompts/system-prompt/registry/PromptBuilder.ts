import { SkillMetadata } from "@/shared/skills"
import { formatMemoriesSection, loadRelevantMemories } from "@/utils/ailiance-memory"
import { SYSTEM_PROMPT } from "../template"
import { TemplateEngine } from "../templates/TemplateEngine"
import type { SystemPromptContext } from "../types"
import { selectMemoryRanker } from "./memoryRanker"

export class PromptBuilder {
	private templateEngine: TemplateEngine

	constructor(private context: SystemPromptContext) {
		this.templateEngine = new TemplateEngine()
	}

	async build(): Promise<string> {
		const promptTemplate = SYSTEM_PROMPT(this.context)
		const placeholders = await this.preparePlaceholders()
		const prompt = this.templateEngine.resolve(promptTemplate, this.context, placeholders)
		return this.postProcess(prompt)
	}

	private async preparePlaceholders(): Promise<Record<string, unknown>> {
		const placeholders: Record<string, unknown> = {}

		placeholders["OS"] = process.platform
		placeholders["SHELL"] = this.context.activeShellPath || process.env.SHELL || "bash"
		placeholders["SHELL_TYPE"] = this.context.activeShellType || "bash"
		placeholders["HOME_DIR"] = process.env.HOME || ""
		placeholders["CURRENT_DATE"] = new Date().toISOString().split("T")[0]
		placeholders["AVAILABLE_CORES"] = this.context.availableCores || 1

		// Add runtime placeholders if any
		const runtimePlaceholders = (this.context as any).runtimePlaceholders
		if (runtimePlaceholders) {
			Object.assign(placeholders, runtimePlaceholders)
		}

		if (this.context.skills && this.context.skills.length > 0) {
			placeholders["SKILLS_SECTION"] = this.formatSkillsSection(this.context.skills)
		} else {
			placeholders["SKILLS_SECTION"] = ""
		}

		// ailiance-agent (v0.9.1): auto-inject cross-task memories
		// saved at ~/.ailiance-agent/memory/ scoped to cwd. The memory
		// store is best-effort — a corrupted file or missing directory
		// returns null, and the placeholder collapses to the empty string
		// without breaking the prompt. Budget-capped at MEMORY_BUDGET_CHARS
		// (~2000 tokens) so an unbounded memory store cannot dominate.
		// Skipped during isTesting so unit tests stay deterministic.
		placeholders["MEMORIES_SECTION"] = ""
		if (!this.context.isTesting) {
			try {
				// Semantic ranker is gated behind ISAAC_MEM_EMBEDDINGS; default
				// returns undefined ⇒ loadRelevantMemories token-overlap path is
				// byte-identical to before (the call is the same as a 2-arg call).
				const ranker = selectMemoryRanker()
				const loaded = await loadRelevantMemories(this.context.cwd, this.context.userPromptText, ranker)
				placeholders["MEMORIES_SECTION"] = formatMemoriesSection(loaded)
			} catch {
				// best-effort; never break system-prompt assembly
			}
		}

		return placeholders
	}

	private postProcess(prompt: string): string {
		if (!prompt) {
			return ""
		}

		return prompt
			.replace(/\n\s*\n\s*\n/g, "\n\n") // Remove multiple consecutive empty lines
			.trim() // Remove leading/trailing whitespace
			.replace(/====+\s*$/, "") // Remove trailing ==== after trim
			.replace(/\n====+\s*\n+\s*====+\n/g, "\n====\n") // Remove empty sections between separators
			.replace(/====\s*\n\s*====\s*\n/g, "====\n") // Remove consecutive empty sections
			.replace(/^##\s*$[\r\n]*/gm, "") // Remove empty section headers (## with no content)
			.replace(/\n##\s*$[\r\n]*/gm, "") // Remove empty section headers that appear mid-document
			.replace(/====+\n(?!\n)([^\n])/g, (match, _nextChar, offset, string) => {
				const beforeContext = string.substring(Math.max(0, offset - 50), offset)
				const afterContext = string.substring(offset, Math.min(string.length, offset + 50))
				const isDiffLike = /SEARCH|REPLACE|\+\+\+\+\+\+\+|-------/.test(beforeContext + afterContext)
				return isDiffLike ? match : match.replace(/\n/, "\n\n")
			})
			.replace(/([^\n])\n(?!\n)====+/g, (match, prevChar, offset, string) => {
				const beforeContext = string.substring(Math.max(0, offset - 50), offset)
				const afterContext = string.substring(offset, Math.min(string.length, offset + 50))
				const isDiffLike = /SEARCH|REPLACE|\+\+\+\+\+\+\+|-------/.test(beforeContext + afterContext)
				return isDiffLike ? match : prevChar + "\n\n" + match.substring(1).replace(/\n/, "")
			})
			.replace(/\n\s*\n\s*\n/g, "\n\n") // Clean up any multiple empty lines created by header removal
			.trim() // Final trim
	}

	private formatSkillsSection(skills: SkillMetadata[]): string {
		if (skills.length === 0) return ""

		let section = "\n\n# AVAILABLE SKILLS\n"
		section += "You have access to specialized skills. Use the 'use_skill' tool to activate one.\n\n"

		// Prioritize Project skills
		const projectSkills = skills.filter((s) => s.source === "project")
		const globalSkills = skills.filter((s) => s.source === "global")

		const displaySkills = [...projectSkills, ...globalSkills].slice(0, 10)

		displaySkills.forEach((skill) => {
			section += `- ${skill.name}: ${skill.description}\n`
		})

		if (skills.length > 10) {
			section += `\n... and ${skills.length - 10} more. Use the 'list_skills' tool to see the full list.\n`
		}

		return section
	}
}
