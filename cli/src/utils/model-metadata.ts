/**
 * Shared provider model metadata for CLI surfaces.
 *
 * Keep this free of React/Ink imports so non-UI entrypoints such as ACP can use
 * the same provider/model lists as the interactive CLI.
 */

import { getOpenRouterDefaultModelId, usesOpenRouterModels } from "./openrouter-models"

/**
 * Static model maps for CLI providers.
 *
 * The sovereign build only routes gateway / OpenAI-compatible providers
 * (openai, openrouter, lmstudio, litellm, isaac, vscode-lm). None of these
 * carry a hardcoded model map: openrouter/isaac fetch their lists dynamically
 * (see `usesOpenRouterModels`), the others have no static picker. This map is
 * therefore intentionally empty, kept as the extension seam in case a future
 * provider ships a static list.
 */
export const providerModels: Record<string, { models: Record<string, unknown>; defaultId: string }> = {}

export function hasStaticModels(provider: string): boolean {
	return provider in providerModels
}

export function hasModelPicker(provider: string): boolean {
	return hasStaticModels(provider) || usesOpenRouterModels(provider) || provider === "github-copilot"
}

export function getDefaultModelId(provider: string): string {
	if (usesOpenRouterModels(provider)) {
		return getOpenRouterDefaultModelId()
	}
	return providerModels[provider]?.defaultId || ""
}

export function getModelList(provider: string): string[] {
	if (!hasStaticModels(provider)) return []
	return Object.keys(providerModels[provider].models)
}
