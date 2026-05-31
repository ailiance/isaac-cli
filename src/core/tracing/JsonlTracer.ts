// ailiance-agent fork: tracing hook (EU AI Act-compliant per-task JSONL traces)
//
// Mirrors the Python schema in ailiance-agent-py-archive/src/ailiance_agent/tracing/
// at version 1.0.0. Field names are aligned (snake_case JSON, camelCase TS
// inputs serialised to snake_case on disk so a Python reader can ingest the
// directory directly).
//
// Layout written under <taskCwd>/.ailiance-agent/runs/<task-id>/:
//   - meta.json     : RunMeta (rewritten on close())
//   - trace.jsonl   : one TraceLine per agent turn, append-only

import * as fs from "node:fs"
import * as path from "node:path"

export const TRACING_SCHEMA_VERSION = "1.0.0"
export const TRACING_DIR_NAME = ".ailiance-agent/runs"

// "key: value" / "key=value" / "Authorization: Bearer <token>" shapes.
// The optional [A-Za-z0-9_-]* between the keyword and the separator catches
// suffixed fields like aws_secret_access_key=... or api_key_v2: ....
// Keyword set kept in sync with the object-key regex in scrubObjectKey().
const SECRET_KV_PATTERN =
	/((?:password|token|api[_-]?key|secret|credential|credentials|passphrase|private[_-]?key|ssh[_-]?key|signing[_-]?key|certificate|conn(?:ection)?[_-]?str|aws[_-]?secret|aws[_-]?access[_-]?key)[A-Za-z0-9_-]*["'\s]*[=:]["'\s]*)([^\s,;"'})]+)/gi
