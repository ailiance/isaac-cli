import type { IsaacDefaultTool } from "@/shared/tools"
import type { IsaacToolSpec } from "./spec"

/**
 * Unified tool unit — Lot E (fusion spec/handler).
 *
 * A single typed unit co-locates a tool's prompt spec with its execution
 * handler factory, and exposes a **typed link** between the parameter names
 * declared in the spec and the names the handler reads at runtime.
 *
 * Why: today a tool's spec (`system-prompt/tools/*.ts`) and its handler
 * (`task/tools/handlers/*Handler.ts`) are connected only by the
 * `IsaacDefaultTool` string enum. A param rename on the spec side does not
 * break the handler compile — silent drift. The `ParamNames<…>` type below
 * derives the param-name union *from the spec literal* so a handler that reads
 * params through `ToolParamReader<Unit>` fails to compile when a spec param is
 * renamed/removed.
 *
 * The unit deliberately reuses the existing `IsaacToolSpec` shape unchanged so
 * the OpenAI schema and prompt snapshots are byte-identical to the legacy path.
 * The two systems coexist: legacy specs and migrated units both register into
 * `IsaacToolSet`, and both handler-registration paths still work.
 */

/**
 * A spec whose `parameters` array carries literal `name` types. Declaring the
 * spec `as const satisfies IsaacToolSpec` at the call site preserves those
 * literals so the param-name union can be derived.
 */
export type TypedToolSpec = Readonly<Pick<IsaacToolSpec, "id" | "name" | "description">> & {
	readonly parameters?: ReadonlyArray<{ readonly name: string }>
}

/** Union of declared parameter names for a spec (drift-detecting link). */
export type ParamNames<S extends { parameters?: ReadonlyArray<{ name: string }> }> = S extends {
	parameters?: ReadonlyArray<infer P>
}
	? P extends { name: infer N }
		? N extends string
			? N
			: never
		: never
	: never

/**
 * Typed accessor over a `ToolUse.params` bag, keyed on the spec's declared
 * parameter names. Handlers should read params through this instead of raw
 * `block.params["foo"]` string indexing so renames are caught at compile time.
 */
export type ToolParams<U extends IsaacToolUnit> = {
	readonly [K in ParamNames<U["spec"]>]?: string
}

/**
 * Factory signature for a handler. Kept loose (returns `unknown`-typed handler)
 * so this module does not depend on the `task/` layer — the concrete handler
 * type is enforced where the factory is registered.
 */
export type ToolHandlerFactory<H> = (validator: unknown) => H

export interface IsaacToolUnit<H = unknown> {
	/** Stable id (shared with the legacy enum). */
	readonly id: IsaacDefaultTool
	/** Prompt spec — unchanged shape → identical OpenAI schema. */
	readonly spec: TypedToolSpec
	/** True if the tool never mutates the workspace. */
	readonly readonly: boolean
	/** Builds the execution handler. */
	readonly createHandler: ToolHandlerFactory<H>
}

/**
 * Defines a tool unit and returns it with `spec` narrowed to the concrete
 * literal type, so `ParamNames<typeof unit.spec>` resolves to the real union.
 *
 * Usage:
 *   export const list_files_unit = defineTool({
 *     id, spec: list_files, readonly: true, createHandler: (v) => new …(v),
 *   })
 */
export function defineTool<S extends TypedToolSpec, H>(unit: {
	id: IsaacDefaultTool
	spec: S
	readonly: boolean
	createHandler: ToolHandlerFactory<H>
}): IsaacToolUnit<H> & { spec: S } {
	return unit
}

/** Reads a param through the typed contract — drift-detecting at compile time. */
export function readParam<U extends IsaacToolUnit>(
	_unit: U,
	params: Record<string, unknown>,
	name: ParamNames<U["spec"]>,
): string | undefined {
	const v = params[name]
	return v === undefined ? undefined : String(v)
}
