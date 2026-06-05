# API Layer

Abstraction provider LLM. Contrat `ApiHandler`, factory `buildApiHandler`, transforms.

## Files

| Fichier | Rôle |
|---------|------|
| `index.ts` | Contrat `ApiHandler` (L49-54), factory `buildApiHandler` (L446) → `createHandlerForProvider` (L72), giant switch sur `apiProvider` |
| `retry.ts` | Décorateur `@withRetry()`, `RetriableError`. Defaults : 3 retries, 1s base, 10s cap |
| `transform/` | Conversion `IsaacStorageMessage[]` ↔ shapes provider, et events stream → `ApiStreamChunk` |
| `transform/stream.ts` | `ApiStream = AsyncGenerator<ApiStreamChunk>`, union `text | reasoning | usage | tool_calls` |
| `transform/tool-call-processor.ts` | Aggregation des deltas tool-call |
| `utils/messages_api_support.ts`, `responses_api_support.ts` | Détection de support API par modèle |

## Contract

```ts
interface ApiHandler {
  createMessage(systemPrompt, messages, tools?, useResponseApi?): ApiStream
  getModel(): { id, info }
  getApiStreamUsage?(): Promise<ApiStreamUsage>
  abort?(): void
}
```

Tout handler DOIT yield un chunk `usage` final avec `cacheWriteTokens`, `cacheReadTokens`, `reasoningTokens`, `totalCost`, `stopReason` (`stream.ts:20-37`).

## Plan/Act split

Chaque option existe en `planMode*` / `actMode*`. Le switch (`index.ts:77`) sélectionne via `mode === "plan" ? planMode... : actMode...`. **Oublier un `planMode*` field = run silencieux en act mode.**

## Thinking budget

`buildApiHandler` réinstancie le handler une 2e fois si `thinkingBudgetTokens > model.maxTokens` (`index.ts:453-468`). Constructeurs DOIVENT être pas chers et sans side-effects — différer la création du client à `ensureClient()`.

## Transforms

Converters par format : `anthropic-format.ts`, `openai-format.ts`, `gemini-format.ts`, `mistral-format.ts`, `o1-format.ts`, `r1-format.ts`, `openai-response-format.ts`, `vscode-lm-format.ts`, `openrouter-stream.ts`, `vercel-ai-gateway-stream.ts`. **Pas de barrel** dans `transform/` — rename = N edits.

## Reasoning chunks

`ApiStreamThinkingChunk` (`stream.ts:77-103`) porte : `signature` (Gemini), `details` (OpenRouter), `redacted_data` (Anthropic redacted blocks).

## Gotchas

- Default fallback du switch = **Anthropic** (`index.ts:434`) — un `apiProvider` inconnu route silencieusement vers Anthropic et exige une `apiKey`
- `aihubmix` utilise `(options as any)` (L409-411) — `ApiConfiguration` (`@shared/api`) lui manque des champs
- `nousResearch` (camelCase, L422) ≠ filename `nousresearch.ts` — case-sensitive risk
- `@withRetry()` ne retry que 429 / `RetriableError` sauf `retryAllErrors: true`. Headers lus : `retry-after`, `x-ratelimit-reset`, `ratelimit-reset` — providers à header non-standard cassent
- Décorateur exige `this.options.onRetryAttempt` — handler DOIT stocker options sur `this.options`
- `ApiConfiguration` (`@shared/api`) explose à chaque ajout : 2 champs (plan + act) × 40 providers