const BEARER_PATTERN = /(authorization["'\s]*[=:]["'\s]*(?:bearer|basic)\s+)([A-Za-z0-9._\-+/=]+)/gi
// Well-known token shapes:
//   - sk-..., ghp_..., xox?-..., JWT (eyJ...)
//   - AWS access key IDs (AKIA[A-Z0-9]{16})
//   - PEM key blocks (BEGIN...END, multiline)
const SECRET_VALUE_PATTERN =
	/\b(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|AKIA[A-Z0-9]{16})\b/g
const PEM_PATTERN = /-----BEGIN [A-Z ]+(?:PRIVATE )?KEY-----[\s\S]*?-----END [A-Z ]+(?:PRIVATE )?KEY-----/g
// scheme://user:pass@host -> scheme://[REDACTED]:[REDACTED]@host
const URL_CREDENTIAL_PATTERN = /(\w[\w+.-]*:\/\/)([^:@/\s]+):([^@/\s]+)@/g
const REDACTED = "[REDACTED]"

export interface WorkerInfo {
	model: string
	adapter?: string | null
	endpoint: string
}

export interface RunMeta {
	schema_version: string
	run_id: string
	started_at: string
	ended_at?: string | null
	exit_code?: number | null
	exit_reason?: string | null
	task: string
	cwd: string
	mode: string
	hint_domain?: string | null
	approval_mode: string
	ailiance_agent_version: string
	gateway_url: string
	workers: Record<string, WorkerInfo>
	stats: Record<string, unknown>
	limits_hit: string[]
}

export type TracePhase = "plan" | "execute" | "summarize" | "abort"

export interface TraceLine {
	schema_version: string
	run_id: string
	turn: number
	timestamp: string
	phase: TracePhase
	context_window?: Record<string, unknown> | null
	planner_request?: Record<string, unknown> | null
	planner_response?: Record<string, unknown> | null
	tool_execution?: ToolExecutionRecord | null
	errors: string[]
}

export interface ToolExecutionRecord {
	tool_name: string
	tool_args?: Record<string, unknown> | null
	tool_result?: unknown
	latency_ms: number
	success: boolean
}

export interface RunMetaSeed {
	task: string
	mode: string
	approval_mode: string
	ailiance_agent_version: string
	gateway_url: string
	workers?: Record<string, WorkerInfo>
	hint_domain?: string | null
}

/**
 * Recursively scrub anything that looks like a secret. Used for both
 * structured dictionaries (tool_args) and stringified blobs (tool_result).
 */
export function scrubSecrets<T>(value: T): T {
	return scrubValue(value, new WeakSet()) as T
}

function scrubValue(value: unknown, seen: WeakSet<object>): unknown {
	if (value == null) return value
	if (typeof value === "string") return scrubString(value)
	if (typeof value !== "object") return value
	if (seen.has(value as object)) return "[CIRCULAR]"
	seen.add(value as object)
	if (Array.isArray(value)) {
		return value.map((item) => scrubValue(item, seen))
	}
	const out: Record<string, unknown> = {}
	for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
		if (
			/password|token|api[_-]?key|secret|bearer|authorization|credential|credentials|private[_-]?key|conn(?:ection)?[_-]?str|passphrase|ssh[_-]?key|signing[_-]?key|certificate|aws[_-]?secret|aws[_-]?access[_-]?key/i.test(
				k,
			)
		) {
			out[k] = REDACTED
		} else {
			out[k] = scrubValue(v, seen)
		}
	}
	return out
}

function scrubString(str: string): string {
	// PEM blocks first — they span multiple lines and would confuse the
	// other patterns if we kept them around.
	let result = str.replace(PEM_PATTERN, REDACTED)
	// Well-known token shapes (sk-..., ghp_..., AKIA..., JWTs, ...)
	result = result.replace(SECRET_VALUE_PATTERN, REDACTED)
	// scheme://user:pass@host
	result = result.replace(URL_CREDENTIAL_PATTERN, (_m, scheme: string) => `${scheme}${REDACTED}:${REDACTED}@`)
	// Authorization: Bearer <token> / Authorization: Basic <token>
	result = result.replace(BEARER_PATTERN, (_match, prefix: string) => `${prefix}${REDACTED}`)
	// Generic key=value / key: value
	result = result.replace(SECRET_KV_PATTERN, (_match, prefix: string) => `${prefix}${REDACTED}`)
	return result
}

export class JsonlTracer {
	private readonly runDir: string
	private readonly metaPath: string
	private readonly tracePath: string
	private meta: RunMeta | null = null
	private turn = 0
	private closed = false
	private readonly enabled: boolean
	// ailiance-agent fork: serialise concurrent appendTurn calls.
	// When the planner dispatches parallel tool calls (`enableParallelToolCalls`),
	// multiple appendTurn invocations race on both the `turn` counter AND the
	// JSONL file write. We chain every write onto a single Promise so that
	// turn numbering stays monotonic and lines never interleave on disk.
	private writeChain: Promise<void> = Promise.resolve()

	constructor(
		private readonly taskId: string,
		private readonly taskCwd: string,
	) {
		this.enabled = !!taskId && !!taskCwd
		// Allowlist taskId before joining it into a filesystem path. Anything
		// outside [A-Za-z0-9_-] could escape the runs/ subtree (e.g. "..", "/")
		// or break shell tooling that scans the trace dir. We surface the bug
		// loudly rather than silently sanitising — a malformed taskId means an
		// upstream caller is broken and should be fixed.
		if (this.enabled && !/^[a-zA-Z0-9_-]+$/.test(taskId)) {
			throw new Error(`invalid taskId for trace: ${taskId}`)
		}
		this.runDir = path.join(taskCwd || ".", TRACING_DIR_NAME, taskId || "unknown")
		this.metaPath = path.join(this.runDir, "meta.json")
		this.tracePath = path.join(this.runDir, "trace.jsonl")
		if (this.enabled) {
			try {
				fs.mkdirSync(this.runDir, { recursive: true })
			} catch (_err) {
				// Best-effort: tracing must never break a task.
			}
			// ailiance-agent fork: best-effort trace rotation. Never blocks task
			// start — failures are swallowed.
			void this.maybePruneAsync()
		}
	}

	private async maybePruneAsync(): Promise<void> {
		try {
			const { prune } = await import("./pruner.js")
			const runsRoot = path.dirname(this.runDir)
			await prune({ dir: runsRoot })
		} catch {
			// swallow — rotation is opportunistic
		}
	}

	get directory(): string {
		return this.runDir
	}

	writeMeta(seed: RunMetaSeed): void {
		if (!this.enabled || this.closed) return
		const startedAt = new Date().toISOString()
		this.meta = {
			schema_version: TRACING_SCHEMA_VERSION,
			run_id: this.taskId,
			started_at: startedAt,
			ended_at: null,
			exit_code: null,
			exit_reason: null,
			task: seed.task,
			cwd: this.taskCwd,
			mode: seed.mode,
			hint_domain: seed.hint_domain ?? null,
			approval_mode: seed.approval_mode,
			ailiance_agent_version: seed.ailiance_agent_version,
			gateway_url: seed.gateway_url,
			workers: seed.workers ?? {},
			stats: {},
			limits_hit: [],
		}
		this.persistMeta()
	}

	appendTurn(input: Partial<TraceLine> & { phase: TracePhase }): TraceLine | null {
		if (!this.enabled || this.closed) return null
		// ailiance-agent fork: increment + serialise. The turn counter is bumped
		// synchronously so callers see a stable line.turn, but the actual
		// file append is queued onto writeChain to prevent interleaved bytes
		// when parallel tool calls race here.
		this.turn += 1
		const line: TraceLine = {
			schema_version: TRACING_SCHEMA_VERSION,
			run_id: this.taskId,
			turn: this.turn,
			timestamp: input.timestamp ?? new Date().toISOString(),
			phase: input.phase,
			context_window: input.context_window ?? null,
			planner_request: input.planner_request ? scrubSecrets(input.planner_request) : null,
			planner_response: input.planner_response ? scrubSecrets(input.planner_response) : null,
			tool_execution: input.tool_execution
				? {
						tool_name: input.tool_execution.tool_name,
						tool_args: scrubSecrets(input.tool_execution.tool_args ?? null),
						tool_result: scrubSecrets(input.tool_execution.tool_result),
						latency_ms: input.tool_execution.latency_ms,
						success: input.tool_execution.success,
					}
				: null,
			errors: input.errors ? scrubSecrets(input.errors) : [],
		}
		this.queueAppend(this.tracePath, line)
		return line
	}

	/**
	 * Wait for all queued writes to flush. Tests use this to assert
	 * deterministic on-disk ordering after firing N appendTurn calls in
	 * parallel. Synchronous callers do not need to await this — the file
	 * has already been written by `fs.appendFileSync` before appendTurn
	 * returned.
	 */
	async flush(): Promise<void> {
		await this.writeChain
	}

	// ailiance-agent fork: record an LLM API roundtrip ("planner" turn) so that
	// every API call shows up in trace.jsonl — even the ones that fail before
	// any tool executes. The Python ailiance-agent captured raw text + latency_ms
	// per planner response; we mirror that shape here.
	recordPlannerTurn(rawResponse: string, latencyMs: number, errors: string[] = []): TraceLine | null {
		return this.appendTurn({
			phase: "plan",
			planner_response: {
				raw: rawResponse,
				latency_ms: latencyMs,
				parse_status: errors.length > 0 ? "error" : "ok",
			},
			errors,
		})
	}

	mergeStats(stats: Record<string, unknown>): void {
		if (!this.enabled || this.closed || !this.meta) return
		this.meta.stats = { ...this.meta.stats, ...stats }
		this.persistMeta()
	}

	close(exitReason: string, exitCode: number, extraStats?: Record<string, unknown>): void {
		if (!this.enabled || this.closed || !this.meta) {
			this.closed = true
			return
		}
		this.meta.ended_at = new Date().toISOString()
		this.meta.exit_reason = exitReason
		this.meta.exit_code = exitCode
		if (extraStats) {
			this.meta.stats = { ...this.meta.stats, ...extraStats }
		}
		this.persistMeta()
		this.closed = true
	}

	get isEnabled(): boolean {
		return this.enabled
	}

	get isClosed(): boolean {
		return this.closed
	}

	private persistMeta(): void {
		if (!this.meta) return
		// ailiance-agent fork: atomic meta.json write — write to a sibling .tmp
		// file then rename. rename(2) is atomic on POSIX, so a crash
		// mid-write leaves either the previous valid meta.json or a stray
		// .tmp (never a half-written meta.json). The Python ailiance-agent tracer
		// uses the same pattern.
		const tmpPath = `${this.metaPath}.tmp`
		try {
			// Scrub at the single persist point so credential-bearing fields
			// (gateway_url with inline creds, worker endpoints) never hit disk.
			// scrubSecrets returns a deep copy, so this.meta stays intact for
			// later merges (mergeStats / close).
			fs.writeFileSync(tmpPath, JSON.stringify(scrubSecrets(this.meta), null, 2), "utf8")
			fs.renameSync(tmpPath, this.metaPath)
		} catch (_err) {
			// swallow — tracing is non-fatal. Best-effort cleanup of the tmp.
			try {
				fs.unlinkSync(tmpPath)
			} catch (_err2) {
				// ignore
			}
		}
	}

	private appendLine(target: string, payload: unknown): void {
		try {
			fs.appendFileSync(target, `${JSON.stringify(payload)}\n`, "utf8")
		} catch (_err) {
			// swallow — tracing is non-fatal
		}
	}

	// ailiance-agent fork: queue an append. We use the synchronous
	// fs.appendFileSync so that callers get read-after-write semantics
	// (existing tests + downstream readers rely on this), while ALSO
	// chaining a resolved Promise onto writeChain so flush() can be
	// awaited as a barrier. Because appendTurn is fully synchronous and
	// JS is single-threaded, parallel callers serialise naturally on
	// the event loop — but the explicit chain documents the intent and
	// guards against future async refactors of this method.
	private queueAppend(target: string, payload: unknown): void {
		const line = `${JSON.stringify(payload)}\n`
		try {
			fs.appendFileSync(target, line, "utf8")
		} catch (_err) {
			// swallow — tracing is non-fatal
		}
		this.writeChain = this.writeChain.catch(() => undefined).then(() => undefined)
	}
}
