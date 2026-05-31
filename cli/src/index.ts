/**
 * ISAAC CLI - TypeScript implementation with React Ink (fork of Dirac/Cline)
 */

// MUST be the first import — its top-level side effect (raw-mode stdin) runs
// before any other import is evaluated, preventing terminal probe replies
// from being echoed to stdout. ESM evaluates imports in source order.
import "./early-bootstrap"

import { exit } from "node:process"
import { Command } from "commander"
import { version as CLI_VERSION } from "../package.json"
import { suppressConsoleUnlessVerbose } from "./utils/console"
import { CLI_LOG_FILE } from "./vscode-shim"
import { setupSignalHandlers } from "./utils/errors"

// CLI-only behavior: suppress console output unless verbose mode is enabled.
// Kept explicit here so importing the library bundle does not mutate global console methods.
suppressConsoleUnlessVerbose()

// Setup signal handlers for graceful shutdown
setupSignalHandlers()

// Re-export for backward compatibility and testing
export { captureUnhandledException } from "./utils/errors"
export { shouldDoQuickAuth, hasExplicitAuthQuickSetupFlags } from "./commands/auth"

// Setup CLI commands
const program = new Command()

// ailiance-agent fork: rebrand CLI banner
program
	.name("isaac")
	.description("ISAAC — Intelligence Souveraine Ailiance Agent Codeur (fork of Dirac/Cline)")
	.version(CLI_VERSION)

// Enable positional options to avoid conflicts between root and subcommand options with the same name
program.enablePositionalOptions()

program
	.command("task")
	.alias("t")
	.description("Run a new task")
	.argument("<prompt>", "The task prompt")
	.option("-a, --act", "Run in act mode")
	.option("-p, --plan", "Run in plan mode")
	.option("-y, --yolo", "Enable yes/yolo mode (auto-approve actions)")
	.option("--auto-approve-all", "Enable auto-approve all actions while keeping interactive mode")
	.option("-t, --timeout <seconds>", "Optional timeout in seconds (applies only when provided)")
	.option("-m, --model <model>", "Model to use for the task")
	.option("--provider <provider>", "API provider to use (requires --model)")
	.option("-v, --verbose", "Show verbose output")
	.option("-c, --cwd <path>", "Working directory for the task")
	.option("--config <path>", "Path to ISAAC configuration directory")
	.option("--thinking [tokens]", "Enable extended thinking (default: 1024 tokens)")
	.option("--reasoning-effort <effort>", "Reasoning effort: none|low|medium|high|xhigh")
	.option("--max-consecutive-mistakes <count>", "Maximum consecutive mistakes before halting in yolo mode")
	.option("--json", "Output messages as JSON instead of styled text")
	.option("--double-check-completion", "Reject first completion attempt to force re-verification")
	.option("--auto-condense", "Enable AI-powered context compaction instead of mechanical truncation")
	.option("--subagents", "Enable subagents for the task")
	.option("--hooks-dir <path>", "Path to additional hooks directory for runtime hook injection")
	.option("-T, --taskId <id>", "Resume an existing task by ID")
	.option(
		"--mcp <servers>",
		"Comma-separated allowlist of plugin MCP servers to load (e.g. github,context7); only these load this run",
	)
	.option("--no-mcp", "Disable all plugin MCP servers for this run (smaller prompt, faster on big-context backends)")
	.action(async (prompt, options) => {
		// Per-run MCP control. Commander sets options.mcp = false for --no-mcp,
		// or the string list for --mcp <servers>. Surfaced to the core MCP
		// bootstrap (src/core/mcp/bootstrap.ts) via env so no global config is touched.
		if (options.mcp === false) {
			process.env.AILIANCE_NO_MCP = "1"
		} else if (typeof options.mcp === "string") {
			process.env.AILIANCE_MCP_SERVERS = options.mcp
		}
		const { runTask } = await import("./commands/task")
		const { resumeTask } = await import("./commands/resume")
		if (options.taskId) {
			return resumeTask(options.taskId, { ...options, initialPrompt: prompt })
		}
		return runTask(prompt, options)
	})

program
	.command("history")
	.alias("h")
	.description("List task history")
	.option("-n, --limit <number>", "Number of tasks to show", "10")
	.option("-p, --page <number>", "Page number (1-based)", "1")
	.option("--config <path>", "Path to ISAAC configuration directory")
	.action(async (options) => {
		const { listHistory } = await import("./commands/history")
		return listHistory(options)
	})

