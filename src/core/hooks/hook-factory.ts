import fs from "fs/promises"
import path from "path"
import { Logger } from "@/shared/services/Logger"
import { telemetryService } from "../../services/telemetry"
import type { LoadPluginHooksResult, PluginHookCommand } from "../plugins/PluginHookLoader"
import { getAllHooksDirs } from "../storage/disk"
import { StateManager } from "../storage/StateManager"
import { HookName, HookRunner, HookStreamCallback } from "./hook-types"
import { CombinedHookRunner } from "./runners/CombinedHookRunner"
import { NoOpRunner } from "./runners/NoOpRunner"
import { PluginHookRunner } from "./runners/PluginHookRunner"
import { StdioHookRunner } from "./runners/StdioHookRunner"

// Re-export shared hook types/runners so existing importers of "./hook-factory"
// keep working after the structural split into hook-types.ts + runners/.
export type { HookModelInputContext, HookName, HookStreamCallback, Hooks, NamedHookInput } from "./hook-types"
export {
	EXIT_CODE_SIGINT,
	exec,
	HOOK_EXECUTION_TIMEOUT_MS,
	HookRunner,
	MAX_CONTEXT_MODIFICATION_SIZE,
	validateHookOutput,
} from "./hook-types"
export { CombinedHookRunner } from "./runners/CombinedHookRunner"
export { NoOpRunner } from "./runners/NoOpRunner"
export { PluginHookRunner } from "./runners/PluginHookRunner"
export { StdioHookRunner } from "./runners/StdioHookRunner"

/**
 * Checks if an error encountered during hook discovery is expected and can be safely ignored.
 * Expected errors include file not found, permission denied, and invalid path components.
 *
 * @param error The error to check
 * @returns true if this is an expected error that should be silently handled, false if it should be propagated
 */
function isExpectedHookError(error: unknown): boolean {
	if (!(error instanceof Error)) {
		return false
	}

	const nodeError = error as NodeJS.ErrnoException

	// Expected: File doesn't exist (most common case)
	if (nodeError.code === "ENOENT") {
		return true
	}

	// Expected: Permission denied (file not executable or not readable)
	// Note: This is expected because users may have hooks in .isaacrules that they don't want to execute
	if (nodeError.code === "EACCES") {
		return true
	}

	// Expected: Not a directory (one of the path components isn't a directory)
	if (nodeError.code === "ENOTDIR") {
		return true
	}

	// All other errors (EIO, EMFILE, etc.) are unexpected and should be propagated
	return false
}

export class HookFactory {
	// ---------------------------------------------------------------------------
	// Plugin hooks registry (static — shared across all HookFactory instances)
	// ---------------------------------------------------------------------------

	/** Registry: event name → plugin hook commands loaded via registerPluginHooks */
	private static pluginHookRegistry = new Map<string, PluginHookCommand[]>()

	/**
	 * Register plugin hooks from all discovered plugins.
	 *
	 * Call this once at task boot (e.g. in LifecycleManager.startTask) after
	 * `loadPluginHooks()` has resolved. Replaces any previously registered
	 * plugin hooks for the same events (idempotent on repeated calls).
	 *
	 * Unsupported events (Stop, SessionStart, PermissionRequest) are already
	 * filtered out by PluginHookLoader. Extra unknown events are silently skipped.
	 *
	 * @param result The result returned by `loadPluginHooks()`
	 */
	static registerPluginHooks(result: LoadPluginHooksResult): void {
		// Reset previous registrations
		HookFactory.pluginHookRegistry.clear()

		for (const [event, commands] of result.byEvent) {
			HookFactory.pluginHookRegistry.set(event, commands)
		}

		const totalCommands = [...result.byEvent.values()].reduce((n, cmds) => n + cmds.length, 0)
		if (totalCommands > 0) {
			Logger.log(`[PluginHooks] Registered ${totalCommands} plugin hook(s) across ${result.byEvent.size} event(s)`)
		}
	}

	/**
	 * Returns plugin hook commands registered for the given event name, or [].
	 */
	static getPluginHooksForEvent(event: string): PluginHookCommand[] {
		return HookFactory.pluginHookRegistry.get(event) ?? []
	}

	/**
	 * Clears the plugin hook registry. Intended for use in tests.
	 */
	static clearPluginHooks(): void {
		HookFactory.pluginHookRegistry.clear()
	}

