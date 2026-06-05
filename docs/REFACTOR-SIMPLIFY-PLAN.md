# Refactor simplificateur ISAAC — plan (deep audit 2026-06-05)

Synthèse de 3 audits read-only (héritage/dead-code, purge providers souverain-strict,
simplification agentique/tools). Complète et **corrige** `AUDIT-DETTE.md`.
Objectif : garder **CLI `isaac` + extension VS Code**, providers **souverain strict**,
retirer l'héritage Dirac/Cline inutile. Aucune exécution destructive sans go-ahead.

## ⚠️ Corrections à AUDIT-DETTE.md (vérifiées dans le code)

| Item audit | Réalité | Conséquence |
|---|---|---|
| #8 « stack WebUI morte » | **FAUX** — démarrée par le CLI (`cli/src/components/ChatHeader.tsx:24`, `cli/src/utils/cleanup.ts:19`, imports dynamiques). knip aveugle (exclut `cli/`). | **NE PAS supprimer** `services/webui`. |
| #1 « ~17 providers » | **~37 providers** (union `ApiProvider` = 38, 37 imports `bootstrap.ts`). | Purge plus large, mécanique. |
| #8 OTEL/sql.js/sharp/posthog morts | OTEL **gated runtime** (`TelemetryProviderFactory.ts:75-115`, env) — pas mort. sharp/sql.js/posthog OK à retirer. | NE PAS retirer `@opentelemetry/*` à l'aveugle. |
| #8 deps mortes (tailwind, codicons, reconnecting-eventsource…) | knip exclut `cli/` + `webview-ui/` → **faux positifs probables**. | Vérifier usage cli+webview AVANT delete. |
| services/litellm, services/jina-router | **vivants** (`cli/src/commands/proxy.ts`, `router.ts`). | keep (ou retirer avec décision proxy CLI). |

## Lot A — Dead code / héritage (XS, risque ~nul)

Supprimer (+ tests associés) : enum morts `oca`/`dirac` (`shared/api.ts:36,51`),
`transform/o1-format.ts`, `api/adapters/index.ts`, `tools/utils/PatchParser.ts`,
`utils/{envExpansion,tabFiltering,time}.ts`, `integrations/editor/detect-omission.ts`,
`api/utils/{messages,responses}_api_support.ts` (avec purge providers).
À vérifier→delete : `PluginInstaller.ts`, `PluginDiscoveryService.ts`,
`telemetry/events/EventHandlerBase.ts`, `controller/grpc-service.ts`.

## Lot B — Host standalone Dirac (M, risque moyen)

Supprimer le cluster `src/standalone/` + `src/hosts/external/` + `src/generated/hosts/standalone/`
+ scripts `compile-standalone`/`pretest`. **⚠️ extraire `AuthHandler` d'abord** (utilisé par le CLI,
`cli/src/init.ts:67`). Le CLI a son propre host (`CliWebviewProvider`), n'utilise pas `dirac-core.ts`.

## Lot C — Purge providers souverain-strict (L, gros gain) — cœur

**KEEP (3-4)** : `openai` (gateway ailiance + fallback local via `useLocalRouter`), `lmstudio`,
`vscode-lm`. **Décisions à valider** : (a) `dirac` = garder comme alias gateway (traîne `openrouter`)
OU refondre en `AilianceHandler extends OpenAiHandler` + supprimer `openrouter` ; (b) fallback local
= `lmstudio` seul ou ajouter `ollama` (absent du fork) ; (c) sort de la stack proxy CLI `litellm`.

**REMOVE (~34)** : anthropic, claude-code, openrouter*, bedrock, vertex, gemini, openai-native,
openai-codex, requesty, together, deepseek, qwen, qwen-code, doubao, mistral, github-copilot, litellm*,
moonshot, nebius, fireworks, xai, sambanova, cerebras, groq, huggingface, huawei-cloud-maas, dify,
baseten, vercel-ai-gateway, zai, aihubmix, minimax, nousresearch, wandb.

Par provider : `providers/<id>.ts` + `<id>-registry.ts` + ligne `bootstrap.ts` + case `index.ts` +
membre union/ALL_PROVIDERS (`shared/api.ts:17-55`) + JSON (`shared/providers/*.json`) + picker webview
+ tests. Transforms à retirer si non partagés : anthropic/gemini/mistral/r1/openrouter/bedrock/vercel-format.

