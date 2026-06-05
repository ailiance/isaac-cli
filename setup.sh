#!/usr/bin/env bash
#
# setup.sh — generic dev setup for the isaac-cli monorepo (canonical entry-point).
#
# Role:    bootstrap a development environment (Node toolchain, deps, protos,
#          CLI build, global link) so you can hack on / run the `isaac` CLI.
# Usage:   ./setup.sh [--all] [--ext] [--no-link] [--deps-only] [--help]
# OS:      macOS (Darwin), Linux (incl. WSL), and Windows via Git Bash/MSYS/Cygwin.
#          For native Windows, prefer PowerShell: pwsh -File scripts/setup.ps1
# Env:     ISAAC_NODE_VERSION  Node major to pin via nvm (default 22; supported 20–24).
#
# Idempotent: safe to re-run. Steps: deps -> protos -> cli:build -> cli:link -> smoke.

set -euo pipefail

ISAAC_NODE_VERSION="${ISAAC_NODE_VERSION:-22}"
DEPS_ONLY=0
DO_EXT=0      # also build the VS Code extension (npm run compile)
DO_LINK=1     # link the global `isaac` binary (npm run cli:link)
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ---- colours (TTY only) -----------------------------------------------------
if [ -t 1 ]; then
	C_RED=$'\033[31m'; C_GRN=$'\033[32m'; C_YLW=$'\033[33m'; C_BLU=$'\033[34m'; C_RST=$'\033[0m'
else
	C_RED=''; C_GRN=''; C_YLW=''; C_BLU=''; C_RST=''
fi
info() { printf '%s==>%s %s\n' "$C_BLU" "$C_RST" "$*"; }
ok()   { printf '%s[ok]%s %s\n'   "$C_GRN" "$C_RST" "$*"; }
warn() { printf '%s[!]%s %s\n'   "$C_YLW" "$C_RST" "$*" >&2; }
die()  { printf '%s[x]%s %s\n'   "$C_RED" "$C_RST" "$*" >&2; exit 1; }

