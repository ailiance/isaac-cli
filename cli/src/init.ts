import { version as CLI_VERSION } from "../package.json"
import type { CliContext, InitOptions } from "./types"
import { setActiveContext } from "./utils/state"
import { window } from "./vscode-shim"

/**
 * Initialize all CLI infrastructure and return context needed for commands
 */
export async function initializeCli(options: InitOptions): Promise<CliContext> {
	const { setRuntimeHooksDir } = await import("@/core/storage/disk")
	const { initializeCliContext } = await import("./vscode-context")
	const { Logger } = await import("@/shared/services/Logger")
	const { IsaacEndpoint } = await import("@/config")
	const { autoUpdateOnStartup } = await import("./utils/update")
	const { Session } = await import("@/shared/services/Session")
	const { AuthHandler } = await import("@/services/auth/AuthHandler")
	const { HostProvider } = await import("@/hosts/host-provider")
	const { CliWebviewProvider } = await import("./controllers/CliWebviewProvider")
	const { FileEditProvider } = await import("@/integrations/editor/FileEditProvider")
	const { CliCommentReviewController } = await import("./controllers/CliCommentReviewController")
	const { StandaloneTerminalManager } = await import("@/integrations/terminal/standalone/StandaloneTerminalManager")
	const { createCliHostBridgeProvider } = await import("./controllers")
	const { getCliBinaryPath, ISAAC_CLI_DIR } = await import("./utils/path")
	const { StateManager } = await import("@/core/storage/StateManager")
	const { ErrorService } = await import("@/services/error/ErrorService")
	const { telemetryService } = await import("@/services/telemetry")
	const { SymbolIndexService } = await import("@/services/symbol-index/SymbolIndexService")

	const workspacePath = options.cwd || process.cwd()
	setRuntimeHooksDir(options.hooksDir)
	const { extensionContext, storageContext, DATA_DIR, EXTENSION_DIR } = initializeCliContext({
		isaacDir: options.config,
		workspaceDir: workspacePath,
	})

	// Set up output channel and Logger early so IsaacEndpoint.initialize logs are captured
	const outputChannel = window.createOutputChannel("ISAAC CLI")
	const logToChannel = (message: string) => outputChannel.appendLine(message)

	// Configure the shared Logging class early to capture all initialization logs
	Logger.subscribe(logToChannel)

	await IsaacEndpoint.initialize(EXTENSION_DIR)

	// Auto-update check (after endpoints initialized, so we can detect bundled configs)
	autoUpdateOnStartup(CLI_VERSION)

	// Initialize/reset session tracking for this CLI run
	Session.reset()

	if (options.enableAuth) {
		AuthHandler.getInstance().setEnabled(true)
	}

	outputChannel.appendLine(
		`ISAAC CLI initialized. Data dir: ${DATA_DIR}, Extension dir: ${EXTENSION_DIR}, Log dir: ${ISAAC_CLI_DIR.log}`,
	)

	HostProvider.initialize(
		"cli",
		() => new CliWebviewProvider(extensionContext as any),
		() => new FileEditProvider(),
		() => new CliCommentReviewController(),
		() => new StandaloneTerminalManager(),
		createCliHostBridgeProvider(workspacePath),
		logToChannel,
		async (path: string) => (options.enableAuth ? AuthHandler.getInstance().getCallbackUrl(path) : ""),
		getCliBinaryPath,
		EXTENSION_DIR,
		DATA_DIR,
		async (_cwd: string) => undefined,
	)

	await StateManager.initialize(storageContext)
	const stateManager = StateManager.get()
	const { getProviderFromEnv } = await import("@shared/storage/env-config")
	const envProvider = getProviderFromEnv()
	if (envProvider) {
		if (!stateManager.getGlobalSettingsKey("actModeApiProvider")) {
			stateManager.setSessionOverride("actModeApiProvider", envProvider)
		}
		if (!stateManager.getGlobalSettingsKey("planModeApiProvider")) {
			stateManager.setSessionOverride("planModeApiProvider", envProvider)
		}
	}
	// ailiance-agent: ailiance default fallback (touches: cli/src/init.ts)
	const { applyAilianceDefault } = await import("./utils/ailiance-default")
	const ailianceDecision = applyAilianceDefault(stateManager)
	if (ailianceDecision.applied) {
		outputChannel.appendLine(`ailiance default applied (${ailianceDecision.reason}) gateway=${ailianceDecision.gatewayUrl}`)
	}
	await ErrorService.initialize()

	// ailiance-agent: prewarm gateway before the first prompt. Caches
	// the model list and surfaces connection failures at boot instead of
	// on the first chat completion (where the user sees an opaque retry
	// storm). Failure is non-fatal — the CLI must still boot so the user
	// can override AILIANCE_GATEWAY and retry.
	const { prewarmAilianceGateway, formatPrewarmLog } = await import("./utils/ailiance-prewarm")
	const prewarm = await prewarmAilianceGateway(stateManager)
	outputChannel.appendLine(formatPrewarmLog(prewarm))
	if (!prewarm.ok) {
		// Make sure the user actually sees the failure — appendLine alone
		// only writes to the output channel buffer, which the standalone
		// CLI does not surface unless --verbose. Stderr is the contract.
		// eslint-disable-next-line no-console
		console.error(`[ISAAC] ${formatPrewarmLog(prewarm)}`)
	}

	const webview = HostProvider.get().createIsaacWebviewProvider() as any
	const controller = webview.controller as any

	await telemetryService.captureExtensionActivated()
	await telemetryService.captureHostEvent("isaac_cli", "initialized")

	// =============== Symbol Index Service ===============
	// Initialize symbol index for the project in background
	SymbolIndexService.getInstance()
		.initialize(workspacePath)
		.catch((error) => {
			Logger.error("[Isaac] Failed to initialize SymbolIndexService:", error)
		})

	const ctx = { extensionContext, dataDir: DATA_DIR, extensionDir: EXTENSION_DIR, workspacePath, controller }
	setActiveContext(ctx)
	return ctx
}
