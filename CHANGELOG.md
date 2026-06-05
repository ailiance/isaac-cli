## [Unreleased] — Rebrand → ISAAC

### Changed
- **Product rebrand `aki` → `ISAAC`** (Intelligence Souveraine Ailiance Agent
  Codeur). The CLI command is now `isaac` (the `aki` and `ailiance-agent` bin
  names are dropped — no alias). npm package `ailiance-agent` → `isaac`,
  `ailiance-agent-cli` → `isaac-cli`, VS Code `displayName`/command categories →
  `ISAAC`. Env vars `AKI_STRICT_PROVIDER`/`AKI_WEBUI_URL` → `ISAAC_*`. Stack dir
  `~/.aki/` → `~/.isaac/`. New 3D-extruded ASCII wordmark on the welcome banner.
- **Kept (parent brand / compat):** the `ailiance` brand everywhere (org, gateway,
  `AILIANCE_*` env — it is the "A" in ISAAC), the legacy `dirac.*` VS Code command
  IDs, the `~/.dirac` storage and `.ailiance-agent/runs` + `~/.ailiance-agent/memory`
  data directories, and the `ailiance/isaac-cli` repository URLs.

## [0.9.1-beta] — 2026-05-12

### Added
- **Auto-injection of memories at turn-1 of each new task** (the deferred half of v0.9.0). `PromptBuilder.preparePlaceholders()` now calls `loadRelevantMemories(cwd)` and splices the result into a new `{{MEMORIES_SECTION}}` placeholder in the system prompt template, right after `{{SKILLS_SECTION}}`. The section renders only when at least one memory survived the budget filter; otherwise the placeholder collapses to the empty string.
- Two helpers in `src/utils/ailiance-memory.ts`:
  - `projectScopeFromCwd(cwd)`: derives `project:<slug>` from the basename of the working directory (lowercased, non-alphanumeric → `-`). Mirrors Claude Code's project-memory layout.
  - `loadRelevantMemories(cwd)`: returns project-scoped memories first then global, capped at ~8 000 chars (≈ 2 000 tokens) so an unbounded memory store cannot dominate the prompt. Sets `truncated: true` when the cap kicks in.
  - `formatMemoriesSection(loaded)`: renders the markdown section with a `# USER MEMORIES` header, per-memory blocks (`## name (type, scope)`, italicised description, body verbatim), and a truncation footer when needed.
- 10 new unit tests on top of the v0.9.0 storage tests: scope slugification, project-first ordering, budget enforcement, formatting edge cases, truncation footer.

### Why this matters
v0.9.0 saved memories but the agent never read them itself. Now every new task automatically receives the user's accumulated context — preferences, repo conventions, gotchas — as durable system-prompt content. Combined with v0.8.2 (auto-condense) and v0.8.3 (real ctx-window), the agent both starts each task informed AND keeps that information across condense cycles within the task.

### Safety
- Budget cap (≈ 2 000 tokens) prevents prompt bloat.
- `isTesting=true` short-circuits the injection so existing system-prompt integration tests stay deterministic.
- Best-effort error handling: any filesystem / parse failure collapses the section to empty, never breaks the prompt assembly.
- The prompt instructs the model to "apply silently, do not echo memories back", reducing the risk of memories leaking verbatim into responses.

---

## [0.9.0-beta] — 2026-05-12

### Added
- **Cross-task memory** — new `src/utils/ailiance-memory.ts` module + `ailiance-agent memory {remember,list,show,forget}` subcommands. Persists user-level knowledge (preferences, repo conventions, gotchas) at `~/.ailiance-agent/memory/` as markdown files with YAML frontmatter, modeled on Claude Code's memory layout. Each entry has a `name` (kebab-case slug), `description` (one-line summary), `type` (`user` / `feedback` / `project` / `reference`), and `scope` (`global` or `project:<slug>`). An auto-rebuilt `MEMORY.md` index lists everything for human inspection.
- 8 unit tests covering save/list/delete/find lifecycle, project-scope filtering, fuzzy-match disambiguation, name validation, and chronological ordering. 63 total tests pass.