usage() {
	cat <<EOF
setup.sh — dev setup for the isaac-cli monorepo

Usage: ./setup.sh [options]

Options:
  --all         Build CLI *and* VS Code extension.
  --ext         Also build the VS Code extension (npm run compile).
  --no-link     Build the CLI without linking the global \`isaac\` binary.
  --deps-only   Install dependencies only (skip protos, build, link, smoke).
  --help, -h    Show this help.

Env:
  ISAAC_NODE_VERSION   Node major to pin via nvm (default: 22; supported 20–24).

Native Windows users: prefer  pwsh -File scripts/setup.ps1
EOF
}

for arg in "$@"; do
	case "$arg" in
		--all) DO_EXT=1 ;;
		--ext) DO_EXT=1 ;;
		--no-link) DO_LINK=0 ;;
		--deps-only) DEPS_ONLY=1 ;;
		-h|--help) usage; exit 0 ;;
		*) die "Unknown option: $arg (see --help)" ;;
	esac
done

# ---- OS detection -----------------------------------------------------------
OS="$(uname -s)"
case "$OS" in
	Darwin) PLATFORM="macos" ;;
	Linux)
		if grep -qi microsoft /proc/version 2>/dev/null; then PLATFORM="wsl"; else PLATFORM="linux"; fi
		;;
	MINGW*|MSYS*|CYGWIN*) PLATFORM="windows" ;;
	*) PLATFORM="unknown" ;;
esac
info "Detected platform: $PLATFORM ($OS)"

# ---- Windows (Git Bash/MSYS/Cygwin): recommend PowerShell script ------------
if [ "$PLATFORM" = "windows" ]; then
	PWSH=""
	if command -v pwsh >/dev/null 2>&1; then PWSH="pwsh"
	elif command -v powershell >/dev/null 2>&1; then PWSH="powershell"; fi
	if [ -n "$PWSH" ] && [ -f "$ROOT_DIR/scripts/setup.ps1" ]; then
		warn "Native Windows detected. The PowerShell setup is recommended:"
		warn "    $PWSH -File scripts/setup.ps1"
		# Only prompt with a real terminal — over `curl | bash` stdin is the pipe.
		reply=""
		if [ -t 0 ] && [ -r /dev/tty ]; then
			printf 'Run it now via %s? [y/N] ' "$PWSH"
			read -r reply </dev/tty || reply=""
		fi
		case "$reply" in
			y|Y)
				# MSYS/Cygwin mangle unix-looking args passed to native pwsh.exe:
				# convert to a Windows path and exclude -File from auto-conversion.
				PS1_PATH="$ROOT_DIR/scripts/setup.ps1"
				command -v cygpath >/dev/null 2>&1 && PS1_PATH="$(cygpath -w "$PS1_PATH")"
				MSYS2_ARG_CONV_EXCL='-File' exec "$PWSH" -File "$PS1_PATH"
				;;
			*) info "Continuing with the bash path instead." ;;
		esac
	else
		warn "PowerShell not found; continuing with the bash path (Git Bash)."
	fi
fi

# ---- Node (nvm pin on unix-likes; system check on Windows-bash) -------------
check_node_major() {
	command -v node >/dev/null 2>&1 || return 1
	local major; major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
	[ "$major" -ge 20 ] && [ "$major" -le 24 ]
}

if [ "$PLATFORM" = "windows" ]; then
	# nvm-sh is not available here; verify the system Node only.
	if ! check_node_major; then
		die "Need Node 20–24. Install via nvm-windows (https://github.com/coreybutler/nvm-windows) or https://nodejs.org/"
	fi
	ok "Using system Node $(node -v)"
else
	export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
	if [ ! -s "$NVM_DIR/nvm.sh" ]; then
		info "nvm not found — installing nvm-sh..."
		curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash \
			|| die "nvm install failed; install Node 20–24 manually."
	fi
	# nvm.sh is not clean under `set -e`/`set -u` (it returns non-zero and
	# references unset vars) — relax both while sourcing, then restore.
	# shellcheck disable=SC1091
	set +eu; . "$NVM_DIR/nvm.sh"; set -eu
	info "Installing/using Node $ISAAC_NODE_VERSION via nvm..."
	nvm install "$ISAAC_NODE_VERSION" >/dev/null || die "nvm install $ISAAC_NODE_VERSION failed."
	nvm use "$ISAAC_NODE_VERSION" >/dev/null     || die "nvm use $ISAAC_NODE_VERSION failed."
	check_node_major || die "Active Node ($(node -v)) outside supported range 20–24."
	ok "Using Node $(node -v)"
fi

# ---- protoc check (non-blocking) --------------------------------------------
# NOTE: NOT a hard failure. scripts/build-proto.mjs prefers protoc bundled with
# the `grpc-tools` devDependency (installed by npm install), so a missing *system*
# protoc is usually fine. If `npm run protos` later fails, install protoc per hint.
if ! command -v protoc >/dev/null 2>&1; then
	case "$PLATFORM" in
		macos)        warn "system protoc not found (grpc-tools usually covers it). If protos fail: brew install protobuf" ;;
		linux|wsl)    warn "system protoc not found (grpc-tools usually covers it). If protos fail: apt install -y protobuf-compiler | dnf install protobuf-compiler | pacman -S protobuf" ;;
		windows)      warn "system protoc not found (grpc-tools usually covers it). If protos fail: choco install protoc (or scoop install protobuf)" ;;
		*)            warn "system protoc not found. Install the protobuf compiler if protos fail." ;;
	esac
else
	ok "protoc present: $(protoc --version)"
fi

# ---- dependencies -----------------------------------------------------------
cd "$ROOT_DIR"
info "Installing dependencies (root + cli workspaces + webview-ui)..."
# install:all = `npm install` (root+cli via npm workspaces) + webview-ui install.
# A failure here is most often webview-ui (step 2); root+cli (step 1) is what the
# CLI needs, so we re-ensure it and treat webview-ui as non-fatal for CLI use.
npm run install:all || {
	warn "install:all failed (likely webview-ui, non-fatal for the CLI); ensuring root+cli deps..."
	npm install || die "npm install (root+cli) failed."
	warn "webview-ui deps may be incomplete; run 'cd webview-ui && npm install' if you need the panel."
}
ok "Dependencies installed."

if [ "$DEPS_ONLY" -eq 1 ]; then
	ok "Done (deps only)."
	exit 0
fi

# ---- protos -----------------------------------------------------------------
info "Generating protobuf sources (npm run protos)..."
npm run protos || die "Proto generation failed (is protoc installed? see hint above)."
ok "Protos generated."

# ---- CLI build (+ optional global link) -------------------------------------
# cli:build re-runs protos, but the explicit step above gives a clearer error.
info "Building the CLI (npm run cli:build)..."
npm run cli:build || die "CLI build failed."
ok "CLI built."

if [ "$DO_LINK" -eq 1 ]; then
	info "Linking the global \`isaac\` binary (npm run cli:link)..."
	npm run cli:link || die "cli:link failed."
	if command -v isaac >/dev/null 2>&1; then ok "\`isaac\` available: $(command -v isaac)"
	else warn "\`isaac\` not on PATH — check \`npm prefix -g\`/bin."; fi
fi

# ---- optional VS Code extension build ---------------------------------------
if [ "$DO_EXT" -eq 1 ]; then
	info "Building the VS Code extension (npm run compile)..."
	npm run compile || die "Extension compile failed."
	ok "Extension compiled (dist/extension.js). Launch via F5 in VS Code."
fi

# ---- smoke test -------------------------------------------------------------
# The CLI silences console unless verbose, so `--version` output may be
# swallowed; treat empty output as inconclusive and fall back to `--help`.
info "Smoke test: node cli/dist/cli.mjs --version"
SMOKE_VER="$(node cli/dist/cli.mjs --version 2>/dev/null || true)"
if [ -n "$SMOKE_VER" ]; then
	ok "Smoke test passed (isaac $SMOKE_VER)."
elif node cli/dist/cli.mjs --help >/dev/null 2>&1; then
	ok "Smoke test passed (--help runs; --version printed nothing)."
else
	die "Smoke test failed — the built CLI did not run."
fi

# ---- final message ----------------------------------------------------------
echo
ok "Setup complete."
echo "Next steps:"
[ "$DO_LINK" -eq 1 ] && echo "  - Try it:                              isaac --help"
[ "$DO_LINK" -eq 0 ] && echo "  - Link the global binary:              npm run cli:link"
[ "$DO_EXT" -eq 1 ]  && echo "  - Extension: open the repo in VS Code, then F5"
if [ "$PLATFORM" != "windows" ]; then
	echo "  - In new shells, select Node again:    nvm use ${ISAAC_NODE_VERSION}"
fi
echo "  - Run the CLI from the repo:           node cli/dist/cli.mjs --help"
