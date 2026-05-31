// ailiance-agent fork: tracing tests (located under cli/tests so the cli
// vitest config picks them up — the source lives in @core/tracing).
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { JsonlTracer, scrubSecrets, TRACING_DIR_NAME, TRACING_SCHEMA_VERSION } from "@core/tracing"

let tmpDir: string

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "isaac-trace-"))
})

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe("scrubSecrets", () => {
	it("redacts obvious secret-like keys in objects", () => {
		const input = { api_key: "abc", token: "xyz", harmless: 1 }
		const out = scrubSecrets(input)
		expect(out).toEqual({ api_key: "[REDACTED]", token: "[REDACTED]", harmless: 1 })
	})

	it("redacts inline secret patterns inside strings", () => {
		const out = scrubSecrets({ msg: "got token=abcdef and password: hunter2 here" })
		expect((out as { msg: string }).msg).not.toContain("abcdef")
		expect((out as { msg: string }).msg).not.toContain("hunter2")
	})

	it("redacts well-known token shapes", () => {
		const fakeKey = "sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ"
		const out = scrubSecrets({ key: `prefix ${fakeKey} suffix`, other: "ok" })
		expect((out as { key: string }).key).toContain("[REDACTED]")
		expect((out as { key: string }).key).not.toContain(fakeKey)
	})

	it("handles arrays and nested structures", () => {
		const out = scrubSecrets([{ secret: "x" }, { ok: 1 }]) as Array<Record<string, unknown>>
		expect(out[0].secret).toBe("[REDACTED]")
		expect(out[1].ok).toBe(1)
	})

	it("survives circular refs", () => {
		const circ: Record<string, unknown> = { a: 1 }
		circ.self = circ
		expect(() => scrubSecrets(circ)).not.toThrow()
	})

	it("redacts AWS access key IDs in strings", () => {
		const out = scrubSecrets({ msg: "key=AKIAIOSFODNN7EXAMPLE in log" }) as { msg: string }
		expect(out.msg).not.toContain("AKIAIOSFODNN7EXAMPLE")
		expect(out.msg).toContain("[REDACTED]")
	})

	it("redacts PEM private key blocks", () => {
		const pem =
			"-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX\nfake-pem-body-here\n-----END RSA PRIVATE KEY-----"
		const out = scrubSecrets({ note: `before\n${pem}\nafter` }) as { note: string }
		expect(out.note).not.toContain("fake-pem-body-here")
		expect(out.note).not.toContain("BEGIN RSA PRIVATE KEY")
		expect(out.note).toContain("[REDACTED]")
	})

	it("redacts URL credentials (scheme://user:pass@host)", () => {
		const out = scrubSecrets({ dsn: "postgresql://user:password@host/db" }) as { dsn: string }
		expect(out.dsn).toBe("postgresql://[REDACTED]:[REDACTED]@host/db")
	})

	it("redacts object value when key is private_key", () => {
		const out = scrubSecrets({ private_key: "-----BEGIN-----xxx", other: 1 }) as Record<string, unknown>
		expect(out.private_key).toBe("[REDACTED]")
		expect(out.other).toBe(1)
	})

	it("redacts object value when key is aws_secret_access_key", () => {
		const out = scrubSecrets({ aws_secret_access_key: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" }) as Record<
			string,
			unknown
		>
		expect(out.aws_secret_access_key).toBe("[REDACTED]")
	})

	it("redacts object value when key is credential", () => {
		const out = scrubSecrets({ credential: "topsecret", credentials: "more" }) as Record<string, unknown>
		expect(out.credential).toBe("[REDACTED]")
		expect(out.credentials).toBe("[REDACTED]")
	})

	it("redacts string aws_secret_access_key=value form", () => {
		const out = scrubSecrets({ env: "aws_secret_access_key=wJalrXUtnFEMIabc and more" }) as { env: string }
		expect(out.env).not.toContain("wJalrXUtnFEMIabc")
		expect(out.env).toContain("[REDACTED]")
	})

	it("redacts free-text private_key=value", () => {
		const out = scrubSecrets({ note: "set private_key=abcdef-secret-key inline" }) as { note: string }
		expect(out.note).not.toContain("abcdef-secret-key")
		expect(out.note).toContain("[REDACTED]")
	})

	it("redacts free-text ssh_key:value", () => {
		const out = scrubSecrets({ env: "ssh_key:ssh-rsa-AAAAB3NzaC1yc2EAAAA more" }) as { env: string }
		expect(out.env).not.toContain("AAAAB3NzaC1yc2E")
		expect(out.env).toContain("[REDACTED]")
	})

	it("redacts free-text certificate=value", () => {
		const out = scrubSecrets({ env: "certificate=PEMfakeBody other" }) as { env: string }
		expect(out.env).not.toContain("PEMfakeBody")
		expect(out.env).toContain("[REDACTED]")
	})
})

describe("JsonlTracer", () => {
	it("creates the run directory and writes meta.json", () => {
		const tracer = new JsonlTracer("task-123", tmpDir)
		tracer.writeMeta({
			task: "task-123",
			mode: "act",
			approval_mode: "manual",
			ailiance_agent_version: "0.1.0",
			gateway_url: "http://studio:9300",
		})
		const metaPath = path.join(tmpDir, TRACING_DIR_NAME, "task-123", "meta.json")
		expect(fs.existsSync(metaPath)).toBe(true)
		const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"))
		expect(meta.schema_version).toBe(TRACING_SCHEMA_VERSION)
		expect(meta.run_id).toBe("task-123")
		expect(meta.gateway_url).toBe("http://studio:9300")
		expect(meta.ended_at).toBeNull()
		expect(meta.exit_code).toBeNull()
	})

	it("appends valid JSON lines to trace.jsonl with monotonic turns", () => {
		const tracer = new JsonlTracer("task-abc", tmpDir)
		tracer.writeMeta({
			task: "task-abc",
			mode: "act",
			approval_mode: "yolo",
			ailiance_agent_version: "0.1.0",
			gateway_url: "http://studio:9300",
		})
		tracer.appendTurn({
			phase: "execute",
			tool_execution: {
				tool_name: "read_file",
				tool_args: { path: "/tmp/x" },
				tool_result: "ok",
				latency_ms: 5,
				success: true,
			},
		})
		tracer.appendTurn({
			phase: "execute",
			tool_execution: {
				tool_name: "execute_command",
				tool_args: { command: "ls" },
				tool_result: "out",
				latency_ms: 8,
				success: true,
			},
		})
		const tracePath = path.join(tmpDir, TRACING_DIR_NAME, "task-abc", "trace.jsonl")
		const lines = fs.readFileSync(tracePath, "utf8").trim().split("\n")
		expect(lines).toHaveLength(2)
		const first = JSON.parse(lines[0])
		const second = JSON.parse(lines[1])
		expect(first.turn).toBe(1)
		expect(second.turn).toBe(2)
		expect(first.tool_execution.tool_name).toBe("read_file")
		expect(first.schema_version).toBe(TRACING_SCHEMA_VERSION)
		expect(first.errors).toEqual([])
	})

	it("scrubs secrets from tool args before they hit disk", () => {
		const tracer = new JsonlTracer("task-secrets", tmpDir)
		tracer.writeMeta({
			task: "task-secrets",
			mode: "act",
			approval_mode: "manual",
			ailiance_agent_version: "0.1.0",
			gateway_url: "http://studio:9300",
		})
		tracer.appendTurn({
			phase: "execute",
			tool_execution: {
				tool_name: "execute_command",
				tool_args: { command: "curl -H 'Authorization: Bearer abcdefghij' http://x" },
				tool_result: { api_key: "should-not-appear" },
				latency_ms: 1,
				success: true,
			},
		})
		const tracePath = path.join(tmpDir, TRACING_DIR_NAME, "task-secrets", "trace.jsonl")
		const raw = fs.readFileSync(tracePath, "utf8")
		expect(raw).not.toContain("should-not-appear")
		expect(raw).not.toContain("abcdefghij")
		expect(raw).toContain("[REDACTED]")
	})

	it("close() finalises meta.json with ended_at and exit code", () => {
		const tracer = new JsonlTracer("task-close", tmpDir)
		tracer.writeMeta({
			task: "task-close",
			mode: "act",
			approval_mode: "manual",
			ailiance_agent_version: "0.1.0",
			gateway_url: "http://studio:9300",
		})
		tracer.close("attempt_completion", 0, { turns: 3 })
		const meta = JSON.parse(
			fs.readFileSync(path.join(tmpDir, TRACING_DIR_NAME, "task-close", "meta.json"), "utf8"),
		)
		expect(meta.ended_at).toMatch(/T/)
		expect(meta.exit_reason).toBe("attempt_completion")
		expect(meta.exit_code).toBe(0)
		expect(meta.stats.turns).toBe(3)
	})

	it("close() is idempotent — second call does not overwrite ended_at", () => {
		const tracer = new JsonlTracer("task-idem", tmpDir)
		tracer.writeMeta({
			task: "task-idem",
			mode: "act",
			approval_mode: "manual",
			ailiance_agent_version: "0.1.0",
			gateway_url: "http://studio:9300",
		})
		tracer.close("aborted", 130)
		const metaPath = path.join(tmpDir, TRACING_DIR_NAME, "task-idem", "meta.json")
		const first = JSON.parse(fs.readFileSync(metaPath, "utf8"))
		// Second call must not change anything (idempotent).
		tracer.close("error", 1)
		const second = JSON.parse(fs.readFileSync(metaPath, "utf8"))
		expect(second.ended_at).toBe(first.ended_at)
		expect(second.exit_reason).toBe("aborted")
		expect(second.exit_code).toBe(130)
	})

	it("close('aborted', 130) sets the abort exit reason and SIGINT code", () => {
		const tracer = new JsonlTracer("task-abort", tmpDir)
		tracer.writeMeta({
			task: "task-abort",
			mode: "act",
			approval_mode: "manual",
			ailiance_agent_version: "0.1.0",
			gateway_url: "http://studio:9300",
		})
		tracer.close("aborted", 130)
		const meta = JSON.parse(
			fs.readFileSync(path.join(tmpDir, TRACING_DIR_NAME, "task-abort", "meta.json"), "utf8"),
		)
		expect(meta.ended_at).toMatch(/T/)
		expect(meta.exit_reason).toBe("aborted")
		expect(meta.exit_code).toBe(130)
	})

	it("rejects taskId with path traversal segments", () => {
		expect(() => new JsonlTracer("../etc/passwd", tmpDir)).toThrow(/invalid taskId/)
	})

	it("rejects taskId with embedded slashes", () => {
		expect(() => new JsonlTracer("task/with/slashes", tmpDir)).toThrow(/invalid taskId/)
	})

	it("accepts a valid ULID-shaped taskId", () => {
		expect(() => new JsonlTracer("01ARZ3NDEKTSV4RRFFQ69G5FAV", tmpDir)).not.toThrow()
	})

	it("persistMeta writes atomically (no leftover .tmp on success)", () => {
		const tracer = new JsonlTracer("task-atomic", tmpDir)
		tracer.writeMeta({
			task: "task-atomic",
			mode: "act",
			approval_mode: "manual",
			ailiance_agent_version: "0.1.0",
			gateway_url: "http://studio:9300",
		})
		const dir = path.join(tmpDir, TRACING_DIR_NAME, "task-atomic")
		const files = fs.readdirSync(dir)
		expect(files).toContain("meta.json")
		expect(files.some((f) => f.endsWith(".tmp"))).toBe(false)
		// meta.json must be valid JSON (proves rename succeeded fully).
		const meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8"))
		expect(meta.run_id).toBe("task-atomic")
	})

	it("recordPlannerTurn writes a plan-phase TraceLine with raw + latency", () => {
		const tracer = new JsonlTracer("task-plan", tmpDir)
		tracer.writeMeta({
			task: "task-plan",
			mode: "act",
			approval_mode: "manual",
			ailiance_agent_version: "0.1.0",
			gateway_url: "http://studio:9300",
		})
		tracer.recordPlannerTurn("hello world", 42)
		const tracePath = path.join(tmpDir, TRACING_DIR_NAME, "task-plan", "trace.jsonl")
		const lines = fs.readFileSync(tracePath, "utf8").trim().split("\n")
		expect(lines).toHaveLength(1)
		const line = JSON.parse(lines[0])
		expect(line.phase).toBe("plan")
		expect(line.tool_execution).toBeNull()
		expect(line.planner_response.raw).toBe("hello world")
		expect(line.planner_response.latency_ms).toBe(42)
		expect(line.planner_response.parse_status).toBe("ok")
		expect(line.errors).toEqual([])
	})

	it("recordPlannerTurn marks parse_status='error' and propagates errors", () => {
		const tracer = new JsonlTracer("task-plan-err", tmpDir)
		tracer.writeMeta({
			task: "task-plan-err",
			mode: "act",
			approval_mode: "manual",
			ailiance_agent_version: "0.1.0",
			gateway_url: "http://studio:9300",
		})
		tracer.recordPlannerTurn("oops", 7, ["transport_failed"])
		const tracePath = path.join(tmpDir, TRACING_DIR_NAME, "task-plan-err", "trace.jsonl")
		const line = JSON.parse(fs.readFileSync(tracePath, "utf8").trim().split("\n")[0])
		expect(line.planner_response.parse_status).toBe("error")
		expect(line.errors).toEqual(["transport_failed"])
	})

	it("is a no-op when taskId or cwd are missing", () => {
		const tracer = new JsonlTracer("", tmpDir)
		expect(tracer.isEnabled).toBe(false)
		// must not throw
		tracer.writeMeta({
			task: "x",
			mode: "act",
			approval_mode: "manual",
			ailiance_agent_version: "0.1.0",
			gateway_url: "http://x",
		})
		tracer.appendTurn({ phase: "execute" })
		tracer.close("aborted", 1)
	})

	it("scrubs inline credentials from gateway_url before writing meta.json", () => {
		const tracer = new JsonlTracer("task-metascrub", tmpDir)
		tracer.writeMeta({
			task: "task-metascrub",
			mode: "act",
			approval_mode: "manual",
			ailiance_agent_version: "0.1.0",
			gateway_url: "http://admin:hunter2@studio:9300",
		})
		const raw = fs.readFileSync(path.join(tmpDir, TRACING_DIR_NAME, "task-metascrub", "meta.json"), "utf8")
		expect(raw).not.toContain("hunter2")
		expect(raw).toContain("[REDACTED]")
		// in-memory meta stays intact for later merges (only the on-disk copy is scrubbed)
		tracer.mergeStats({ turns: 1 })
		const after = JSON.parse(fs.readFileSync(path.join(tmpDir, TRACING_DIR_NAME, "task-metascrub", "meta.json"), "utf8"))
		expect(after.stats.turns).toBe(1)
	})

	it("scrubs secrets that surface in error strings", () => {
		const tracer = new JsonlTracer("task-errscrub", tmpDir)
		tracer.writeMeta({
			task: "task-errscrub",
			mode: "act",
			approval_mode: "manual",
			ailiance_agent_version: "0.1.0",
			gateway_url: "http://studio:9300",
		})
		tracer.recordPlannerTurn("nope", 3, ["auth failed for token=supersecretvalue"])
		const line = JSON.parse(
			fs.readFileSync(path.join(tmpDir, TRACING_DIR_NAME, "task-errscrub", "trace.jsonl"), "utf8").trim().split("\n")[0],
		)
		expect(JSON.stringify(line.errors)).not.toContain("supersecretvalue")
	})
})
