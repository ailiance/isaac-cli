// ailiance-agent fork: telemetry DISABLED.
// Upstream Isaac sends PostHog events to dirac.run / us.posthog.com.
// The ailiance-agent fork is EU-sovereign by design and MUST NOT phone home.
// To re-enable for testing only, restore the upstream apiKey and host
// values from `git show upstream/master:src/shared/services/config/dirac-telemetry-config.ts`.
import { BUILD_CONSTANTS } from "../../constants"

export interface IsaacTelemetryClientConfig {
	/**
	 * The main API key for Isaac telemetry service.
	 */
	apiKey?: string | undefined
	/**
	 * The API key for Isaac used only for error tracking service.
	 */
	errorTrackingApiKey?: string | undefined
	enableErrorAutocapture?: boolean
	host: string
	uiHost: string
}

/**
 * Helper type for a valid Isaac client configuration.
 * Must contains api keys for both telemetry and error tracking.
 */
export interface IsaacTelemetryClientValidConfig extends IsaacTelemetryClientConfig {
	apiKey: string
	errorTrackingApiKey: string
}

/**
 * NOTE: Ensure that dev environment is not used in production.
 * process.env.CI will always be true in the CI environment, during both testing and publishing step,
 * so it is not a reliable indicator of the environment.
 */
const _useDevEnv = process.env.IS_DEV === "true" || process.env.DIRAC_ENVIRONMENT === "local"

/**
 * Isaac telemetry configuration.
 * ailiance-agent fork: all phone-home values are intentionally null/undefined so
 * `isIsaacTelemetryConfigValid` always returns false and consumers (telemetry,
 * error tracking, feature flags) skip remote writes / fetches.
 */
export const diracTelemetryConfig: IsaacTelemetryClientConfig = {
	apiKey: BUILD_CONSTANTS.TELEMETRY_SERVICE_API_KEY || undefined,
	errorTrackingApiKey: BUILD_CONSTANTS.ERROR_SERVICE_API_KEY || undefined,
	host: "",
	uiHost: "",
	enableErrorAutocapture: false,
}

const isTestEnv = process.env.E2E_TEST === "true" || process.env.IS_TEST === "true"

export function isIsaacTelemetryConfigValid(config: IsaacTelemetryClientConfig): config is IsaacTelemetryClientValidConfig {
	// Allow invalid config in test environment to enable mocking and stubbing
	if (isTestEnv) {
		return false
	}
	return (
		typeof config.apiKey === "string" &&
		config.apiKey.length > 0 &&
		typeof config.errorTrackingApiKey === "string" &&
		config.errorTrackingApiKey.length > 0 &&
		typeof config.host === "string" &&
		config.host.length > 0 &&
		typeof config.uiHost === "string" &&
		config.uiHost.length > 0
	)
}