	// ---------------------------------------------------------------------------
	// Instance methods
	// ---------------------------------------------------------------------------

	/**
	 * Get information about discovered hooks including their script paths
	 * @param hookName The type of hook to query
	 * @returns Object containing array of script paths
	 */
	async getHookInfo<Name extends HookName>(
		hookName: Name,
	): Promise<{
		scriptPaths: string[]
	}> {
		const { HookDiscoveryCache } = await import("./HookDiscoveryCache")
		const scripts = await HookDiscoveryCache.getInstance().get(hookName)
		return { scriptPaths: scripts }
	}

	/**
	 * Check if any hook scripts exist for the given hook name.
	 * Also returns true if any plugin hooks are registered for this event.
	 * @returns true if at least one hook (filesystem or plugin) exists, false otherwise
	 */
	async hasHook<Name extends HookName>(hookName: Name): Promise<boolean> {
		const scripts = await HookFactory.findHookScripts(hookName)
		if (scripts.length > 0) return true
		return HookFactory.getPluginHooksForEvent(hookName).length > 0
	}

	/**
	 * Create a hook runner without streaming support (backwards compatible)
	 */
	async create<Name extends HookName>(hookName: Name, taskId?: string, toolName?: string): Promise<HookRunner<Name>> {
		return this.createWithStreaming(hookName, undefined, undefined, taskId, toolName)
	}

	/**
	 * Create a hook runner with optional streaming callback and abort signal support.
	 *
	 * This is the primary factory method for creating hooks. It:
	 * 1. Uses HookDiscoveryCache to find hook scripts (fast O(1) lookup after first scan)
	 * 2. Creates StdioHookRunner instances for each discovered script
	 * 3. Returns NoOpRunner if no scripts found (null-object pattern)
	 * 4. Returns CombinedHookRunner if multiple scripts found (parallel execution)
	 *
	 * The streaming callback receives hook output line-by-line in real-time, allowing
	 * the UI to display progress as the hook executes. The abort signal enables
	 * cancellation of long-running hooks.
	 *
	 * @param hookName The type of hook to create (e.g., "PreToolUse", "PostToolUse")
	 * @param streamCallback Optional callback for real-time output streaming
	 * @param abortSignal Optional signal to cancel hook execution
	 * @param taskId Optional task ID for telemetry context
	 * @param toolName Optional tool name for telemetry context
	 * @returns A HookRunner that executes the hook(s), or NoOpRunner if none found
	 */
	async createWithStreaming<Name extends HookName>(
		hookName: Name,
		streamCallback?: HookStreamCallback,
		abortSignal?: AbortSignal,
		taskId?: string,
		toolName?: string,
	): Promise<HookRunner<Name>> {
		// Use cache for hook discovery instead of direct file system scan
		const { HookDiscoveryCache } = await import("./HookDiscoveryCache")
		const scripts = await HookDiscoveryCache.getInstance().get(hookName)

		// Fetch hooks dirs once for source determination and telemetry
		const hooksDirs = await getAllHooksDirs()

		// Capture hook discovery telemetry
		// Categorize scripts by location (global vs workspace)
		const { globalCount, workspaceCount } = this.categorizeHookScripts(scripts, hooksDirs)
		if (scripts.length > 0) {
			telemetryService.safeCapture(
				() => telemetryService.captureHookDiscovery(hookName, globalCount, workspaceCount),
				"HookFactory.createWithStreaming.discovery",
			)
		}

		// Get workspace roots for cwd determination
		const stateManager = StateManager.get()
		const workspaceRoots = stateManager.getGlobalStateKey("workspaceRoots")
		const primaryRootIndex = stateManager.getGlobalStateKey("primaryRootIndex") ?? 0
		const primaryCwd = workspaceRoots?.[primaryRootIndex]?.path

		// Create runners with source and cwd determination for each script
		// Global hooks run from primary workspace root
		// Workspace-specific hooks run from their respective workspace root
		const runners: HookRunner<Name>[] = scripts.map((script) => {
			const source = this.determineScriptSource(script, hooksDirs)
			const cwd = this.determineHookCwd(script, hooksDirs, workspaceRoots, primaryCwd)
			return new StdioHookRunner(hookName, script, source, streamCallback, abortSignal, taskId, toolName, cwd)
		})

		// Add plugin hook runners for this event, filtered by matcher + toolName
		const pluginHooksForEvent = HookFactory.getPluginHooksForEvent(hookName)
		for (const pluginHook of pluginHooksForEvent) {
			// If matcher is set, apply regex filter against the tool name
			if (pluginHook.matcher && toolName !== undefined) {
				try {
					const re = new RegExp(pluginHook.matcher)
					if (!re.test(toolName)) {
						continue
					}
				} catch {
					Logger.warn(
						`[PluginHooks] Plugin '${pluginHook.pluginName}' has invalid matcher regex '${pluginHook.matcher}', skipping`,
					)
					continue
				}
			}
			runners.push(new PluginHookRunner(hookName, pluginHook, abortSignal))
		}

		if (runners.length === 0) {
			return new NoOpRunner(hookName)
		}
		return runners.length === 1 ? runners[0] : new CombinedHookRunner(hookName, runners)
	}

