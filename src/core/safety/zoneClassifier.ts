// ailiance-agent: 3-zone shell-command classifier ported from
// ailiance-agent-py-archive/src/ailiance_agent/tools/shell.py (classify_command).
//
// Zones:
//   - "auto_ok"   : safe read-only commands; run without prompting.
//   - "confirm"   : potentially side-effectful (network, package install,
//                   git push, ...); respects upstream approval flow.
//   - "hard_deny" : destructive (rm -rf, dd, mkfs, sudo, ...); ALWAYS
//                   refused, even with --yolo. Caller must surface
//                   exit_code=8 to match the Python contract.
//
// Keep these tables in lockstep with the Python source.

export type Zone = "auto_ok" | "confirm" | "hard_deny"

export const HARD_DENY_EXIT_CODE = 8

const AUTO_OK_FIRST = new Set([
	"pytest",
	"uv",
	"cargo",
	"npm",
	"pnpm",
	"yarn",
	"make",
	"cmake",
	"go",
	"rustc",
	"ls",
	"cat",
	"head",
	"tail",
	"find",
	"wc",
	"file",
	"black",
	"ruff",
	"prettier",
	"rustfmt",
	"gofmt",
	"clang-format",
	"ctest",
])

const AUTO_OK_GIT_SUBCMDS = new Set(["status", "diff", "log", "show", "branch", "tag", "remote"])

const NETWORK_PKG_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun", "pip", "uv", "cargo"])
const NETWORK_PKG_SUBCMDS = new Set(["install", "add", "i", "publish", "update", "upgrade"])

export const HARD_DENY_PATTERNS: RegExp[] = [
	/\brm\s+(-[a-zA-Z]*r[a-zA-Z]*\s+|-r\s+).*/,
	/\brm\s+-rf\b/,
	/\bdd\b.*\bof=\/dev\//,
	/\bmkfs\.[a-z0-9]+\b/,
	/\bshutdown\b/,
	/\breboot\b/,
	/:\(\)\s*\{.*:\|:&.*\};\s*:/,
	/\bchmod\s+-R\s+777\s+\//,
	/\bchown\s+-R\s+\S+\s+\//,
	/\bsudo\b/,
	/>\s*\/dev\/sd[a-z]/,
	/\bmv\b.*\/dev\/null/,
	/\b(rm|mv|cp|>)\s.*\s+\/etc\//,
	/\b(rm|mv|cp|>)\s.*\s+\/System\//,
	/\b(rm|mv|cp|>)\s.*\s+\/usr\//,
]

/**
 * Tokenise a shell command without invoking a subshell. We only need the
 * head + first sub-command, so a permissive whitespace split is enough; if
 * shell quoting is malformed we fall through to "confirm" (matching the
 * Python ValueError branch).
 */
function tokenize(cmd: string): string[] | null {
	const tokens: string[] = []
	let buf = ""
	let quote: '"' | "'" | null = null
	let escaped = false
	for (const ch of cmd) {
		if (escaped) {
			buf += ch
			escaped = false
			continue
		}
		if (ch === "\\" && quote !== "'") {
			escaped = true
			continue
		}
		if (quote) {
			if (ch === quote) {
				quote = null
			} else {
				buf += ch
			}
			continue
		}
		if (ch === '"' || ch === "'") {
			quote = ch
			continue
		}
		if (/\s/.test(ch)) {
			if (buf) {
				tokens.push(buf)
				buf = ""
			}
			continue
		}
		buf += ch
	}
	if (quote) return null
	if (buf) tokens.push(buf)
	return tokens
}

export function classifyCommand(cmd: string): Zone {
	if (!cmd || !cmd.trim()) return "hard_deny"
	for (const pattern of HARD_DENY_PATTERNS) {
		if (pattern.test(cmd)) return "hard_deny"
	}
	const tokens = tokenize(cmd)
	if (tokens === null) return "confirm"
	if (tokens.length === 0) return "hard_deny"
	const head = tokens[0]
	if (head === "git" && tokens.length > 1 && AUTO_OK_GIT_SUBCMDS.has(tokens[1])) {
		return "auto_ok"
	}
	if (head && NETWORK_PKG_MANAGERS.has(head) && tokens.length > 1 && NETWORK_PKG_SUBCMDS.has(tokens[1])) {
		return "confirm"
	}
	if (head && AUTO_OK_FIRST.has(head)) return "auto_ok"
	return "confirm"
}