### Usage
```bash
ailiance-agent memory remember "Prefers French" "Reply in French unless asked otherwise" --type user
ailiance-agent memory list --type feedback
ailiance-agent memory show prefers-french
ailiance-agent memory forget prefers-french
```

### Out of scope (follow-up)
- **Auto-injection of relevant memories at turn-1 of each new task** — touches the system-prompt assembly path and warrants its own focused review. The current PR ships only the storage + CLI surface. Until injection lands, memories are user-facing knowledge management; the agent does not yet read them autonomously during task execution.
- Project-scope autodetection from `cwd` (currently the user must pass `--scope project:<slug>` explicitly).

---

## [0.8.3-beta] — 2026-05-12

### Added
- Consume the `X-Ailiance-Context-Window` header emitted by the gateway (companion `ailiance/ailiance#79`). `ailiance-worker-info.ts` parses the value into `WorkerInfo.contextWindow`, and `openai.ts:getModel()` overrides `info.contextWindow` from upstream's 128k default to the real ceiling of the worker that served the most recent response (Qwen3-Next 80B = 196608, Mistral-Medium 128B = 256000, Qwen3-Coder-30B = 262144, Granite/Llama/etc. = 131072, Mixtral 8x22B = 65536, Mistral-Small / macm1 / Tower Ollama = 32768).
- Task summary footer now shows the context-window of the worker that served the turn: `[ailiance model=qwen-32b-awq · port=8002 · ctx=192k]`. Lets the user see exactly how much room there is before the auto-condense path (75% threshold) would trigger.

### Why this matters
Combined with v0.8.2's `useAutoCondense=true` default, the agent now triggers the intelligent summarize_task at 75% of the **real** worker ceiling — for a Qwen3-Coder run that means 196k tokens of headroom before the first condense, versus 96k under the upstream 128k assumption. Long agentic tasks (refactors, multi-file edits, big repo exploration) get roughly **2× the productive window** on the same hardware.

---

## [0.8.2-beta] — 2026-05-12

### Changed
- **`useAutoCondense` is now ON by default**. Upstream Dirac ships this as `false`, which means the agent only truncates conversation history at 80% of the context window (`maxAllowedSize`) and brute-forces a half/quarter removal of intermediate turns. The auto-condense path instead invokes the `summarize_task` tool at a 75% threshold, producing a structured summary that preserves the agent's intent and the files-touched ledger. On the ailiance gateway (Mistral-Medium 128B, Qwen-80B, auto-router chains) the intelligent summary is decisively better than truncate-and-pray. Set `useAutoCondense=false` in the TUI settings to revert.
- Stale-default migration extended: already-onboarded users whose persisted `useAutoCondense` is the upstream `false` / undefined are silently flipped to `true` on the first run of v0.8.2, without forcing a re-onboard or config tour.

### Audit notes
- `discoveredSkillsCache` is already used correctly via `getOrDiscoverSkills(cwd, taskState)` in `src/core/context/instructions/user-instructions/skills.ts:194`. Initial audit mis-grepped the field — the cache works as designed.

---

## [0.8.1-beta] — 2026-05-12

### Fixed
- **Retry on permanent 4xx errors** (`src/core/task/ApiRequestHandler.ts`). The auto-retry path treated every non-auth / non-credits error as transient and burned 3 attempts with exponential backoff (~14 s total) before giving up. Backends returning a deterministic 400 ("model does not support tools" from Ollama is the canonical case observed against `ailiance-kicad`) cannot succeed by retrying. Status codes 400, 404, 422, 501 now skip the retry path and surface the error immediately with a `permanent: true` flag in the `error_retry` payload.
- **Double dispatch of XML hallucinated tools when native FC is also active** (`src/core/task/ResponseProcessor.ts`). The v0.7 XML dispatch path fired unconditionally on a complete text block matching `hasHallucinatedToolXml`. When the same stream also produced a native `tool_use` block (some MLX backends emit both: a delta with `tool_calls` AND text containing the XML imitation), the synthetic ToolUse from XML was dispatched first, then the native one ran the same tool a second time. Guard added: skip the XML path when `useNativeToolCalls === true` AND the parsed `assistantMessageContent` already contains at least one `tool_use` block.
- **Faster fail when a backend returns empty output** (`src/core/task/AgentLoopRunner.ts`). Some MLX backends (Mistral-Medium-128B observed 2026-05-12) accept a `tools[]` request but reply with `finish_reason=stop` and empty content — neither a tool_call nor visible text. The agent previously needed 5 such iterations to hit `maxConsecutiveMistakes`. Empty-output responses now count double, so the same condition triggers abort in 3 iterations. Transient single-chunk stalls (1 empty + 4 normal) still recover normally.

