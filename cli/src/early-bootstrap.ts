/**
 * Pre-import bootstrap: must be the first import of cli/src/index.ts.
 *
 * ESM spec evaluates imported modules in source order, so any side effects in
 * this module run BEFORE the rest of `index.ts` imports (commander, ink, etc.)
 * load and potentially trigger terminal probes (CSI 14t / kitty Gi=31 / DA1).
 *
 * Putting stdin in raw mode here causes those probe replies to land in stdin
 * (where we can drain them later) instead of being echoed by the tty driver
 * onto stdout as visible garbage like "^[[4;704;920t ^[_Gi=31;OK^[\^[[?62c".
 */

if (process.stdin.isTTY) {
	try {
		process.stdin.setRawMode(true)
	} catch {
		// non-TTY, unsupported, or already raw — ignore
	}
}

// Swallow EPIPE on stdout/stderr. When the consumer of our piped output closes
// early (`isaac … | head`, quitting a pager, a closed SSH/TTY), an in-flight
// async write (Ink render, spinner, SIGINT line-clear) throws EPIPE. Without an
// 'error' listener Node escalates it to an uncaughtException, which the global
// handler prints as a scary stack trace. A closed downstream is a normal
// end-of-pipe, not a crash — exit cleanly instead. Attached here so the guard is
// live before any write can happen.
const swallowEpipe = (err: NodeJS.ErrnoException) => {
	if (err.code === "EPIPE") {
		process.exit(0)
	}
}
process.stdout.on("error", swallowEpipe)
process.stderr.on("error", swallowEpipe)