**Ordre sûr (build+typecheck+vitest entre chaque)** :
1. Décider dirac/openrouter/litellm.
2. `bootstrap.ts` → 3 KEEP ; `index.ts` switch vidé + **fallback défaut Anthropic→openai** (`index.ts:262`, sinon crash).
3. `providers.json` → 3 entrées (propage CLI **et** webview) ; `DEFAULT_API_PROVIDER` (`api.ts:100`) → openai.
4. Webview : `ApiOptions.tsx`, `providerUtils.ts` (4 switches), supprimer `providers/*.tsx` + pickers ; **patch XSS** `ModelAutocomplete.tsx:232` + `DiracModelPicker.tsx:322` (survivants).
5. `rm` providers/registries/transforms/tests.
6. **En dernier** : élaguer `shared/api.ts` (union, ALL_MODEL_MAPS, champs `ApiConfiguration`, registries modèles) + `state-keys.ts`.

**Gain estimé : ~9 000–10 000 LOC**, `api.ts` 2410 → ~700-900 L (désamorce l'aimant à conflits merge #6).
Ferme aussi le XSS P0 #2 (6 pickers supprimés) — reste à patcher les 2 survivants.

## Lot D — Rebrand interne (M)

`dirac`/`eu-kiki`/`AGENT_KIKI`/`Cline` dans le code actif → `isaac`/`ailiance`. **Garder** l'alias env
`AGENT_KIKI_GATEWAY` (contrat externe) + facade migration `~/.dirac`→canonique (audit #11). Commandes
VS Code `dirac.*` = contrat utilisateur → migration, pas rename brut.

## Lot E — Simplification agentique / tools (quick wins puis refonte)

**Quick wins (gain élevé, risque faible)** :
- Supprimer la branche XML « hallucinated tool » (`ResponseProcessor.ts:220-300`) ; `useNativeToolCalls`
  devient constante `true` (gateway force-route FC). −150 L hot-path, 3 formats → 1.
- Réduire `getNativeConverter` (`registry/DiracToolSet.ts:87-104`) au seul OpenAI + supprimer 4 converters
  Anthropic/Gemini/etc. dans `spec.ts:196-492` → ~60 % de `spec.ts`.
- Simplifier `parseAssistantMessageV2` (`parse-assistant-message.ts`) → split reasoning trivial (−80 L).
- Externaliser le tracing du hot-path en listener sur `diracMessagesChanged`.
- Évaluer suppression handlers niche : `browser_action`, `generate_explanation` (CVE simple-git), `report_bug` ;
  fusionner `condense`/`summarize_task`/`new_task`. Cible 26 → ~14-16 handlers, 24 → ~14 specs.

**Refontes lourdes (planifier)** :
- **Drift spec/handler** : `prompts/system-prompt/tools/*` (spec prompt) et `tools/handlers/*` (exécution)
  ne sont liés que par l'enum string `DiracDefaultTool` → un rename de param ne casse pas le compile.
  Cible = **1 tool = 1 unité typée** (spec+handler co-localisés, schéma natif dérivé). Réduit « ajouter un tool »
  de 4 étapes à 1, tue la map dupliquée `ToolExecutorCoordinator:81-113`.
- Aplatir la double boucle `initiateLoop` (while) + `AgentLoopRunner.makeRequest` (récursif L588) en une seule.
- Dégonfler `ToolExecutor` (767 L, 31 params constructeur) via injection `Task`/`TaskConfig`.

**Gros fichiers** : `shared/api.ts` 2410 (fond avec Lot C), `TelemetryService.ts` 2267 (split par domaine +
events PostHog/OTEL retirables), `hook-factory.ts` 1196 (1 fichier/type + durcir `spawn shell:true`, P1 #4),
`checkpoints/index.ts` 929 (bloquer le stub `MultiRootCheckpointManager` P1 #9 d'abord).

## Références publiques (légales) pour la refonte tools/agent

- **openai/codex** (Apache-2.0) : action-space fermé, tool = unité unique (def+schéma+exécution au même
  endroit), schéma natif *dérivé* de la déclaration, une seule boucle. → modèle pour fusionner spec+handler (Lot E).
- **openai/openai-agents-python** : `@function_tool` génère le schéma depuis la signature typée + docstring ;
  `Sessions` pour l'historique ; `Runner` boucle unique ; handoffs/guardrails. → pattern « schéma dérivé du type ».
- **anthropics/claude-code** : subagents, hooks, permission modes, MCP, compaction de contexte. isaac en
  reflète déjà beaucoup (hooks, subagents, MCP) — utile comme grille de comparaison, pas de copie.

> Aucun code propriétaire fuité n'est utilisé. Inspiration architecturale uniquement, depuis ces dépôts publics.

## Séquence recommandée

Lot A (dérisque) → Lot E quick-wins (XML/converters/parse) → **Lot C purge providers** (déclenche la fonte
de `api.ts`) → Lot B standalone → Lot D rebrand → Lot E refontes lourdes. Build + typecheck + `vitest`
(cli+mcp) après **chaque** sous-lot. Commits atomiques sur branche `feat/simplify-souverain`.
