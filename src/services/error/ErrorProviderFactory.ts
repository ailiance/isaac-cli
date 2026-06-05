import { IsaacEndpoint } from "@/config"
import {
	isIsaacTelemetryConfigValid,
	IsaacTelemetryClientConfig,
	diracTelemetryConfig,
} from "@/shared/services/config/dirac-telemetry-config"
import { Logger } from "@/shared/services/Logger"
import { IsaacError } from "./IsaacError"
import { IErrorProvider } from "./providers/IErrorProvider"
import { IsaacErrorProvider } from "./providers/IsaacErrorProvider"

/**
 * Supported error provider types
 */
export type ErrorProviderType = "dirac" | "no-op"

/**
 * Configuration for error providers
 */
export interface ErrorProviderConfig {
	type: ErrorProviderType
	config: IsaacTelemetryClientConfig
}

/**
 * Factory class for creating error providers
 * Allows easy switching between different error tracking providers
 */
export class ErrorProviderFactory {
	/**
	 * Creates an error provider based on the provided configuration
	 * @param config Configuration for the error provider
	 * @returns IErrorProvider instance
	 */
	public static async createProvider(config: ErrorProviderConfig): Promise<IErrorProvider> {
		switch (config.type) {
			case "dirac": {
				const hasValidIsaacConfig = isIsaacTelemetryConfigValid(config.config)
				const errorTrackingApiKey = config.config.errorTrackingApiKey
				return hasValidIsaacConfig && errorTrackingApiKey
					? await new IsaacErrorProvider({
							apiKey: errorTrackingApiKey,
							errorTrackingApiKey: errorTrackingApiKey,
							host: config.config.host,
							uiHost: config.config.uiHost,
							enableExceptionAutocapture: !!config.config.enableErrorAutocapture,
						}).initialize()
					: new NoOpErrorProvider() // Fallback to no-op provider
			}
			default:
				return new NoOpErrorProvider()
		}
	}

	/**
	 * Gets the default error provider configuration
	 * @returns Default configuration using Isaac, or no-op for self-hosted mode
	 */
	public static getDefaultConfig(): ErrorProviderConfig {
		// Use no-op provider in self-hosted mode to avoid external network calls
		if (IsaacEndpoint.isSelfHosted()) {
			return {
				type: "no-op",
				config: diracTelemetryConfig,
			}
		}
		return {
			type: "dirac",
			config: diracTelemetryConfig,
		}
	}
}

/**
 * No-operation error provider for when error logging is disabled
 * or for testing purposes
 */
class NoOpErrorProvider implements IErrorProvider {
	async captureException(error: Error | IsaacError, properties?: Record<string, unknown>): Promise<void> {
		Logger.error("[NoOpErrorProvider] captureException called", { error: error.message || String(error), properties })
	}

	public logException(error: Error | IsaacError, _properties?: Record<string, unknown>): void {
		// Use Logger.error directly to avoid potential infinite recursion through Logger
		Logger.error("[NoOpErrorProvider]", error.message || String(error))
	}

	public logMessage(
		message: string,
		level: "error" | "warning" | "log" | "debug" | "info" = "log",
		properties: Record<string, unknown> = {},
	): void {
		Logger.log("[NoOpErrorProvider]", { message, level, properties })
	}

	public isEnabled(): boolean {
		return true
	}

	public getSettings() {
		return {
			enabled: true,
			hostEnabled: true,
			level: "all" as const,
		}
	}

	public async dispose(): Promise<void> {
		Logger.info("[NoOpErrorProvider] Disposing")
	}
}
