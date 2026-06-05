import { ChatCompletionTool as OpenAITool } from "openai/resources/chat/completions"
import type { IsaacDefaultTool } from "@/shared/tools"
import { MULTI_ROOT_HINT } from "./constants"
import type { SystemPromptContext } from "./types"

export interface IsaacToolSpec {
	id: IsaacDefaultTool
	name: string
	description: string
	instruction?: string
	contextRequirements?: (context: SystemPromptContext) => boolean
	parameters?: Array<IsaacToolSpecParameter>
}

interface IsaacToolSpecParameter {
	name: string
	required: boolean
	instruction: string | ((context: SystemPromptContext) => string)
	usage?: string
	dependencies?: IsaacDefaultTool[]
	description?: string
	contextRequirements?: (context: SystemPromptContext) => boolean
	// TODO: Confirm if "integer" is actually supported across providers
	/**
	 * The type of the parameter. Default to string if not provided.
	 * Supported types: string, boolean, integer, array, object
	 */
	type?: "string" | "boolean" | "integer" | "array" | "object"
	/**
	 * For array types, this defines the schema of array items
	 */
	items?: any
	/**
	 * For object types, this defines the properties
	 */
	properties?: Record<string, any>
	/**
	 * Additional JSON Schema fields to preserve from MCP tools
	 */
	[key: string]: any
}

/**
 * Converts a IsaacToolSpec into an OpenAI ChatCompletionTool definition
 * Docs: https://openrouter.ai/docs/features/tool-calling#step-1-inference-request-with-tools
 */
export function toolSpecFunctionDefinition(tool: IsaacToolSpec, context: SystemPromptContext, strict = false): OpenAITool {
	// Check if the tool should be included based on context requirements
	if (tool.contextRequirements && !tool.contextRequirements(context)) {
		throw new Error(`Tool ${tool.name} does not meet context requirements`)
	}

	/**
	 * Recursively processes a JSON schema to comply with OpenAI's strict mode requirements.
	 * - Sets additionalProperties: false for all objects
	 * - Ensures all properties are in the required array
	 * - Filters out unsupported keywords
	 */
	const processSchema = (schema: any): any => {
		if (schema.type === "object") {
			const properties: Record<string, any> = {}
			const required: string[] = []

			if (schema.properties) {
				for (const [key, value] of Object.entries(schema.properties)) {
					properties[key] = processSchema(value)
					required.push(key)
				}
			}

			return {
				type: "object",
				properties,
				required,
				additionalProperties: false,
				...(schema.description ? { description: schema.description } : {}),
			}
		}

		if (schema.type === "array" && schema.items) {
			return {
				type: "array",
				items: processSchema(schema.items),
				...(schema.description ? { description: schema.description } : {}),
			}
		}

		// For non-object/array types, filter unsupported keywords if strict is enabled
		if (strict) {
			const {
				type,
				description,
				enum: enumValues,
				// Filtered out: minimum, maximum, pattern, minLength, maxLength, etc.
			} = schema
			return {
				type,
				...(description ? { description } : {}),
				...(enumValues ? { enum: enumValues } : {}),
			}
		}

		return schema
	}

	// Build the properties object for parameters
	const properties: Record<string, any> = {}
	const required: string[] = []

	if (tool.parameters) {
		for (const param of tool.parameters) {
			// Check if parameter should be included based on context requirements
			if (param.contextRequirements && !param.contextRequirements(context)) {
				continue
			}

			// Add to required array if parameter is required (or if strict is enabled)
			if (param.required || strict) {
				required.push(param.name)
			}

			// Determine parameter type - use explicit type if provided.
			// Default to string
			const paramType: string = param.type || "string"

			// Build parameter schema
			const paramSchema: any = {
				type: paramType,
				description: replacer(resolveInstruction(param.instruction, context), context),
			}

			// Add items for array types
			if (paramType === "array" && param.items) {
				paramSchema.items = param.items
			}

			// Add properties for object types
			if (paramType === "object" && param.properties) {
				paramSchema.properties = param.properties
			}

			// Preserve any additional JSON Schema fields from tools
			// (e.g., enum, format, minimum, maximum, etc.)
			const reservedKeys = new Set([
				"name",
				"required",
				"instruction",
				"usage",
				"dependencies",
				"description",
				"contextRequirements",
				"type",
				"items",
				"properties",
			])

			for (const key in param) {
				if (!reservedKeys.has(key) && param[key] !== undefined) {
					paramSchema[key] = param[key]
				}
			}

			// Add usage example as part of description if available
			if (param.usage) {
				paramSchema.description += ` Example: ${param.usage}`
			}

			properties[param.name] = strict ? processSchema(paramSchema) : paramSchema
		}
	}

	const chatCompletionTool: OpenAITool = {
		type: "function",
		function: {
			name: tool.name,
			strict: strict,
			description: replacer(tool.description, context),
			parameters: {
				type: "object",
				properties,
				required,
				additionalProperties: false,
			},
		},
	}

	return chatCompletionTool
}

/**
 * Replaces template placeholders in descriptions for native tool schemas.
 */
function replacer(description: string, context: SystemPromptContext): string {
	const width = context.browserSettings?.viewport?.width || 900
	const height = context.browserSettings?.viewport?.height || 600
	const cwd = context.cwd || process.cwd()
	const multiRootHint = context.isMultiRootEnabled ? MULTI_ROOT_HINT : ""

	return description
		.replace(/{{BROWSER_VIEWPORT_WIDTH}}/g, String(width))
		.replace(/{{BROWSER_VIEWPORT_HEIGHT}}/g, String(height))
		.replace(/{{CWD}}/g, cwd)
		.replace(/{{MULTI_ROOT_HINT}}/g, multiRootHint)
}

/**
 * Resolves an instruction that may be a string or a function.
 */
export function resolveInstruction(
	instruction: string | ((context: SystemPromptContext) => string),
	context: SystemPromptContext,
): string {
	return typeof instruction === "function" ? instruction(context) : instruction
}
