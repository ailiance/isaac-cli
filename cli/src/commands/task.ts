import { exit } from "node:process"
import { initializeCli } from "../init"
import type { CliContext, TaskOptions } from "../types"
import { createInkCleanup, disposeCliContext, drainStdout } from "../utils/cleanup"
import { runInkApp } from "../utils/ink"
import { getPlainTextModeReason, shouldUsePlainTextMode } from "../utils/mode"
import { applyTaskOptions } from "../utils/options"
import { setIsPlainTextMode } from "../utils/state"

/**
 * Run a task in plain text mode (no Ink UI).
 * Handles auth check, task execution, cleanup, and exit.
 */
export async function runTaskInPlainTextMode(
	ctx: CliContext,
	options: TaskOptions,
	taskConfig: {
		prompt?: string
		taskId?: string
		imageDataUrls?: string[]
	},
): Promise<never> {
	const { isAuthConfigured } = await import("../utils/auth")
	const { printWarning } = await import("../utils/display")
	const { telemetryService } = await import("@/services/telemetry")
	const { runPlainTextTask } = await import("../utils/plain-text-task")

	// Set flag so shutdown handler knows not to clear Ink UI lines
	setIsPlainTextMode(true)

	// Check if auth is configured before attempting to run the task
	// In plain text mode we can't show the interactive auth flow
	const hasAuth = await isAuthConfigured()
	if (!hasAuth) {
		// ailiance-agent: rebrand 'isaac auth' -> 'isaac auth'
		printWarning("Not authenticated. Please run 'isaac auth' first to configure your API credentials.")
		await disposeCliContext(ctx)
		exit(1)
	}

	const reason = await getPlainTextModeReason(options)
	telemetryService.captureHostEvent("plain_text_mode", reason)

	// Plain text mode: no Ink rendering, just clean text output
	const success = await runPlainTextTask({
		controller: ctx.controller,
		yolo: options.yolo || options.autoApproveAll,
		prompt: taskConfig.prompt,
		taskId: taskConfig.taskId,
		imageDataUrls: taskConfig.imageDataUrls,
		verbose: options.verbose,
		jsonOutput: options.json,
		timeoutSeconds: options.timeout ? Number.parseInt(options.timeout, 10) : undefined,
	})

	// Cleanup
	await disposeCliContext(ctx)

	// Ensure stdout is fully drained before exiting - critical for piping
	await drainStdout()
	exit(success ? 0 : 1)
}

/**
 * Run a task with the given prompt - uses welcome view for consistent behavior
 */
// ailiance-agent: greeting short-circuit
// Skip the agent loop on trivial prompts ("bonjour", "test", "hi"...) which
// otherwise cause the model to spin in an infinite tool-call retry loop
// because the agent runtime expects every user turn to produce a tool_call.
const GREETING_RE = /^(bonjour|bonsoir|salut|hi|hello|coucou|test|ping|hey|yo|hola|ciao)\s*[!?.]*\s*$/i

function isTrivialGreeting(prompt: string): boolean {
	const trimmed = prompt.trim()
	if (!trimmed) return true
	if (GREETING_RE.test(trimmed)) return true
	if (trimmed.length < 4) return true
	return false
}

export async function runTask(prompt: string, options: TaskOptions & { images?: string[] }, existingContext?: CliContext) {
	// ailiance-agent: short-circuit greetings before spinning up the full agent.
	if (isTrivialGreeting(prompt)) {
		// Use process.stdout directly — Ink isn't mounted yet.
		process.stdout.write(
			"\n👋 Hi! ISAAC is a coding agent — give it a task with a goal.\n" +
				"   Examples:\n" +
				"     isaac t -y \"create hello.py with print('hi')\"\n" +
				'     isaac t -y "fix the failing test in tests/foo.py"\n' +
				'     isaac t -y --model ailiance-qwen "add a /healthz endpoint to api.py"\n\n' +
				"   For chat-style replies, hit the gateway directly:\n" +
				"     curl http://100.78.191.52:9300/v1/chat/completions \\\n" +
				"       -H 'Content-Type: application/json' \\\n" +
				'       -d \'{"model":"ailiance-eurollm","messages":[{"role":"user","content":"..."}]}\'\n\n',
		)
		exit(0)
	}

	const { parseImagesFromInput, processImagePaths } = await import("../utils/parser")
	const { telemetryService } = await import("@/services/telemetry")
	const { StateManager } = await import("@/core/storage/StateManager")
	const { checkRawModeSupport } = await import("../context/StdinContext")
	const React = (await import("react")).default
	const { App } = await import("../components/App")

	const ctx = existingContext || (await initializeCli({ ...options, enableAuth: true }))

	// Parse images from the prompt text (e.g., @/path/to/image.png)
	const { prompt: cleanPrompt, imagePaths: parsedImagePaths } = parseImagesFromInput(prompt)

	// Combine parsed image paths with explicit --images option
	const allImagePaths = [...(options.images || []), ...parsedImagePaths]
	// Convert image file paths to base64 data URLs
	const imageDataUrls = await processImagePaths(allImagePaths)

	// Use clean prompt (with image refs removed)
	const taskPrompt = cleanPrompt || prompt

	// Task without prompt starts in interactive mode
	telemetryService.captureHostEvent("task_command", prompt ? "task" : "interactive")

	// Capture piped stdin telemetry now that HostProvider is initialized
	if (options.stdinWasPiped) {
		telemetryService.captureHostEvent("piped", "detached")
	}

	// Apply shared task options (mode, model, thinking, yolo)
	await applyTaskOptions(options)
	await StateManager.get().flushPendingState()

	// Use plain text mode when output is redirected, stdin was piped, JSON mode is enabled, or --yolo flag is used
	if (await shouldUsePlainTextMode(options)) {
		return runTaskInPlainTextMode(ctx, options, {
			prompt: taskPrompt,
			imageDataUrls: imageDataUrls.length > 0 ? imageDataUrls : undefined,
		})
	}

	// Interactive mode: Render the welcome view with optional initial prompt/images
	// If prompt provided (isaac task "prompt"), ChatView will auto-submit
	// If no prompt (isaac interactive), user will type it in
	let taskError = false

	await runInkApp(
		React.createElement(App, {
			view: "welcome",
			verbose: options.verbose,
			controller: ctx.controller,
			isRawModeSupported: checkRawModeSupport(),
			initialPrompt: taskPrompt || undefined,
			initialImages: imageDataUrls.length > 0 ? imageDataUrls : undefined,
			onError: () => {
				taskError = true
			},
			onWelcomeExit: () => {
				// User pressed Esc; Ink exits and cleanup handles process exit.
			},
		}),
		createInkCleanup(ctx, () => taskError),
	)
}