	/**
	 * Checks if a hooks directory is a global hooks directory.
	 * Global hooks are located in paths containing "Isaac/Hooks" or "isaac/hooks".
	 */
	private static isGlobalHooksDir(dir: string): boolean {
		return /[/\\][Cc]line[/\\][Hh]ooks/i.test(dir)
	}

	/**
	 * Determines if a single script is from global or workspace location
	 */
	private determineScriptSource(scriptPath: string, hooksDirs: string[]): "global" | "workspace" {
		const containingDir = hooksDirs.find((dir) => scriptPath.startsWith(dir))
		if (containingDir && HookFactory.isGlobalHooksDir(containingDir)) {
			return "global"
		}
		return "workspace" // Default to workspace if uncertain
	}

	/**
	 * Determines the working directory for a hook script based on its location.
	 *
	 * - Global hooks (from ~/Documents/Isaac/Hooks/): run from the primary workspace root
	 * - Workspace hooks (from workspaceRoot/.isaacrules/hooks/): run from that specific workspace root
	 *
	 * This ensures workspace-specific hooks can use relative paths that are meaningful
	 * within their own workspace context.
	 *
	 * @param scriptPath The full path to the hook script
	 * @param hooksDirs Array of all hooks directories
	 * @param workspaceRoots Array of workspace root objects
	 * @param primaryCwd The primary workspace root path (fallback)
	 * @returns The working directory to use for this hook
	 */
	private determineHookCwd(
		scriptPath: string,
		hooksDirs: string[],
		workspaceRoots: Array<{ path: string }> | undefined,
		primaryCwd: string | undefined,
	): string | undefined {
		const containingDir = hooksDirs.find((dir) => scriptPath.startsWith(dir))

		// If global hook, use primary workspace root
		if (containingDir && HookFactory.isGlobalHooksDir(containingDir)) {
			return primaryCwd
		}

		// If workspace hook, find which workspace root it belongs to
		// Workspace hooks are at: workspaceRoot/.isaacrules/hooks/
		// So find the workspace root whose path is a prefix of the containing hooks dir
		if (containingDir && workspaceRoots) {
			const workspaceRoot = workspaceRoots.find((root) => containingDir.startsWith(root.path))
			if (workspaceRoot) {
				return workspaceRoot.path
			}
		}

		// Fallback to primary cwd
		return primaryCwd
	}

	/**
	 * Categorizes hook scripts by their location (global vs workspace).
	 * Global hooks are located in ~/Documents/Isaac/Hooks/
	 * Workspace hooks are located in workspace .isaacrules/hooks/ directories
	 *
	 * @param scripts Array of hook script paths
	 * @param hooksDirs Array of hooks directories (passed to avoid redundant fetches)
	 * @returns Object with globalCount and workspaceCount
	 */
	private categorizeHookScripts(scripts: string[], hooksDirs: string[]): { globalCount: number; workspaceCount: number } {
		if (scripts.length === 0) {
			return { globalCount: 0, workspaceCount: 0 }
		}

		let globalCount = 0
		let workspaceCount = 0

		for (const script of scripts) {
			const containingDir = hooksDirs.find((dir) => script.startsWith(dir))
			if (containingDir && HookFactory.isGlobalHooksDir(containingDir)) {
				globalCount++
			} else {
				workspaceCount++
			}
		}

		return { globalCount, workspaceCount }
	}