### Audit notes
- Re-entry through `presentAssistantMessageHasPendingUpdates` (`ResponseProcessor.ts:334`) is idempotent today because the XML dispatch is gated on `!block.partial` and the per-block index advances before the recursive call. Left untouched.
- The `@withRetry()` decorator in `src/core/api/retry.ts` is correctly scoped to rate-limit errors (status 429) only when `retryAllErrors=false` (the default). The 3-retry storms users observed were entirely from the `ApiRequestHandler` layer fixed above.

---

## [0.8.0-beta] — 2026-05-12

### Added
- Worker / LoRA visibility. The CLI now captures the `X-Ailiance-*` HTTP response headers (port, domain, chain policy, upstream backend fingerprint, upstream model id) emitted by the gateway (companion ailiance/ailiance PR #78). A new module `src/utils/ailiance-worker-info.ts` wraps the configured fetch in `src/shared/net.ts` to intercept every `/chat/completions` response and store the latest headers in a session-local cache. The task summary in plain-text mode (`-y` or `--verbose`) now ends with a line like `[ailiance model=mascarade-kicad:latest · port=8004 · domain=kicad · backend=fp_ollama]` so the user can see which backend (and which LoRA, when applicable) actually served the turn. Falls back silently to no extra line when talking to a non-ailiance gateway.

---

## [0.7.2-beta] — 2026-05-12

### Documented
- New README section "Outils de l'agent — read / write / bash" covering the 3 primary tools (with their handler files + limits), the 3 auto-approve modes (yolo / autoApproveAll / per-action), the shell safety zones (`auto_ok` enumerated; `confirm` enumerated; `hard_deny` enumerated with exit code 8 contract), the 18 long-runner regex patterns that bump timeout from 30 s to 300 s, and how the v0.7 XML hallucination fallback ties back to the gateway's `FC_FORCE_ROUTE_PORT`.

---

## [0.7.1-beta] — 2026-05-12

### Fixed
- Bare `ailiance-agent` (no positional prompt) used to crash with an opaque `Raw mode is not supported on the current process.stdin` stack trace from `ink-picture`'s terminal-info probe whenever stdin was not a real TTY (CI runner, subprocess, piped invocation, backgrounded shell). The welcome path now detects the missing TTY via `checkRawModeSupport()` BEFORE instantiating Ink and prints a one-screen guide listing the non-interactive alternatives (`ailiance-agent "<task>"`, `echo <task> | ailiance-agent`, `--continue`, `--acp`) plus the recommended TTY hosts (Warp / iTerm / zellij / tmux). Exits with status 1.

### Documented
- README "Démarrer en 30 secondes" now ships a launch-mode matrix covering the 7 ways `ailiance-agent` can be invoked (bare TUI, positional one-shot, piped stdin, stdin + prompt, `--continue`, `--acp`, `task -y`) plus two `AILIANCE_GATEWAY` override examples (on-tailnet, custom proxy).

---

## [0.7.0-beta] — 2026-05-12

### Added
- Hallucinated XML tool-call dispatch in `ResponseProcessor.ts`. When a non-FC backend (Mistral-Medium-128B MLX, EuroLLM, Gemma macm1) emits a flat `<function=NAME>...<parameter=KEY>VALUE</parameter></function>` block on a complete text stream, the CLI now extracts it, validates the name against `IsaacDefaultTool` (with a model-alias map covering `bash`/`grep`/`writefile`/`listfiles` and case drift), synthesises a non-native `ToolUse` block, and dispatches via `toolExecutor.executeTool`. Residual prose is preserved so any explanation the model emitted alongside the call is still shown. Closes the agent-loop retry storm observed in v0.6.x when the gateway's FC force-route did not catch a backend.
- New `canonicaliseToolName(name, knownTools)` helper in `parse-hallucinated-tool-xml.ts` with strict policy: unknown names return `null` rather than being silently dispatched, preventing crashes in `toolExecutor` from invented tool names.

### Changed
- Parser module moved from `cli/src/utils/parse-hallucinated-tool-xml.ts` to `src/utils/parse-hallucinated-tool-xml.ts` so `ResponseProcessor.ts` (library side, lives in `src/core/task/`) can import it via the `@/utils/` alias without crossing the CLI/library boundary. Tests import via the same alias; vitest setup unchanged.

### Tests
- 18 unit tests on the parser module (12 prior + 6 new for `canonicaliseToolName` covering exact-match, case drift, observed aliases, strict-null on unknown, alias gated on runtime tool exposure, and whitespace trimming).

### Out of scope (now closed)
- Companion gateway-side fix (`FC_FORCE_ROUTE_PORT` redirect of `tools[]` to native-FC worker) shipped in `ailiance/ailiance` PR #76 — merged + deployed. This CLI parser is defense-in-depth for the case where the gateway override is disabled (`GATEWAY_FC_FORCE_ROUTE=false`) or a future non-FC backend slips into FC_CAPABLE_PORTS.

---

## [0.6.1-beta] — 2026-05-12

### Changed
- Default gateway URL `http://electron-server:9300/v1` → `https://gateway.ailiance.fr/v1`. The Cloudflare Tunnel now exposes the FastAPI gateway publicly with auto-terminated TLS, so the CLI no longer requires Tailscale to reach the backend. On-tailnet users can override with `AILIANCE_GATEWAY=http://electron-server:9300/v1` for lower latency and no CF hop.

### Added
- Silent migration extended to promote v0.6.0 Tailscale-internal defaults to the new public endpoint on upgrade: `http://electron-server:9300[/v1]`, `http://electron-server.tail*.ts.net:9300[/v1]`, and `http://100.78.191.52:9300[/v1]` are all rewritten to `https://gateway.ailiance.fr/v1` without forcing a re-onboard.

### Tests
- 4 new cases in `cli/src/utils/__tests__/ailiance-default.test.ts` cover the v0.6.0 → public migration paths and confirm user-supplied URLs (`https://api.openai.com/v1`, `http://my-custom-proxy/v1`) stay untouched.

---

## [0.6.0-beta] — 2026-05-12

### Fixed
- Source file `cli/src/utils/eu-kiki-default.ts` renamed to `ailiance-default.ts` to match `init.ts` and test imports left by PR #7. The build was broken on a clean clone.
- Default gateway URL `http://studio:9300` → `http://electron-server:9300/v1`. Studio is not the gateway host (it runs MLX workers); the gateway is FastAPI on electron-server, and the OpenAI-compatible SDK requires the `/v1` suffix to avoid 404s.
- `cli/package.json` `unlink` script targeted the obsolete `dirac-cli` package; now correctly unlinks `ailiance-agent-cli`.

### Added
- `AILIANCE_GATEWAY` env var as the primary gateway override. `AGENT_KIKI_GATEWAY` retained as a deprecated alias so existing shell configs keep working; `AILIANCE_GATEWAY` takes precedence when both are set.
- Boot-time gateway prewarm (`cli/src/utils/ailiance-prewarm.ts`): GET `/v1/models` with a 5 s timeout, surfaced on success with `ailiance gateway ready: N models in Mms via URL`, on failure with a stderr line carrying an `AILIANCE_GATEWAY=...` override hint. Failure is non-fatal so the user can recover via config commands.
- Module-local cache for the prewarmed model list, available to command handlers via `getAilianceGatewayCache()`. Avoids a second `/v1/models` round-trip on the first prompt.
- Silent migration of stale persisted gateway URLs (`http://studio:9300*`, `http://electron-server:9300` without `/v1`, direct worker ports `:9301..9309` on studio) — `applyEuKikiDefault` now heals them transparently for already-onboarded users instead of skipping at the `auth-already-configured` gate.

### Tests
- 47 unit tests pass on `cli/src/utils/__tests__/{ailiance-default,ailiance-prewarm,parse-hallucinated-tool-xml}.test.ts` covering precedence, deprecation alias, `/v1` normalisation, HTTP and network failure paths, empty baseUrl, stale-default migration, log formatting, and the new XML tool-call parser.

### Infrastructure (deferred integration)
- New module `cli/src/utils/parse-hallucinated-tool-xml.ts` parses the `<function=NAME>...<parameter=KEY>VALUE</parameter>...</function>` shape that Mistral-Medium-128B (and other MLX workers without native function calling) emit when the gateway leaks a `tools[]` request onto a non-FC-capable backend. The parser handles `<function=...>`, `<invoke=...>`, attribute-style `<parameter name="...">`, multi-block streams, and preserves residual prose. Integration into `ResponseProcessor.ts` text-block path is deferred to v0.7 because synthesising `ToolUse` blocks mid-stream needs `StreamChunkCoordinator` state coordination — see TODO comment at `src/core/task/ResponseProcessor.ts:211`. The root cause is gateway-side (auto-router `ailiance` model must force-route to Qwen 32B vLLM when `tools[]` is present) and is tracked in the `ailiance/ailiance` gateway repo.

---

## [0.5.0-beta] — 2026-05-06

### Added
- Universal tool emulation in LocalRouter (5 formats: `<tool_call>`, ` ```tool `, ` ```json `, ` ```bash `, ` ```tool_code `, plain `read_file("...")`)
- Few-shot emulation prompt with concrete examples for write_to_file/execute_command/list_files
- Force-route logic in LocalRouter: tool-bearing requests prioritize `supportsTools:true` workers
- `aki timeline` CLI command — Ink view of task history grouped by day with emoji classification
- "TOOL CONSTRAINTS" section in system prompt forbidding hallucinated tool names
- Imperative verb detection in AutoModeSelector (fais/fait/écris/ajoute/réalise/génère/construis/implémente → ACT)

### Fixed
- Tool calls now propagate `function.id` so the toolUseIdMap maps call_id correctly across multi-turn conversations (was breaking tool_result → fell back to plain text → broke OpenAI tool protocol)
- Worker max_tokens default bumped 2048→8192 to avoid truncation mid-tool-call (server-side ailiance)
- Auto-mode soft-action verb cap raised 80→120 chars

### Server-side (ailiance gateway, not in this repo)
- Gateway forces Qwen 32B (vLLM native FC) for any request with `tools[]` — most reliable agentic worker
- Gemma `:9304` (llama.cpp pure) gets full tool emulation via gateway
- Anti-hallucination guard in `_INJECT_TEMPLATE`
- Qwen3-Next 80B-A3B (kxkm-ai) `--ctx-size` bumped 32k → 192k for long agentic sessions (~8 GB VRAM, 16 GB free margin)

### Workers status
| Worker | Tool calling |
|--------|--------------|
| Qwen 32B AWQ (vLLM, kxkm-ai) | native FC, primary route for agentic |
| Eurollm 22B (studio) | native FC via worker shim |
| Apertus 70B (studio) | via worker emulation |
| Devstral 24B (macm1) | Mistral [TOOL_CALLS] format |
| Gemma 3 4B (tower) | via gateway emulation |

---

## [0.4.0] — 2026-05-03

- Plugin marketplace: `aki plugin install <github-url>`
- MCP integration: discover and use MCP servers from installed plugins
- LocalRouter (in-process LLM router): cache, health monitoring, ctx-aware skip, SSE streaming
- Local stack (`aki stack {start,stop,status}`): managed LiteLLM proxy + Jina semantic router
- Auto plan/act mode (opt-in): `autoModeFromPrompt: true`
- Web UI at `http://127.0.0.1:25463` with worker status dashboard
- Task class reduced from 1970 → 592 lines (-70%)
- +170 tests (1047 → 1238), 0 regressions
