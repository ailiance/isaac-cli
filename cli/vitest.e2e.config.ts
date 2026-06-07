import path from "path"
import { defineConfig } from "vitest/config"

/**
 * Dedicated config for CLI E2E tests.
 *
 * These spawn the built `dist/cli.mjs` binary against a local mock LLM server,
 * so they are slow and require a prior build. They are intentionally NOT part
 * of the default `npm test` run (see vitest.config.ts, which excludes
 * `tests/e2e/**`). Invoke via `npm run test:e2e`.
 */
export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		include: ["tests/e2e/**/*.e2e.test.ts"],
		// Cold start (~1-2s) plus the two-turn agent loop; give it room.
		testTimeout: 60_000,
		hookTimeout: 60_000,
	},
	resolve: {
		alias: {
			vscode: path.resolve(__dirname, "src/vscode-shim.ts"),
			"@": path.resolve(__dirname, "../src"),
			"@api": path.resolve(__dirname, "../src/core/api"),
			"@core": path.resolve(__dirname, "../src/core"),
			"@generated": path.resolve(__dirname, "../src/generated"),
			"@hosts": path.resolve(__dirname, "../src/hosts"),
			"@integrations": path.resolve(__dirname, "../src/integrations"),
			"@packages": path.resolve(__dirname, "../src/packages"),
			"@services": path.resolve(__dirname, "../src/services"),
			"@shared": path.resolve(__dirname, "../src/shared"),
			"@utils": path.resolve(__dirname, "../src/utils"),
		},
	},
})