	/**
	 * @returns A list of paths to scripts for the given hook name.
	 * Includes both global hooks (from ~/Documents/Isaac/Hooks/) and workspace hooks
	 * (from .isaacrules/hooks/ in each workspace root).
	 */
	private static async findHookScripts(hookName: HookName): Promise<string[]> {
		const hookScripts = []
		for (const hooksDir of await getAllHooksDirs()) {
			hookScripts.push(HookFactory.findHookInHooksDir(hookName, hooksDir))
		}
		const isDefined = (scriptPath: string | undefined): scriptPath is string => Boolean(scriptPath)
		return (await Promise.all(hookScripts)).filter(isDefined)
	}

	/**
	 * Finds the path to a hook in a .isaacrules hooks directory.
	 *
	 * @param hookName the name of the hook to search for, for example 'PreToolUse'
	 * @param hooksDir the .isaacrules directory path to search
	 * @returns the path to the hook to execute, or undefined if none found
	 * @throws Error if an unexpected file system error occurs
	 */
	static async findHookInHooksDir(hookName: HookName, hooksDir: string): Promise<string | undefined> {
		return process.platform === "win32"
			? HookFactory.findWindowsHook(hookName, hooksDir)
			: HookFactory.findUnixHook(hookName, hooksDir)
	}

	/**
	 * Finds a hook on Windows by checking for a PowerShell hook file (`<HookName>.ps1`).
	 *
	 * Extensionless hooks are intentionally ignored on Windows.
	 *
	 * Why: Windows hooks execute via PowerShell (`powershell -File ...`).
	 * The supported contract is an explicit PowerShell script file per hook type.
	 *
	 * @param hookName the name of the hook to search for
	 * @param hooksDir the hooks directory path to search
	 * @returns the path to the hook to execute, or undefined if none found
	 * @throws Error if an unexpected file system error occurs
	 */
	private static async findWindowsHook(hookName: HookName, hooksDir: string): Promise<string | undefined> {
		const powerShell = path.join(hooksDir, `${hookName}.ps1`)
		const powerShellExists = await HookFactory.isHookFile(powerShell, hookName)

		if (powerShellExists) {
			return powerShell
		}

		return undefined
	}

	private static async isHookFile(candidate: string, hookName: HookName): Promise<boolean> {
		try {
			const stat = await fs.stat(candidate)
			return stat.isFile()
		} catch (error) {
			HookFactory.handleHookDiscoveryError(error, hookName, candidate)
			return false
		}
	}

	/**
	 * Finds a hook on Unix-like systems (Linux, macOS) by checking for an executable file.
	 *
	 * `.ps1` hook files are intentionally ignored on Unix platforms.
	 *
	 * Why: Unix hooks use executable-file semantics (bash scripts, binaries, etc.)
	 * with canonical extensionless hook names.
	 *
	 * @param hookName the name of the hook to search for
	 * @param hooksDir the .isaacrules directory path to search
	 * @returns the path to the hook to execute, or undefined if none found
	 * @throws Error if an unexpected file system error occurs
	 */
	private static async findUnixHook(hookName: HookName, hooksDir: string): Promise<string | undefined> {
		const candidate = path.join(hooksDir, hookName)

		try {
			const [stat, _] = await Promise.all([fs.stat(candidate), fs.access(candidate, fs.constants.X_OK)])
			return stat.isFile() ? candidate : undefined
		} catch (error) {
			HookFactory.handleHookDiscoveryError(error, hookName, candidate)
			// Expected errors (missing/non-executable hook) return no match.
			return undefined
		}
	}

	/**
	 * Handles errors encountered during hook discovery.
	 * Expected errors (file not found, permission denied, etc.) are silently ignored.
	 * Unexpected errors are propagated with context.
	 *
	 * @param error the error that occurred
	 * @param hookName the name of the hook being searched for
	 * @param candidate the file path that was being checked
	 * @throws Error if the error is unexpected
	 */
	private static handleHookDiscoveryError(error: unknown, hookName: HookName, candidate: string): void {
		if (!isExpectedHookError(error)) {
			throw new Error(
				`Unexpected error while searching for hook '${hookName}' at '${candidate}': ${
					error instanceof Error ? error.message : String(error)
				}`,
			)
		}
	}
}