program
	.command("timeline")
	.alias("tl")
	.description("Show recent tasks grouped by day")
	.option("-d, --days <n>", "Number of days back", "30")
	.option("-l, --limit <n>", "Max entries", "200")
	.action(async (options) => {
		const { runTimeline } = await import("./commands/timeline")
		return runTimeline(options)
	})

program
	.command("config")
	.description("Show current configuration")
	.option("--config <path>", "Path to ISAAC configuration directory")
	.action(async (options) => {
		const { showConfig } = await import("./commands/config")
		return showConfig(options)
	})

program
	.command("auth")
	.description("Authenticate a provider and configure what model is used")
	.option("-p, --provider <id>", "Provider ID for quick setup (e.g., openai-native, anthropic, moonshot)")
	.option("-k, --apikey <key>", "API key for the provider")
	.option("-m, --modelid <id>", "Model ID to configure (e.g., gpt-4o, claude-sonnet-4-6, kimi-k2.5)")
	.option("-b, --baseurl <url>", "Base URL (optional, only for openai provider)")
	.option("--azure-api-version <version>", "Azure API version (optional, only for azure openai)")
	.option("-v, --verbose", "Show verbose output")
	.option("-c, --cwd <path>", "Working directory for the task")
	.option("--config <path>", "Path to ISAAC configuration directory")
	.action(async (options) => {
		const { runAuth } = await import("./commands/auth")
		return runAuth(options)
	})

program
	.command("version")
	.description("Show ISAAC CLI version number")
	.action(async () => {
		const { printInfo } = await import("./utils/display")
		printInfo(`ISAAC CLI version: ${CLI_VERSION}`)
	})

program
	.command("update")
	.description("Check for updates and install if available")
	.option("-v, --verbose", "Show verbose output")
	.action(async (options) => {
		const { checkForUpdates } = await import("./utils/update")
		return checkForUpdates(CLI_VERSION, options)
	})

// ailiance-agent fork: drop upstream Dirac kanban integration — we don't ship it.

// ailiance-agent fork: cross-task memory CRUD CLI (v0.9.0).
const memoryCommand = program.command("memory").description("Manage cross-task memories")
memoryCommand
	.command("remember")
	.description("Save a new memory")
	.argument("<title>", "Short title (becomes slugified name + description)")
	.argument("[body]", "Memory body (defaults to title)")
	.option("--type <type>", "user | feedback | project | reference", "user")
	.option("--scope <scope>", "global or project:<slug>", "global")
	.action(async (title, body, options) => {
		const { runMemoryRemember } = await import("./commands/memory")
		await runMemoryRemember({ title, body, type: options.type, scope: options.scope })
	})
memoryCommand
	.command("list")
	.description("List saved memories")
	.option("--type <type>", "Filter by type")
	.option("--scope <scope>", "Filter by scope")
	.action(async (options) => {
		const { runMemoryList } = await import("./commands/memory")
		await runMemoryList({ type: options.type, scope: options.scope })
	})
memoryCommand
	.command("show")
	.description("Show the full body of a memory")
	.argument("<name>", "Memory name (or fuzzy match)")
	.action(async (name) => {
		const { runMemoryShow } = await import("./commands/memory")
		await runMemoryShow({ name })
	})
memoryCommand
	.command("forget")
	.description("Delete a memory by name")
	.argument("<name>", "Exact memory name")
	.action(async (name) => {
		const { runMemoryForget } = await import("./commands/memory")
		await runMemoryForget({ name })
	})

// ailiance-agent fork: trace rotation + listing CLI
const traceCommand = program.command("trace").description("Manage ISAAC run traces")

traceCommand
	.command("list")
	.description("List run directories under .ailiance-agent/runs/")
	.option("-c, --cwd <path>", "Working directory")
	.action(async (options) => {
		const { runTraceList } = await import("./commands/trace")
		return runTraceList(options)
	})

traceCommand
	.command("prune")
	.description("Prune old run traces (default: keep 30d or 1G, whichever is more permissive)")
	.option("-c, --cwd <path>", "Working directory")
	.option("--max-age <days>", "Maximum age in days", "30")
	.option("--max-size <size>", "Maximum total size (e.g. 1G, 500M)", "1G")
	.action(async (options) => {
		const { runTracePrune } = await import("./commands/trace")
		return runTracePrune(options)
	})

// Plugin marketplace command with subcommands
const pluginCmd = program.command("plugin").description("Manage Claude Code plugins")

pluginCmd
	.command("install <target>")
	.description("Install plugin from github (user/repo) or URL")
	.action(async (target) => {
		const { runPluginInstall } = await import("./commands/plugin")
		return runPluginInstall(target)
	})

