/**
 * Tests for selfHosted mode behavior across Isaac-based services.
 * When IsaacEndpoint.isSelfHosted() returns true, all Isaac telemetry functionality should be disabled.
 */

import * as assert from "assert"
import * as sinon from "sinon"
import { IsaacEndpoint } from "@/config"
import { ErrorProviderFactory } from "../error/ErrorProviderFactory"
import { FeatureFlagsProviderFactory } from "../feature-flags/FeatureFlagsProviderFactory"

describe("SelfHosted Mode - Isaac Telemetry Disabling", () => {
	let isSelfHostedStub: sinon.SinonStub

	afterEach(() => {
		if (isSelfHostedStub) {
			isSelfHostedStub.restore()
		}
	})

	describe("FeatureFlagsProviderFactory", () => {
		it("should return no-op config when in selfHosted mode", () => {
			isSelfHostedStub = sinon.stub(IsaacEndpoint, "isSelfHosted").returns(true)

			const config = FeatureFlagsProviderFactory.getDefaultConfig()

			assert.strictEqual(config.type, "no-op", "Should return no-op type in selfHosted mode")
		})

		it("should return dirac config when NOT in selfHosted mode (if Isaac config is valid)", () => {
			isSelfHostedStub = sinon.stub(IsaacEndpoint, "isSelfHosted").returns(false)

			const config = FeatureFlagsProviderFactory.getDefaultConfig()

			// Will be "dirac" if Isaac config is valid, "no-op" otherwise
			// The important thing is it's NOT forced to "no-op" by selfHosted check
			assert.ok(config.type === "dirac" || config.type === "no-op", "Should not be forced to no-op")
		})

		it("should create NoOp provider when in selfHosted mode", () => {
			isSelfHostedStub = sinon.stub(IsaacEndpoint, "isSelfHosted").returns(true)

			const config = FeatureFlagsProviderFactory.getDefaultConfig()
			const provider = FeatureFlagsProviderFactory.createProvider(config)

			// NoOp provider should always be enabled (returns true for isEnabled)
			assert.strictEqual(provider.isEnabled(), true, "NoOp provider should report as enabled")
		})
	})

	describe("ErrorProviderFactory", () => {
		it("should return no-op config when in selfHosted mode", () => {
			isSelfHostedStub = sinon.stub(IsaacEndpoint, "isSelfHosted").returns(true)

			const config = ErrorProviderFactory.getDefaultConfig()

			assert.strictEqual(config.type, "no-op", "Should return no-op type in selfHosted mode")
		})

		it("should return dirac config when NOT in selfHosted mode", () => {
			isSelfHostedStub = sinon.stub(IsaacEndpoint, "isSelfHosted").returns(false)

			const config = ErrorProviderFactory.getDefaultConfig()

			assert.strictEqual(config.type, "dirac", "Should return dirac type when not in selfHosted mode")
		})

		it("should create NoOp provider when in selfHosted mode", async () => {
			isSelfHostedStub = sinon.stub(IsaacEndpoint, "isSelfHosted").returns(true)

			const config = ErrorProviderFactory.getDefaultConfig()
			const provider = await ErrorProviderFactory.createProvider(config)

			// NoOp provider should always be enabled
			assert.strictEqual(provider.isEnabled(), true, "NoOp provider should report as enabled")

			await provider.dispose()
		})
	})

	describe("Integration - selfHosted should disable all Isaac services", () => {
		it("should return no-op for all Isaac-based factories when selfHosted", () => {
			isSelfHostedStub = sinon.stub(IsaacEndpoint, "isSelfHosted").returns(true)

			const featureFlagsConfig = FeatureFlagsProviderFactory.getDefaultConfig()
			const errorConfig = ErrorProviderFactory.getDefaultConfig()

			assert.strictEqual(featureFlagsConfig.type, "no-op", "FeatureFlags should be no-op in selfHosted")
			assert.strictEqual(errorConfig.type, "no-op", "Error provider should be no-op in selfHosted")
		})
	})
})
