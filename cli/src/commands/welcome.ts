import { exit } from "node:process"
import type { TaskOptions } from "../types"
import { initializeCli } from "../init"
import { disposeCliContext } from "../utils/cleanup"
import { applyTaskOptions } from "../utils/options"
import { runInkApp } from "../utils/ink"

/**
 * Show welcome prompt and wait for user input
 * If auth is not configured, show auth flow first
 */
export async function showWelcome(options: TaskOptions) {
	const { isAuthConfigured } = await import("../utils/auth")
	const { StateManager } = await import("@/core/storage/StateManager")
	const { checkRawModeSupport } = await import("../context/StdinContext")
	const React = (await import("react")).default
	const { App } = await import("../components/App")

	// Bail loud before instantiating Ink when there is no TTY. ink-picture
	// queries terminal escape sequences via setRawMode() on boot, which
	// throws an opaque "Raw mode is not supported on the current
	// process.stdin" stack the moment Ink mounts. Passing
	// isRawModeSupported as a prop to <App /> cannot prevent this — Ink
	// itself needs raw mode for its own terminal-info probe. Detect the
	// missing TTY here and print a helpful message with the recognised
	// non-interactive alternatives instead of letting the user see an
	// unrelated stack trace.
	if (!checkRawModeSupport()) {
		const { printError } = await import("../utils/display")
		printError(
			[
				"isaac interactive mode requires a real TTY.",
				"",
				"This shell is not attached to one (piped input, subprocess,",
				"CI runner, or backgrounded). Use one of these instead:",
				"",
				"  isaac \"<your task>\"     # one-shot run",
				"  echo \"<task>\" | isaac    # piped task",
				"  isaac --continue          # resume last task",
				"  isaac --acp               # editor integration (ACP)",
				"",
				"Run from Warp/iTerm/zellij/tmux directly to get the TUI.",
			].join("\n"),
		)
		exit(1)
	}

	const ctx = await initializeCli({ ...options, enableAuth: true })

	// Check if auth is configured
	const hasAuth = await isAuthConfigured()

	// Apply CLI task options in interactive startup too, so flags like
	// --auto-approve-all and --yolo affect the initial TUI state.
	await applyTaskOptions(options)
	await StateManager.get().flushPendingState()

	let hadError = false

	await runInkApp(
		React.createElement(App, {
			// Start with auth view if not configured, otherwise welcome
			view: hasAuth ? "welcome" : "auth",
			verbose: options.verbose,
			controller: ctx.controller,
			isRawModeSupported: checkRawModeSupport(),
			onWelcomeExit: () => {
				// User pressed Esc; Ink exits and cleanup handles process exit.
			},
			onError: () => {
				hadError = true
			},
		}),
		async () => {
			await disposeCliContext(ctx)
			exit(hadError ? 1 : 0)
		},
	)
}
