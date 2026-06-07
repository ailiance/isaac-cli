import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { type MockLlmServer, startMockLlmServer } from "./mock-llm-server"

/**
 * End-to-end test for the `isaac` CLI headless task path.
 *
 * Spawns the built CLI binary (`cli/dist/cli.mjs`) in plain-text / yolo mode,
 * pointed at a local OpenAI-compatible mock server. The mock drives the agent
 * through a `write_to_file` -> `attempt_completion` loop. We assert the process
 * exits 0 and that the file was actually written to the temp workspace.
 *
 * Run via `npm run test:e2e` (which builds first). Excluded from the default
 * `npm test` run so the unit gate stays fast and build-independent.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLI_DIST_DIR = path.resolve(__dirname, "../../dist")
const CLI_ENTRY = path.join(CLI_DIST_DIR, "cli.mjs")

interface RunResult {
	code: number | null
	stdout: string
	stderr: string
}

function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<RunResult> {
	// The CLI entry only calls program.parse() when VITEST !== "true"
	// (cli/src/index.ts). Since we run under vitest, the child inherits
	// VITEST=true and would no-op. Strip it so the spawned binary runs for real.
	const childEnv = { ...env }
	delete childEnv.VITEST

	return new Promise((resolve, reject) => {
		const child = spawn("node", [CLI_ENTRY, ...args], {
			// Spawn from dist/ so relative sidecars (.wasm/.node) resolve.
			cwd: CLI_DIST_DIR,
			env: childEnv,
			stdio: ["ignore", "pipe", "pipe"],
		})

		let stdout = ""
		let stderr = ""
		child.stdout.on("data", (d: Buffer) => {
			stdout += d.toString("utf8")
		})
		child.stderr.on("data", (d: Buffer) => {
			stderr += d.toString("utf8")
		})
		child.on("error", reject)
		child.on("exit", (code) => resolve({ code, stdout, stderr }))
	})
}

describe("CLI E2E: write_to_file task", () => {
	let mock: MockLlmServer

	beforeAll(async () => {
		expect(fs.existsSync(CLI_ENTRY), `CLI binary missing at ${CLI_ENTRY} (run npm run build)`).toBe(true)
		mock = await startMockLlmServer()
	})

	afterAll(async () => {
		await mock?.close()
	})

	it("creates hello.txt with the requested content and exits 0", async () => {
		const tmpWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "isaac-e2e-wd-"))
		const tmpConfig = fs.mkdtempSync(path.join(os.tmpdir(), "isaac-e2e-cfg-"))

		try {
			const result = await runCli(
				[
					"task",
					"-y",
					"--cwd",
					tmpWorkspace,
					"--config",
					tmpConfig,
					"--no-mcp",
					"-t",
					"30",
					"--max-consecutive-mistakes",
					"2",
					"create a file named hello.txt containing the text HELLO_E2E",
				],
				{
					...process.env,
					OPENAI_API_KEY: "test",
					OPENAI_API_BASE: mock.baseUrl,
					// Ensure the ailiance default gateway path is not taken.
					AILIANCE_GATEWAY: "",
					CI: "true",
				},
			)

			const diagnostics = `exit=${result.code}\nbaseUrl=${mock.baseUrl} hits=${mock.hits.length} ${JSON.stringify(mock.hits)}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`

			expect(result.code, diagnostics).toBe(0)

			const target = path.join(tmpWorkspace, "hello.txt")
			expect(fs.existsSync(target), `expected ${target} to exist.\n${diagnostics}`).toBe(true)

			// The file editor normalizes a trailing newline, so trim before comparing.
			const content = fs.readFileSync(target, "utf8")
			expect(content.trim()).toBe("HELLO_E2E")
		} finally {
			fs.rmSync(tmpWorkspace, { recursive: true, force: true })
			fs.rmSync(tmpConfig, { recursive: true, force: true })
		}
	}, 60_000)
})