pluginCmd
	.command("list")
	.description("List installed plugins")
	.action(async () => {
		const { runPluginList } = await import("./commands/plugin")
		return runPluginList()
	})

pluginCmd
	.command("remove <name>")
	.description("Remove a plugin")
	.action(async (name) => {
		const { runPluginRemove } = await import("./commands/plugin")
		return runPluginRemove(name)
	})

pluginCmd
	.command("update [name]")
	.description("Update plugin(s) — omit name to update all")
	.action(async (name) => {
		const { runPluginUpdate } = await import("./commands/plugin")
		return runPluginUpdate(name)
	})

// Dev command with subcommands
const devCommand = program.command("dev").description("Developer tools and utilities")

devCommand
	.command("log")
	.description("Open the log file")
	.action(async () => {
		const { openExternal } = await import("@/utils/env")
		await openExternal(CLI_LOG_FILE)
	})

// Interactive mode (default when no command given)
program
	.argument("[prompt]", "Task prompt (starts task immediately)")
	.option("-a, --act", "Run in act mode")
	.option("-p, --plan", "Run in plan mode")
	.option("-y, --yolo", "Enable yolo mode (auto-approve actions)")
	.option("--auto-approve-all", "Enable auto-approve all actions while keeping interactive mode")
	.option("-t, --timeout <seconds>", "Optional timeout in seconds (applies only when provided)")
	.option("-m, --model <model>", "Model to use for the task")
	.option("--provider <provider>", "API provider to use (requires --model)")
	.option("-v, --verbose", "Show verbose output")
	.option("-c, --cwd <path>", "Working directory")
	.option("--config <path>", "Configuration directory")
	.option("--thinking [tokens]", "Enable extended thinking (default: 1024 tokens)")
	.option("--reasoning-effort <effort>", "Reasoning effort: none|low|medium|high|xhigh")
	.option("--max-consecutive-mistakes <count>", "Maximum consecutive mistakes before halting in yolo mode")
	.option("--json", "Output messages as JSON instead of styled text")
	.option("--double-check-completion", "Reject first completion attempt to force re-verification")
	.option("--auto-condense", "Enable AI-powered context compaction instead of mechanical truncation")
	.option("--subagents", "Enable subagents for the task")
	.option("--headers <headers>", "Custom headers for OpenAI-compatible provider (key1=value1,key2=value2 or JSON)")
	.option("--hooks-dir <path>", "Path to additional hooks directory for runtime hook injection")
	.option("--acp", "Run in ACP (Agent Client Protocol) mode for editor integration")
	.option("-T, --taskId <id>", "Resume an existing task by ID")
	.option("--continue", "Resume the most recent task from the current working directory")
	.option(
		"--mcp <servers>",
		"Comma-separated allowlist of plugin MCP servers to load (e.g. github,context7); only these load this run",
	)
	.option("--no-mcp", "Disable all plugin MCP servers for this run (smaller prompt, faster on big-context backends)")
	.action(async (prompt, options) => {
		// Per-run MCP control (mirrors the `task` command): surfaced to the core
		// MCP bootstrap via env so no global config is touched.
		if (options.mcp === false) {
			process.env.AILIANCE_NO_MCP = "1"
		} else if (typeof options.mcp === "string") {
			process.env.AILIANCE_MCP_SERVERS = options.mcp
		}
		// ailiance-agent fork: kanban path removed.
		const { printWarning } = await import("./utils/display")
		// Check for ACP mode first - this takes precedence over everything else
		if (options.acp) {
			const { runAcpMode } = await import("./acp/index.js")
			await runAcpMode({
				config: options.config,
				cwd: options.cwd,
				hooksDir: options.hooksDir,
				verbose: options.verbose,
			})
			return
		}

		// Always check for piped stdin content
		const { readStdinIfPiped } = await import("./utils/piped")
		const stdinInput = await readStdinIfPiped()

		// Track whether stdin was actually piped (even if empty) vs not piped (null)
		// stdinInput === null means stdin wasn't piped (TTY or not FIFO/file)
		// stdinInput === "" means stdin was piped but empty
		// stdinInput has content means stdin was piped with data
		const stdinWasPiped = stdinInput !== null

		if (options.taskId && options.continue) {
			printWarning("Use either --taskId or --continue, not both.")
			exit(1)
		}

		if (options.continue) {
			if (prompt) {
				printWarning("Use --continue without a prompt.")
				exit(1)
			}
			if (stdinWasPiped) {
				printWarning("Use --continue without piped input.")
				exit(1)
			}
			const { continueTask } = await import("./commands/resume")
			await continueTask(options)
			return
		}

		// Error if stdin was piped but empty AND no prompt was provided
		// This handles:
		// - `echo "" | dirac` -> error (empty stdin, no prompt)
		// - `dirac "prompt"` in GitHub Actions -> OK (empty stdin ignored, has prompt)
		// - `cat file | dirac "explain"` -> OK (has stdin AND prompt)
		if (stdinInput === "" && !prompt) {
			printWarning("Empty input received from stdin. Please provide content to process.")
			exit(1)
		}

		// If no prompt argument, check if input is piped via stdin
		let effectivePrompt = prompt
		if (stdinInput) {
			if (effectivePrompt) {
				// Prepend stdin content to the prompt
				effectivePrompt = `${stdinInput}\n\n${effectivePrompt}`
			} else {
				effectivePrompt = stdinInput
			}

			// Debug: show that we received piped input
			if (options.verbose) {
				process.stderr.write(`[debug] Received ${stdinInput.length} bytes from stdin\n`)
			}
		}

		// Handle --taskId flag to resume an existing task
		if (options.taskId) {
			const { resumeTask } = await import("./commands/resume")
			await resumeTask(options.taskId, {
				...options,
				initialPrompt: effectivePrompt,
				stdinWasPiped,
			})
			return
		}

		if (effectivePrompt) {
			const { runTask } = await import("./commands/task")
			// Pass stdinWasPiped flag so runTask knows to use plain text mode
			await runTask(effectivePrompt, { ...options, stdinWasPiped })
		} else {
			const { showWelcome } = await import("./commands/welcome")
			// Show welcome prompt if no prompt given
			await showWelcome(options)
		}
	})

