import { afterEach, beforeEach, describe, it } from "mocha"
import "should"
import fs from "fs/promises"
import os from "os"
import path from "path"
import sinon from "sinon"
import { IsaacConfigurationError, IsaacEndpoint, IsaacEnv, Environment } from "../config"

describe("IsaacEndpoint configuration", () => {
	let sandbox: sinon.SinonSandbox
	let tempDir: string
	let originalHomedir: typeof os.homedir

	beforeEach(async () => {
		sandbox = sinon.createSandbox()
		tempDir = path.join(os.tmpdir(), `config-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
		await fs.mkdir(tempDir, { recursive: true })

		// Create .dirac directory
		await fs.mkdir(path.join(tempDir, ".dirac"), { recursive: true })

		// Stub os.homedir to return our temp directory
		originalHomedir = os.homedir
		sandbox.stub(os, "homedir").returns(tempDir)

		// Reset the singleton state using internal method
		;(IsaacEndpoint as any)._instance = null
		;(IsaacEndpoint as any)._initialized = false
		;(IsaacEndpoint as any)._extensionFsPath = undefined
	})

	afterEach(async () => {
		sandbox.restore()
		// Reset singleton state
		;(IsaacEndpoint as any)._instance = null
		;(IsaacEndpoint as any)._initialized = false
		try {
			await fs.rm(tempDir, { recursive: true, force: true })
		} catch {
			// Ignore cleanup errors
		}
	})

	describe("valid config parsing", () => {
		it("should parse valid endpoints.json with all required fields", async () => {
			const validConfig = {
				appBaseUrl: "https://app.enterprise.com",
				apiBaseUrl: "https://api.enterprise.com",
			}

			await fs.writeFile(path.join(tempDir, ".dirac", "endpoints.json"), JSON.stringify(validConfig), "utf8")

			await IsaacEndpoint.initialize(tempDir)

			const config = IsaacEndpoint.config
			config.appBaseUrl.should.equal("https://app.enterprise.com")
			config.apiBaseUrl.should.equal("https://api.enterprise.com")
			config.environment.should.equal(Environment.selfHosted)
		})

		it("should work without endpoints.json (standard mode)", async () => {
			// No endpoints.json file exists

			await IsaacEndpoint.initialize(tempDir)

			const config = IsaacEndpoint.config
			config.environment.should.not.equal(Environment.selfHosted)
			// Should use production defaults
			config.appBaseUrl.should.equal("https://app.dirac.run")
			config.apiBaseUrl.should.equal("https://api.dirac.run")
		})

		it("should accept URLs with ports", async () => {
			const validConfig = {
				appBaseUrl: "http://localhost:3000",
				apiBaseUrl: "http://localhost:7777",
			}

			await fs.writeFile(path.join(tempDir, ".dirac", "endpoints.json"), JSON.stringify(validConfig), "utf8")

			await IsaacEndpoint.initialize(tempDir)

			const config = IsaacEndpoint.config
			config.appBaseUrl.should.equal("http://localhost:3000")
			config.apiBaseUrl.should.equal("http://localhost:7777")
		})

		it("should accept URLs with paths", async () => {
			const validConfig = {
				appBaseUrl: "https://proxy.enterprise.com/dirac/app",
				apiBaseUrl: "https://proxy.enterprise.com/dirac/api",
			}

			await fs.writeFile(path.join(tempDir, ".dirac", "endpoints.json"), JSON.stringify(validConfig), "utf8")

			await IsaacEndpoint.initialize(tempDir)

			const config = IsaacEndpoint.config
			config.appBaseUrl.should.equal("https://proxy.enterprise.com/dirac/app")
		})
	})

	describe("invalid JSON handling", () => {
		it("should throw IsaacConfigurationError for invalid JSON syntax", async () => {
			await fs.writeFile(path.join(tempDir, ".dirac", "endpoints.json"), "{ invalid json }", "utf8")

			try {
				await IsaacEndpoint.initialize(tempDir)
				throw new Error("Should have thrown")
			} catch (error: any) {
				error.should.be.instanceof(IsaacConfigurationError)
				error.message.should.containEql("Invalid JSON")
			}
		})

		it("should throw IsaacConfigurationError for truncated JSON", async () => {
			await fs.writeFile(path.join(tempDir, ".dirac", "endpoints.json"), '{"appBaseUrl": "https://test.com"', "utf8")

			try {
				await IsaacEndpoint.initialize(tempDir)
				throw new Error("Should have thrown")
			} catch (error: any) {
				error.should.be.instanceof(IsaacConfigurationError)
				error.message.should.containEql("Invalid JSON")
			}
		})

		it("should throw IsaacConfigurationError for empty file", async () => {
			await fs.writeFile(path.join(tempDir, ".dirac", "endpoints.json"), "", "utf8")

			try {
				await IsaacEndpoint.initialize(tempDir)
				throw new Error("Should have thrown")
			} catch (error: any) {
				error.should.be.instanceof(IsaacConfigurationError)
			}
		})

		it("should throw IsaacConfigurationError for non-object JSON", async () => {
			await fs.writeFile(path.join(tempDir, ".dirac", "endpoints.json"), '"just a string"', "utf8")

			try {
				await IsaacEndpoint.initialize(tempDir)
				throw new Error("Should have thrown")
			} catch (error: any) {
				error.should.be.instanceof(IsaacConfigurationError)
				error.message.should.containEql("must contain a JSON object")
			}
		})

		it("should throw IsaacConfigurationError for array JSON", async () => {
			await fs.writeFile(path.join(tempDir, ".dirac", "endpoints.json"), "[]", "utf8")

			try {
				await IsaacEndpoint.initialize(tempDir)
				throw new Error("Should have thrown")
			} catch (error: any) {
				error.should.be.instanceof(IsaacConfigurationError)
				// Arrays pass the object check but fail on required fields
				error.message.should.containEql("Missing required field")
			}
		})

		it("should throw IsaacConfigurationError for null JSON", async () => {
			await fs.writeFile(path.join(tempDir, ".dirac", "endpoints.json"), "null", "utf8")

			try {
				await IsaacEndpoint.initialize(tempDir)
				throw new Error("Should have thrown")
			} catch (error: any) {
				error.should.be.instanceof(IsaacConfigurationError)
				error.message.should.containEql("must contain a JSON object")
			}
		})
	})

	describe("missing required fields", () => {
		it("should throw IsaacConfigurationError when appBaseUrl is missing", async () => {
			const config = {
				apiBaseUrl: "https://api.enterprise.com",
			}

			await fs.writeFile(path.join(tempDir, ".dirac", "endpoints.json"), JSON.stringify(config), "utf8")

			try {
				await IsaacEndpoint.initialize(tempDir)
				throw new Error("Should have thrown")
			} catch (error: any) {
				error.should.be.instanceof(IsaacConfigurationError)
				error.message.should.containEql('Missing required field "appBaseUrl"')
			}
		})

		it("should throw IsaacConfigurationError when apiBaseUrl is missing", async () => {
			const config = {
				appBaseUrl: "https://app.enterprise.com",
			}

			await fs.writeFile(path.join(tempDir, ".dirac", "endpoints.json"), JSON.stringify(config), "utf8")

			try {
				await IsaacEndpoint.initialize(tempDir)
				throw new Error("Should have thrown")
			} catch (error: any) {
				error.should.be.instanceof(IsaacConfigurationError)
				error.message.should.containEql('Missing required field "apiBaseUrl"')
			}
		})

		it("should throw IsaacConfigurationError when all fields are missing", async () => {
			await fs.writeFile(path.join(tempDir, ".dirac", "endpoints.json"), "{}", "utf8")

			try {
				await IsaacEndpoint.initialize(tempDir)
				throw new Error("Should have thrown")
			} catch (error: any) {
				error.should.be.instanceof(IsaacConfigurationError)
				error.message.should.containEql("Missing required field")
			}
		})

		it("should throw IsaacConfigurationError when field is null", async () => {
			const config = {
				appBaseUrl: null,
				apiBaseUrl: "https://api.enterprise.com",
			}

			await fs.writeFile(path.join(tempDir, ".dirac", "endpoints.json"), JSON.stringify(config), "utf8")

			try {
				await IsaacEndpoint.initialize(tempDir)
				throw new Error("Should have thrown")
			} catch (error: any) {
				error.should.be.instanceof(IsaacConfigurationError)
				error.message.should.containEql('Missing required field "appBaseUrl"')
			}
		})

		it("should throw IsaacConfigurationError when field is empty string", async () => {
			const config = {
				appBaseUrl: "",
				apiBaseUrl: "https://api.enterprise.com",
			}

			await fs.writeFile(path.join(tempDir, ".dirac", "endpoints.json"), JSON.stringify(config), "utf8")

			try {
				await IsaacEndpoint.initialize(tempDir)
				throw new Error("Should have thrown")
			} catch (error: any) {
				error.should.be.instanceof(IsaacConfigurationError)
				error.message.should.containEql("cannot be empty")
			}
		})

		it("should throw IsaacConfigurationError when field is whitespace only", async () => {
			const config = {
				appBaseUrl: "   ",
				apiBaseUrl: "https://api.enterprise.com",
			}

			await fs.writeFile(path.join(tempDir, ".dirac", "endpoints.json"), JSON.stringify(config), "utf8")

			try {
				await IsaacEndpoint.initialize(tempDir)
				throw new Error("Should have thrown")
			} catch (error: any) {
				error.should.be.instanceof(IsaacConfigurationError)
				error.message.should.containEql("cannot be empty")
			}
		})

		it("should throw IsaacConfigurationError when field is non-string", async () => {
			const config = {
				appBaseUrl: 12345,
				apiBaseUrl: "https://api.enterprise.com",
			}

			await fs.writeFile(path.join(tempDir, ".dirac", "endpoints.json"), JSON.stringify(config), "utf8")

			try {
				await IsaacEndpoint.initialize(tempDir)
				throw new Error("Should have thrown")
			} catch (error: any) {
				error.should.be.instanceof(IsaacConfigurationError)
				error.message.should.containEql("must be a string")
			}
		})
	})

	describe("invalid URL detection", () => {
		it("should throw IsaacConfigurationError for invalid URL format", async () => {
			const config = {
				appBaseUrl: "not-a-valid-url",
				apiBaseUrl: "https://api.enterprise.com",
			}

			await fs.writeFile(path.join(tempDir, ".dirac", "endpoints.json"), JSON.stringify(config), "utf8")

			try {
				await IsaacEndpoint.initialize(tempDir)
				throw new Error("Should have thrown")
			} catch (error: any) {
				error.should.be.instanceof(IsaacConfigurationError)
				error.message.should.containEql("must be a valid URL")
			}
		})

		it("should throw IsaacConfigurationError for URL without protocol", async () => {
			const config = {
				appBaseUrl: "app.enterprise.com",
				apiBaseUrl: "https://api.enterprise.com",
			}

			await fs.writeFile(path.join(tempDir, ".dirac", "endpoints.json"), JSON.stringify(config), "utf8")

			try {
				await IsaacEndpoint.initialize(tempDir)
				throw new Error("Should have thrown")
			} catch (error: any) {
				error.should.be.instanceof(IsaacConfigurationError)
				error.message.should.containEql("must be a valid URL")
			}
		})

		it("should throw IsaacConfigurationError for malformed URL", async () => {
			const config = {
				appBaseUrl: "https://",
				apiBaseUrl: "https://api.enterprise.com",
			}

			await fs.writeFile(path.join(tempDir, ".dirac", "endpoints.json"), JSON.stringify(config), "utf8")

			try {
				await IsaacEndpoint.initialize(tempDir)
				throw new Error("Should have thrown")
			} catch (error: any) {
				error.should.be.instanceof(IsaacConfigurationError)
				error.message.should.containEql("must be a valid URL")
			}
		})

		it("should include the invalid URL value in error message", async () => {
			const invalidUrl = "definitely-not-a-url"
			const config = {
				appBaseUrl: invalidUrl,
				apiBaseUrl: "https://api.enterprise.com",
			}

			await fs.writeFile(path.join(tempDir, ".dirac", "endpoints.json"), JSON.stringify(config), "utf8")

			try {
				await IsaacEndpoint.initialize(tempDir)
				throw new Error("Should have thrown")
			} catch (error: any) {
				error.should.be.instanceof(IsaacConfigurationError)
				error.message.should.containEql(invalidUrl)
			}
		})
	})

	describe("environment switching blocked in self-hosted mode", () => {
		it("should throw error when trying to change environment in self-hosted mode", async () => {
			const config = {
				appBaseUrl: "https://app.enterprise.com",
				apiBaseUrl: "https://api.enterprise.com",
			}

			await fs.writeFile(path.join(tempDir, ".dirac", "endpoints.json"), JSON.stringify(config), "utf8")

			await IsaacEndpoint.initialize(tempDir)

			// Verify we're in self-hosted mode
			IsaacEndpoint.config.environment.should.equal(Environment.selfHosted)

			// Try to change environment - should throw
			try {
				IsaacEnv.setEnvironment("staging")
				throw new Error("Should have thrown")
			} catch (error: any) {
				error.message.should.containEql("Cannot change environment in on-premise mode")
			}
		})

		it("should throw error for all environment values in self-hosted mode", async () => {
			const config = {
				appBaseUrl: "https://app.enterprise.com",
				apiBaseUrl: "https://api.enterprise.com",
			}

			await fs.writeFile(path.join(tempDir, ".dirac", "endpoints.json"), JSON.stringify(config), "utf8")

			await IsaacEndpoint.initialize(tempDir)

			const environments = ["staging", "local", "production", "anything"]
			for (const env of environments) {
				try {
					IsaacEnv.setEnvironment(env)
					throw new Error(`Should have thrown for environment: ${env}`)
				} catch (error: any) {
					error.message.should.containEql("Cannot change environment in on-premise mode")
				}
			}
		})

		it("should allow environment switching in standard mode", async () => {
			// No endpoints.json file - standard mode

			await IsaacEndpoint.initialize(tempDir)

			// Verify we're NOT in self-hosted mode
			IsaacEndpoint.config.environment.should.not.equal(Environment.selfHosted)

			// Should be able to change environment
			IsaacEnv.setEnvironment("staging")
			IsaacEnv.getEnvironment().environment.should.equal("staging")

			IsaacEnv.setEnvironment("local")
			IsaacEnv.getEnvironment().environment.should.equal("local")

			IsaacEnv.setEnvironment("production")
			IsaacEnv.getEnvironment().environment.should.equal("production")
		})
	})

	describe("self-hosted mode behavior", () => {
		it("should report selfHosted environment in self-hosted mode", async () => {
			const config = {
				appBaseUrl: "https://app.enterprise.com",
				apiBaseUrl: "https://api.enterprise.com",
			}

			await fs.writeFile(path.join(tempDir, ".dirac", "endpoints.json"), JSON.stringify(config), "utf8")

			await IsaacEndpoint.initialize(tempDir)

			const envConfig = IsaacEndpoint.config
			envConfig.environment.should.equal(Environment.selfHosted)
		})

		it("should use custom endpoints from file", async () => {
			const customConfig = {
				appBaseUrl: "https://custom-app.internal",
				apiBaseUrl: "https://custom-api.internal",
			}

			await fs.writeFile(path.join(tempDir, ".dirac", "endpoints.json"), JSON.stringify(customConfig), "utf8")

			await IsaacEndpoint.initialize(tempDir)

			const config = IsaacEndpoint.config
			config.appBaseUrl.should.equal("https://custom-app.internal")
			config.apiBaseUrl.should.equal("https://custom-api.internal")
		})
	})

	describe("initialization behavior", () => {
		it("should only initialize once", async () => {
			await IsaacEndpoint.initialize(tempDir)
			IsaacEndpoint.isInitialized().should.be.true()

			// Second initialize should be a no-op
			await IsaacEndpoint.initialize(tempDir)
			IsaacEndpoint.isInitialized().should.be.true()
		})

		it("should throw error when accessing config before initialization", async () => {
			// Already reset in beforeEach, so accessing should throw
			try {
				const _ = IsaacEndpoint.config
				throw new Error("Should have thrown")
			} catch (error: any) {
				error.message.should.containEql("not initialized")
			}
		})
	})

	describe("isSelfHosted() method", () => {
		it("should return true when not initialized (safety fallback)", async () => {
			// Reset singleton state - already done in beforeEach, not initialized
			IsaacEndpoint.isInitialized().should.be.false()
			IsaacEndpoint.isSelfHosted().should.be.true()
		})

		it("should return true when in self-hosted mode", async () => {
			const config = {
				appBaseUrl: "https://app.enterprise.com",
				apiBaseUrl: "https://api.enterprise.com",
			}
			await fs.writeFile(path.join(tempDir, ".dirac", "endpoints.json"), JSON.stringify(config), "utf8")
			await IsaacEndpoint.initialize(tempDir)

			IsaacEndpoint.isSelfHosted().should.be.true()
		})

		it("should return false when in normal mode (no endpoints.json)", async () => {
			// No endpoints.json file exists
			await IsaacEndpoint.initialize(tempDir)

			IsaacEndpoint.isSelfHosted().should.be.false()
		})
	})

	describe("bundled endpoints.json behavior", () => {
		let bundledDir: string
		let setVscodeHostProviderMock: (mock: { extensionFsPath: string; globalStorageFsPath: string }) => void

		beforeEach(async () => {
			// Create a separate directory for bundled config
			bundledDir = path.join(os.tmpdir(), `config-bundled-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
			await fs.mkdir(bundledDir, { recursive: true })

			// Import HostProvider utilities
			const hostProviderModule = await import("../test/host-provider-test-utils")
			setVscodeHostProviderMock = hostProviderModule.setVscodeHostProviderMock
		})

		afterEach(async () => {
			try {
				await fs.rm(bundledDir, { recursive: true, force: true })
			} catch {
				// Ignore cleanup errors
			}
		})

		it("should use bundled endpoints.json when available", async () => {
			const bundledConfig = {
				appBaseUrl: "https://bundled.enterprise.com",
				apiBaseUrl: "https://bundled-api.enterprise.com",
			}

			// Set up bundled config
			await fs.writeFile(path.join(bundledDir, "endpoints.json"), JSON.stringify(bundledConfig), "utf8")

			await IsaacEndpoint.initialize(bundledDir)

			const config = IsaacEndpoint.config
			config.appBaseUrl.should.equal("https://bundled.enterprise.com")
			config.apiBaseUrl.should.equal("https://bundled-api.enterprise.com")
			config.environment.should.equal(Environment.selfHosted)
		})

		it("should prefer bundled endpoints.json over user file", async () => {
			const bundledConfig = {
				appBaseUrl: "https://bundled.enterprise.com",
				apiBaseUrl: "https://bundled-api.enterprise.com",
			}

			const userConfig = {
				appBaseUrl: "https://user.enterprise.com",
				apiBaseUrl: "https://user-api.enterprise.com",
			}

			// Set up both configs
			await fs.writeFile(path.join(bundledDir, "endpoints.json"), JSON.stringify(bundledConfig), "utf8")
			await fs.writeFile(path.join(tempDir, ".dirac", "endpoints.json"), JSON.stringify(userConfig), "utf8")

			await IsaacEndpoint.initialize(bundledDir)

			// Should use bundled config, not user config
			const config = IsaacEndpoint.config
			config.appBaseUrl.should.equal("https://bundled.enterprise.com")
			config.apiBaseUrl.should.equal("https://bundled-api.enterprise.com")
		})

		it("should fall back to user endpoints.json when bundled is not present", async () => {
			const userConfig = {
				appBaseUrl: "https://user.enterprise.com",
				apiBaseUrl: "https://user-api.enterprise.com",
			}

			// Only create user config, no bundled config
			await fs.writeFile(path.join(tempDir, ".dirac", "endpoints.json"), JSON.stringify(userConfig), "utf8")

			await IsaacEndpoint.initialize(bundledDir)

			// Should use user config
			const config = IsaacEndpoint.config
			config.appBaseUrl.should.equal("https://user.enterprise.com")
			config.apiBaseUrl.should.equal("https://user-api.enterprise.com")
		})

		it("should use standard mode when neither bundled nor user file exists", async () => {
			// No config files at all

			await IsaacEndpoint.initialize(bundledDir)

			// Should use production defaults
			const config = IsaacEndpoint.config
			config.environment.should.not.equal(Environment.selfHosted)
			config.appBaseUrl.should.equal("https://app.dirac.run")
			config.apiBaseUrl.should.equal("https://api.dirac.run")
		})

		it("should throw IsaacConfigurationError for invalid bundled file", async () => {
			const invalidConfig = {
				appBaseUrl: "not-a-url",
				apiBaseUrl: "https://api.enterprise.com",
			}

			// Set up invalid bundled config
			await fs.writeFile(path.join(bundledDir, "endpoints.json"), JSON.stringify(invalidConfig), "utf8")

			try {
				await IsaacEndpoint.initialize(bundledDir)
				throw new Error("Should have thrown")
			} catch (error: any) {
				error.should.be.instanceof(IsaacConfigurationError)
				error.message.should.containEql("must be a valid URL")
				error.message.should.containEql("bundled")
			}
		})

		it("should throw IsaacConfigurationError for invalid JSON in bundled file", async () => {
			// Set up invalid JSON in bundled file
			await fs.writeFile(path.join(bundledDir, "endpoints.json"), "{ invalid json }", "utf8")

			try {
				await IsaacEndpoint.initialize(bundledDir)
				throw new Error("Should have thrown")
			} catch (error: any) {
				error.should.be.instanceof(IsaacConfigurationError)
				error.message.should.containEql("Invalid JSON")
				error.message.should.containEql("bundled")
			}
		})

		it("should indicate bundled source in error messages", async () => {
			const incompleteConfig = {
				appBaseUrl: "https://bundled.enterprise.com",
				// Missing apiBaseUrl
			}

			await fs.writeFile(path.join(bundledDir, "endpoints.json"), JSON.stringify(incompleteConfig), "utf8")

			try {
				await IsaacEndpoint.initialize(bundledDir)
				throw new Error("Should have thrown")
			} catch (error: any) {
				error.should.be.instanceof(IsaacConfigurationError)
				error.message.should.containEql("Missing required field")
				error.message.should.containEql(path.join(bundledDir, "endpoints.json"))
			}
		})
	})
})
