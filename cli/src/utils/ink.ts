// ailiance-agent: drain pending terminal-probe responses (CSI 14t / kitty Gi=31 / DA1)
// before Ink starts rendering. Probes are typically buffered by raw mode set early
// (see installEarlyTtyHardening in index.ts). Here we only flush whatever bytes
// look like escape sequences — preserving any user keystrokes (e.g. a quick Enter)
// that may have arrived in the same buffer.
function drainEscapeSequencesOnly(): void {
	if (!process.stdin.isTTY) return
	try {
		let chunk: Buffer | null
		// biome-ignore lint/suspicious/noAssignInExpressions: idiomatic drain loop
		while ((chunk = process.stdin.read() as Buffer | null) !== null) {
			// If chunk contains user keystrokes (no ESC byte), put them back.
			// We use a simple heuristic: chunks starting with 0x1b (ESC) are
			// terminal replies; anything else is treated as user input.
			if (chunk.length === 0 || chunk[0] === 0x1b) {
				continue // discard escape reply
			}
			// Re-inject for Ink to consume
			process.stdin.unshift(chunk)
			break
		}
	} catch {
		// Non-TTY or unsupported terminal — nothing to drain.
	}
}

/**
 * Run an Ink app with proper cleanup handling
 */
export async function runInkApp(element: any, cleanup: () => Promise<void>): Promise<void> {
	const { render } = await import("ink")
	const { restoreConsole } = await import("./console")

	// ailiance-agent: consume probe replies that arrived during boot.
	// Raw mode is already on (set in index.ts top-level), so probes were
	// buffered without echoing to stdout. We discard escape sequences but
	// preserve any keystrokes the user may have typed during boot.
	drainEscapeSequencesOnly()

	// Clear terminal for clean UI - robot will render at row 1
	process.stdout.write("\x1b[2J\x1b[H")
	const shouldPrimeRawMode =
		process.platform === "win32" && process.stdin.isTTY && typeof process.stdin.setRawMode === "function"
	const wasRaw = process.stdin.isRaw === true
	const wasPaused = process.stdin.isPaused()

	if (shouldPrimeRawMode) {
		try {
			process.stdin.setRawMode(true)
			process.stdin.resume()
		} catch {
			// Ink will still attempt to initialize raw mode.
		}
	}

	// Note: incrementalRendering is enabled to reduce terminal bandwidth and improve responsiveness.
	// We previously disabled this due to resize glitches, but our useTerminalSize hook now
	// handles this by clearing the screen and forcing a full React remount on resize,
	// which resets Ink's internal line tracking.
	const { waitUntilExit, unmount } = render(element, {
		exitOnCtrlC: true,
		patchConsole: false,
		// @ts-expect-error: synchronizedUpdateMode is supported by @jrichman/ink but not in the type definitions
		synchronizedUpdateMode: true,
		incrementalRendering: true,
	})

	try {
		await waitUntilExit()
	} finally {
		try {
			unmount()
		} catch {
			// Already unmounted
		}
		if (shouldPrimeRawMode) {
			try {
				process.stdin.setRawMode(wasRaw)
				if (wasPaused) {
					process.stdin.pause()
				}
			} catch {
				// Ignore cleanup failures on nonstandard terminals.
			}
		}
		restoreConsole()
		await cleanup()
	}
}
