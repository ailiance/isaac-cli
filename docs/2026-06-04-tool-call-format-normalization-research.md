# Tool-call format normalization — research & decision (2026-06-04)

## Problem

`isaac` (fork Dirac/Cline) uses Cline's **prompt-XML tool format**
(`<write_to_file><path>…</path><content>…</content></write_to_file>`).
Sovereign coder models routed through the ailiance gateway emit their
tool calls in a **different format** and the agent fails with
`You did not use a tool` → `Too many consecutive mistakes (6)`.

Observed on MacStudio (`isaac` 0.9.1-beta, all candidate models showed
footer `[ailiance port=8500]` → everything routed through **omlx :8500**):

- `ailiance` (base) → returns plain text, no tool form.
- `ailiance-coder-pro` (Qwen3-Coder-30B) → emits a Markdown JSON block
  ```` ```json {"write_to_file": {"path": "ok.txt", "content": "READY"}} ``` ````
  i.e. **root key = tool name**, no XML, no sentinel.
- `ailiance-mistral-medium` → also failed the write_to_file task via omlx.

Root cause (confirmed by research): **omlx / mlx_lm.server leave the
tool-call markup in `message.content` when the model's format isn't in a
recognized parser branch** (documented MLX failure mode, e.g. Gemma-4
mlx-lm #1096). The model, faced with Cline's never-seen XML grammar,
falls back to the JSON tool format it was trained on. isaac's OpenAI
provider only surfaces *native* `tool_calls`; raw-text tool calls in
`content` are invisible to the tool parser.

## Findings (sourced)

### Tool-call formats by model family
| Family | Emitted format (literal) |
|---|---|
| Hermes 2/3/4, **Qwen3 dense**, Qwen2.5 | `<tool_call>{"name":"f","arguments":{…}}</tool_call>` (tags = single tokens, stream-safe) |
| **Qwen3-Coder** (30B-A3B, 480B) | `<tool_call><function=f><parameter=k>v</parameter></function></tool_call>` (raw-text values) — **near-isomorphic to Cline XML** |
| Mistral | `[TOOL_CALLS] [{"name":…,"arguments":{…}}]` |
| Llama 3.1/3.3 | JSON `{"name":…,"parameters":{…}}` (key `parameters`, not `arguments`) |
| Llama 3.2/4, ToolACE | pythonic `[get_weather(city='SF')]` |
| DeepSeek-V3/R1 | `<｜tool▁calls▁begin｜>…<｜tool▁sep｜>{json}…` |
| Granite 3.x/4 | `<tool_call>[{"name":…,"arguments":{…}}]</tool_call>` (JSON **list** in one tag) |

Hermes `<tool_call>{json}</tool_call>` is the **de-facto standard** (vLLM
`hermes` parser also serves Qwen3). `arguments` vs `parameters` (Llama)
is a known mapping pitfall.

### Server-side parsers
- **vLLM** `--enable-auto-tool-choice --tool-call-parser <hermes|mistral|llama3_json|qwen3_xml|deepseek_v3|granite|pythonic|…>` (~25 parsers). Streaming works but hermes/pythonic streaming has had regressions (vLLM #31871, #19056).
- **SGLang** `--tool-call-parser` + XGrammar EBNF (more deterministic for `tool_choice=required`).
- **llama.cpp** `--jinja` (auto-detect per template) + GBNF lazy grammars; no parser flag.
- **MLX** is the weak link: `mlx_lm.server` stock infers the parser from the chat template and **silently drops to raw `content`** for unrecognized families. `mlx-openai-server` (cubist38) and **omlx** *do* parse server-side for known formats (`--tool-call-parser qwen3|qwen3_coder|gemma|glm4_moe|…`).

### Agents (Cline / Roo / Kilo)
- **Cline v3.35 (Oct 2025) migrated to native tool calling**, split by
  model family, XML kept as fallback for models without native support.
  Reported 70-80% → ~100% multi-tool success, ~15% fewer tokens, parallel
  calls. (cline.ghost.io/cline-v3-35)
- **Roo-Code stays XML for all models**; native RFC #4047 closed
  not-planned. **Kilo #7004**: *all local providers* fail
  `MODEL_NO_TOOLS_USED` because "models respond with plain text tool calls
  instead of structured native function calls"; "only cloud providers work
  because they use XML format". Requested `toolFormat: xml|native|auto` —
  not implemented.
- Key insight: for **weak/local models the XML/text path can be MORE
  robust than ill-supported native** (BAML benchmark: gpt-4o-mini native FC
  19.8% vs schema-aligned parsing 92.4%).

### Directly reusable
- **`irreg/native_tool_call_adapter`** — proxy that converts Cline XML ⇄
  native `tool_calls`, explicitly for "smaller models like gpt-oss-20b that
  struggle with XML tool signatures".
- **BAML schema-aligned parsing** — model-agnostic tolerant parser
  (fixes unquoted strings, trailing commas, markdown-in-JSON, "yapping").
- **In-repo already present**: `src/utils/parse-hallucinated-tool-xml.ts`
  (`<function=NAME>`/`<invoke=NAME>` tolerance), `src/core/api/transform/o1-format.ts`
  (O1 XML→ToolUse), and the hook in `ResponseProcessor.presentAssistantMessage()`
  (L216-275) that already strips `<function_calls>` and calls the
  hallucinated-XML parser. The OpenAI provider (`src/core/api/providers/openai.ts`)
  already surfaces native `delta.tool_calls`.

## Decision

**Two complementary tracks, client-side first (universal, sovereign, low-risk):**

### Track 1 — Client-side normalizer in the fork (PRIMARY)
New `src/utils/normalize-tool-call-formats.ts`, called from
`ResponseProcessor` **before** `parseAssistantMessageV2`, extending the
existing hallucinated-XML tolerance. Detects, in `content`:
1. Markdown JSON block with root key = known tool name (the observed Qwen-coder-via-omlx case).
2. Hermes `<tool_call>{"name","arguments"}</tool_call>` (incl. Granite JSON-list).
3. Qwen3-Coder `<function=><parameter=>` (already partly covered — extend).
4. (later) Mistral `[TOOL_CALLS]` / DeepSeek sentinels.
→ Rewrites each into canonical Cline XML / synthetic `ToolUse` blocks so
`didToolUse` becomes true. Map `name`→tool tag, `arguments|parameters`→params.

**Why primary:** it is the only layer that sees *every* heterogeneous
backend (omlx, qwen36 custom server, future vLLM) uniformly; the repo
already has the exact anchor + a sibling parser; zero prod-gateway change
(HITL-friendly). Mirrors what `native_tool_call_adapter` and BAML do, but
in-process and tuned to Cline's tool registry (`src/shared/tools.ts`).

### Track 2 — Server-side parser on omlx (COMPLEMENTARY, infra)
Configure omlx with the right per-model `--tool-call-parser`
(`qwen3_coder` for the coder route, `qwen3`/`hermes` for qwen36) so it
returns native `tool_calls`. Faster/cleaner when it works, but
heterogeneous and silently degrades — hence Track 1 stays as the
universal safety net.

### Not chosen
- Forcing a big generalist model (defeats sovereign-coder goal; and
  generalists also failed via omlx).
- Switching the agent to native-only tool calling (backend support
  uneven → `MODEL_NO_TOOLS_USED`).

## Sources
Hermes: github.com/NousResearch/Hermes-Function-Calling ·
qwen.readthedocs.io/function_call · docs.vllm.ai/features/tool_calling ·
morph-labs qwen3_coder_parser.py · docs.sglang.io/tool_parser ·
llama.cpp/docs/function-calling.md · ml-explore/mlx-lm#1096 ·
github.com/cubist38/mlx-openai-server · omlx.ai ·
cline.ghost.io/cline-v3-35 · RooCodeInc/Roo-Code#4047 ·
Kilo-Org/kilocode#7004 · github.com/irreg/native_tool_call_adapter ·
boundaryml.com/blog/schema-aligned-parsing · llama.cpp#20164 ·
unsloth/Qwen3-Coder-30B GGUF discussion#10
