import * as childProcessModule from "child_process"
import { Logger } from "@/shared/services/Logger"
import { HookInput, HookOutput } from "../../../shared/proto/isaac/hooks"
import type { PluginHookCommand } from "../../plugins/PluginHookLoader"
import { exec, HookName, HookRunner, validateHookOutput } from "../hook-types"

// Default timeout (seconds) when a plugin hook doesn't specify one
const PLUGIN_HOOK_DEFAULT_TIMEOUT_S = 10

/**
 * Executes a single plugin hook command as a child process.
 *
 * The command is spawned with CLAUDE_PLUGIN_ROOT set to the plugin root dir
 * (already expanded in the command string by PluginHookLoader), plus standard
 * environment variables (CLAUDE_TASK_ID, CLAUDE_CODE_VERSION).
 *
 * Fail-open: any execution error returns a successful no-op HookOutput rather
 * than propagating. This matches the "hooks are advisory" contract.
 */
export class PluginHookRunner<Name extends HookName> extends HookRunner<Name> {
	constructor(
		hookName: Name,
		private readonly pluginHook: PluginHookCommand,
		private readonly abortSignal?: AbortSignal,
	) {
		super(hookName)
	}

	override async [exec](input: HookInput): Promise<HookOutput> {
		const { command, timeoutSeconds, pluginName } = this.pluginHook
		const timeoutMs = (timeoutSeconds ?? PLUGIN_HOOK_DEFAULT_TIMEOUT_S) * 1000

		const inputJson = JSON.stringify(HookInput.toJSON(input) as Record<string, any>)

		return new Promise<HookOutput>((resolve) => {
			const env: Record<string, string> = {
				...(process.env as Record<string, string>),
				CLAUDE_TASK_ID: input.taskId ?? "",
				CLAUDE_CODE_VERSION: input.isaacVersion ?? "",
			}

			// SECURITY (P1 #4): plugin hooks come from ~/.claude/plugins/cache,
			// which is user-writeable and unsigned — installing a plugin is the
			// trust boundary. `command` is the plugin manifest's declared shell
			// command (with ${CLAUDE_PLUGIN_ROOT} already expanded by
			// PluginHookLoader to a path structurally confined to that cache, since
			// rootDir is built from readdir entries that can never contain "..").
			//
			// We KEEP shell:true on purpose: the Claude Code plugin-hook contract
			// allows free-form shell command lines (pipes, args, redirects, env
			// expansion), so passing args as an array would break legitimate hooks.
			// Crucially, NO untrusted runtime value is interpolated into `command`:
			// the hook input JSON is delivered on stdin (below) and the dynamic
			// values (CLAUDE_TASK_ID / CLAUDE_CODE_VERSION) are passed via `env`,
			// never spliced into the command string — so there is no command
			// injection surface beyond the (inherent) trust placed in the plugin.
			//
			// Hardening that does not break the contract:
			//   - audit-log the exact command we are about to run, so supply-chain
			//     code execution is visible rather than silent;
			//   - windowsHide so a malicious/buggy hook cannot pop visible windows.
			Logger.info(`[PluginHooks] Plugin '${pluginName}' executing hook command: ${command}`)
			const child = childProcessModule.spawn(command, [], {
				shell: true,
				env,
				stdio: ["pipe", "pipe", "pipe"],
				windowsHide: true,
			})

			let stdout = ""
			let settled = false

			const settle = (output: HookOutput) => {
				if (settled) return
				settled = true
				clearTimeout(timer)
				resolve(output)
			}

			// Timeout
			const timer = setTimeout(() => {
				if (!settled) {
					Logger.warn(`[PluginHooks] Plugin '${pluginName}' hook timed out after ${timeoutMs}ms, continuing`)
					child.kill()
					settle(HookOutput.create({ cancel: false }))
				}
			}, timeoutMs)

			// Abort signal
			if (this.abortSignal) {
				this.abortSignal.addEventListener("abort", () => {
					if (!settled) {
						child.kill()
						settle(HookOutput.create({ cancel: false }))
					}
				})
			}

			child.stdout?.on("data", (chunk: Buffer) => {
				stdout += chunk.toString()
			})

			child.stderr?.on("data", (chunk: Buffer) => {
				Logger.warn(`[PluginHooks] Plugin '${pluginName}' stderr: ${chunk.toString().trimEnd()}`)
			})

			child.on("error", (err) => {
				Logger.warn(`[PluginHooks] Plugin '${pluginName}' spawn error: ${err.message}`)
				settle(HookOutput.create({ cancel: false }))
			})

			child.on("close", () => {
				if (settled) return
				try {
					const parsed = JSON.parse(stdout.trim())
					const validation = validateHookOutput(parsed)
					if (validation.valid) {
						settle(HookOutput.fromJSON(parsed))
						return
					}
				} catch {
					// Ignore parse errors — treat as no-op
				}
				settle(HookOutput.create({ cancel: false }))
			})

			// Write input JSON to stdin then close
			if (child.stdin) {
				child.stdin.write(inputJson)
				child.stdin.end()
			}
		})
	}
}