// LiteLLM proxy management
const proxyCmd = program.command("proxy").description("Manage local LiteLLM proxy")

proxyCmd
	.command("install")
	.description("Install LiteLLM in dedicated venv (~/.isaac/litellm-venv)")
	.action(async () => {
		const { runProxyInstall } = await import("./commands/proxy")
		return runProxyInstall()
	})

proxyCmd
	.command("start")
	.description("Start the LiteLLM proxy")
	.option("-p, --port <port>", "port to listen on", "4000")
	.action(async (opts) => {
		const { runProxyStart } = await import("./commands/proxy")
		return runProxyStart({ port: Number.parseInt(opts.port, 10) })
	})

proxyCmd
	.command("stop")
	.description("Stop the LiteLLM proxy")
	.action(async () => {
		const { runProxyStop } = await import("./commands/proxy")
		return runProxyStop()
	})

proxyCmd
	.command("status")
	.description("Get LiteLLM proxy status")
	.action(async () => {
		const { runProxyStatus } = await import("./commands/proxy")
		return runProxyStatus()
	})

// Jina semantic router management
const routerCmd = program.command("router").description("Manage local Jina semantic router")

routerCmd
	.command("install")
	.description("Install Jina router in dedicated venv (~/.isaac/jina-router-venv)")
	.action(async () => {
		const { runRouterInstall } = await import("./commands/router")
		return runRouterInstall()
	})

routerCmd
	.command("start")
	.description("Start the Jina semantic router (first run downloads ~80 MB model from Hugging Face)")
	.option("-p, --port <port>", "port to listen on", "5050")
	.action(async (opts) => {
		const { runRouterStart } = await import("./commands/router")
		return runRouterStart({ port: Number.parseInt(opts.port, 10) })
	})

routerCmd
	.command("stop")
	.description("Stop the Jina semantic router")
	.action(async () => {
		const { runRouterStop } = await import("./commands/router")
		return runRouterStop()
	})

routerCmd
	.command("status")
	.description("Get Jina semantic router status")
	.action(async () => {
		const { runRouterStatus } = await import("./commands/router")
		return runRouterStatus()
	})

// Local stack management (proxy + router together)
const stackCmd = program.command("stack").description("Manage local stack (proxy + router)")
stackCmd
	.command("install")
	.description("Install both proxy and router")
	.action(async () => {
		const { runStackInstall } = await import("./commands/stack")
		return runStackInstall()
	})
stackCmd
	.command("start")
	.description("Start the full stack")
	.action(async () => {
		const { runStackStart } = await import("./commands/stack")
		return runStackStart()
	})
stackCmd
	.command("stop")
	.description("Stop the full stack")
	.action(async () => {
		const { runStackStop } = await import("./commands/stack")
		return runStackStop()
	})
stackCmd
	.command("status")
	.description("Get stack status")
	.action(async () => {
		const { runStackStatus } = await import("./commands/stack")
		return runStackStatus()
	})

// Parse and run
if (process.env.VITEST !== "true") {
	program.parse()
}
