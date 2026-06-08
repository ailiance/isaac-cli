import { shutdownEvent } from "../vscode-shim"
import { disposeCliContext } from "./cleanup"
import { activeContext, isPlainTextMode, isShuttingDown, setIsShuttingDown } from "./state"

export async function captureUnhandledException(reason: Error, context: string) {
	try {
		const { ErrorService } = await import("@/services/error/ErrorService")
		// ErrorService may not be initialized yet (e.g., error occurred before initializeCli())
		// so we guard with a try/get pattern rather than letting ErrorService.get() throw
		let errorService: any = null
		try {
			errorService = ErrorService.get()
		} catch {
			// ErrorService not yet initialized; skip capture
		}
		if (errorService) {
			await errorService.captureException(reason, { context })
			// dispose flushes any pending error captures to ensure they're sent before the process exits
			return errorService.dispose()
		}
	} catch {
		// Ignore errors during shutdown to avoid an infinite loop
		try {
			const { Logger } = await import("@/shared/services/Logger")
			Logger.info("Error capturing unhandled exception. Proceeding with shutdown.")
		} catch {
			// Even Logger failed
		}
	}
}

const EXIT_TIMEOUT_MS = 3000
export async function onUnhandledException(reason: unknown, context: string) {
	// A closed downstream pipe (EPIPE) is a normal end-of-pipe, not a crash.
	// Should the stream-level guard in early-bootstrap miss one, exit quietly
	// here instead of printing a stack trace for the user.
	if (reason instanceof Error && (reason as NodeJS.ErrnoException).code === "EPIPE") {
		process.exit(0)
	}

	const { Logger } = await import("@/shared/services/Logger")
	const { restoreConsole } = await import("./console")
	Logger.error("Unhandled exception:", reason)
	const finalError = reason instanceof Error ? reason : new Error(String(reason))

	restoreConsole()
	console.error(finalError)

	setTimeout(() => process.exit(1), EXIT_TIMEOUT_MS)

	captureUnhandledException(finalError, context).finally(() => {
		process.exit(1)
	})
}

export function setupSignalHandlers() {
	const shutdown = async (signal: string) => {
		const { printWarning } = await import("./display")
		if (isShuttingDown) {
			// Force exit on second signal
			process.exit(1)
		}
		setIsShuttingDown(true)

		// Notify components to hide UI before shutdown
		shutdownEvent.fire()

		// Only clear Ink UI lines if we're not in plain text mode
		// In plain text mode, there's no Ink UI to clear and the ANSI codes
		// would corrupt the streaming output
		if (!isPlainTextMode) {
			// Clear several lines to remove the input field and footer from display
			// Move cursor up and clear lines (input box + footer rows)
			const linesToClear = 8 // Input box (3 lines with border) + footer (4-5 lines)
			process.stdout.write(`\x1b[${linesToClear}A\x1b[J`)
		}

		printWarning(`${signal} received, shutting down...`)

		try {
			if (activeContext) {
				const task = activeContext.controller.task
				if (task) {
					task.abortTask()
				}
				await disposeCliContext(activeContext)
			} else {
				// Best-effort flush of restored yolo state when no active context
				try {
					const { StateManager } = await import("@/core/storage/StateManager")
					await StateManager.get().flushPendingState()
				} catch {
					// StateManager may not be initialized yet
				}
				try {
					const { ErrorService } = await import("@/services/error/ErrorService")
					await ErrorService.get().dispose()
				} catch {
					// ErrorService may not be initialized yet
				}
				await disposeCliContext(null) // This will call disposeTelemetryServices
			}
		} catch {
			// Best effort cleanup
		}

		process.exit(0)
	}

	process.on("SIGINT", () => shutdown("SIGINT"))
	process.on("SIGTERM", () => shutdown("SIGTERM"))

	// Suppress known abort errors from unhandled rejections
	// These occur when task is cancelled and async operations throw "Isaac instance aborted"
	process.on("unhandledRejection", async (reason: unknown) => {
		const message = reason instanceof Error ? reason.message : String(reason)
		// Silently ignore abort-related errors - they're expected during task cancellation
		if (message.includes("aborted") || message.includes("abort")) {
			try {
				const { Logger } = await import("@/shared/services/Logger")
				Logger.info("Suppressed unhandled rejection due to abort:", message)
			} catch {
				// Logger not available
			}
			return
		}

		// For other unhandled rejections, capture the exception and log to file via Logger (if available)
		// This won't show in terminal but will be in log files for debugging
		onUnhandledException(reason, "unhandledRejection")
	})

	process.on("uncaughtException", (reason: unknown) => {
		onUnhandledException(reason, "uncaughtException")
	})
}
