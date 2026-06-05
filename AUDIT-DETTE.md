# ISAAC-CLI — Audit de dette & plan de simplification (hand-off mclaude2)

> Produit le 2026-06-05 par 4 agents d'audit (architecture, dette TS, sécurité, tests/CI)
> sur `isaac` v0.9.1-beta, fork Dirac/Cline. Branche `docs/tool-call-research`.
> 234k LOC TS/TSX. Base saine : **tsc 0 erreur, biome 0 erreur**.

## Périmètre de simplification (décisions actées par le user)

- **Garder** : CLI `isaac` **+** extension VS Code (les deux fronts).
- **Providers : SOUVERAIN STRICT** → ne garder que l'OpenAI-compatible (gateway ailiance)
  + un fallback local (Ollama/llama). **Supprimer** les ~17 autres providers (anthropic,
  bedrock, vertex, gemini, mistral, groq, cerebras, xai, openrouter, requesty, vercel,
  huggingface, deepseek, qwen direct, etc.).
- **Enlever** toute brique Cline/Dirac morte ou hors chemin ISAAC.

---

## SYNTHÈSE PRIORISÉE

### 🔴 P0 — À corriger AVANT toute release (sécurité)

1. **RCE via `execute_command` script mode** — `src/core/task/tools/handlers/ExecuteCommandToolHandler.ts:707-727`.
   `wrapScript(script, language)` : si `language` n'est pas whitelisté, fallback `interpreter = normalizedLanguage` (valeur LLM brute) → injection heredoc, contournée par `classifyCommand` (1er token only). **Fix 5 lignes** : whitelist stricte `{bash,sh,python,python3,node,javascript,ruby,perl}`, pas de fallback.
2. **XSS webview via `dangerouslySetInnerHTML` non-sanitisé** — `webview-ui/.../HistoryView.tsx:503` + 6 model pickers (`DiracModelPicker.tsx:322`, OpenRouter/Groq/HuggingFace/Requesty/Vercel) + `ModelAutocomplete.tsx:232`. Model IDs venant d'API providers injectés sans échappement. **Fix** : échapper `inputText` dans `generateHighlightedText`. NB : la plupart de ces pickers **disparaissent** avec le souverain strict (quick win combiné).
3. **`npm audit` : 1 CRITICAL + 8 HIGH** — `vitest <4.1.0` (RCE UI), `simple-git 3.33→3.36` (RCE via remote URL, utilisé dans worktree/GenerateExplanation avec refs LLM), `vite 7.3.1`, `ws`, `fast-xml-parser`, `tmp`, `serialize-javascript`. **`npm audit fix`** (majorité sans breaking).

### 🟠 P1 — Dette structurelle majeure

4. **Plugin hooks `spawn(cmd, [], {shell:true})` sans validation** — `src/core/hooks/hook-factory.ts:757`, `HookProcess.ts:73`. Plugins chargés depuis `~/.claude/plugins/cache/` (user-writeable, pas de signature). Vecteur supply-chain silencieux.
5. **Secrets en clair sur disque / traces** — `api_conversation_history.json` (0600, non scrubbé, rétention 30j) + traces JSONL `.ailiance-agent/runs/` (scrubbing incomplet : tokens gateway ailiance non couverts). Ajouter `.ailiance-agent/` au `.gitignore` par défaut + étendre `scrubSecrets`.
6. **Merge debt upstream** — 290 commits ahead / 51 behind, 408 fichiers divergents, **5 branches `upstream-sync-*` abandonnées**. `src/shared/api.ts` (2410 L, god-file de tous les providers) = aimant à conflits. La simplification souverain-strict **réduit mécaniquement** ce fichier.
7. **Routing ailiance sans provider dédié** — pique sur `OpenAiHandler` via flag `useLocalRouter`. Créer `AilianceHandler extends OpenAiHandler` (provider de 1ʳᵉ classe) → isole le seam fork, donne une surface de test.
8. **Dead code (knip) : 23 fichiers + 21 deps + 17 devDeps** inutilisés. Notables : stack WebUI entière (`src/services/webui/WebuiServer.ts`, `GrpcRouter.ts`, `landing-html.ts`), `o1-format.ts`, `PatchParser.ts`, `@opentelemetry/*` (8 pkgs), `sharp`, `sql.js`, `posthog-node`. ⚠️ knip ignore le workspace `cli/` → vérifier usage cli avant suppression.
9. **`MultiRootCheckpointManager` = stub en prod** — `src/integrations/checkpoints/MultiRootCheckpointManager.ts` marqué `NOT YET IN USE` mais instancié via `factory.ts:80` → perte silencieuse de checkpoints en multi-root. Bloquer le chemin ou implémenter.
10. **Empty catch sur `JSON.parse` dans le hot-path edit-file** — `edit-file/BatchProcessor.ts:60,73,390`, `EditFileToolHandler.ts:58,65,142,161` → patches appliquées sur données partielles sans signal. + 15 `JSON.parse` sans guard (storage `disk.ts`, `ContextManager.ts`, `CommandPermissionController.ts`).

### 🟡 P2 — Qualité / cohérence

11. **Triple identité disque** — `~/.dirac/` (storage), `~/.isaac/` (MCP cache), `.ailiance-agent/` (tracing), commandes VS Code `dirac.*`. Définir un nom canonique + facade de migration.
12. **IPs Tailscale en dur** — `src/services/local-router/defaults.ts:14-38` (Studio `100.116.92.12` **périmée** → `100.122.254.98`). Externaliser en config/env.
13. **Rebrand incomplet** — `AGENTS.md` encore « Dirac Agent Guide » (réf `npm run build` inexistant), `pack-cli.yml` produit des artefacts `dirac-*`, naming legacy `eu-kiki`/`AGENT_KIKI`. 
14. **Gros fichiers** — `shared/api.ts` 2410 L, `TelemetryService.ts` 2267 L, `hook-factory.ts` 1196 L, `checkpoints/index.ts` 929 L.
15. **559 `any`**, 27 `@ts-ignore`, 34 `biome-ignore` (dont `TelemetryService.identifyAccount(userInfo: any)` public).
16. **13 imports `vscode` directs dans `core/`** (cassent le boundary host-agnostic ; 6 non légitimes).

### 🟢 P3 — Hygiène

17. Résidus racine : `file1.ts`, `file2.ts`, `test.ts` (gitignorés mais le test `RenameSymbolToolHandler` fuit hors tmpdir — corriger le test).
18. 2 `CLAUDE.md` non trackés (`src/core/controller/`, `src/services/local-router/`) — à committer.
19. **CI ne gate aucun test** (job `test` en `continue-on-error`), `src/core/tracing/` (argument EU AI Act) **0 test**, pas de couverture mesurée. Score hygiène **5.5/10**.
20. Husky inerte, `ci:check-all` = static only, script `test:e2e:cli:tui` pointe vers un dossier inexistant.

---

## PLAN DE SIMPLIFICATION RECOMMANDÉ (pour mclaude2)

Branche dédiée `feat/simplify-souverain`. **Build + typecheck + test vitest après CHAQUE lot.** Commits atomiques.

**Lot 0 — Quick wins / hygiène** (XS, dérisque la suite)
- Supprimer `file1.ts`/`file2.ts`/`test.ts` + corriger le test qui les crée.
- Committer les 2 `CLAUDE.md`.
- `npm audit fix` (P0 #3).
- Whitelist `language` dans `wrapScript` (P0 #1).

**Lot 1 — Purge providers (souverain strict)** ← le cœur de la demande
- Identifier les providers à retirer dans `src/core/api/providers/*` + `src/shared/api.ts` (`ApiProvider` union, `ApiConfiguration`, registries modèles) + `src/shared/providers/*.json` + les model pickers webview correspondants (ferme aussi le XSS P0 #2 sur ces pickers).
- Garder : `openai` (OpenAI-compat/gateway), le fallback local (ollama/lmstudio), `vscode-lm` (légitime extension). Créer `AilianceHandler` (P1 #7) si le temps.
- ⚠️ vérifier chaque suppression contre `buildApiHandler` (factory switch) + tests.

**Lot 2 — Dead code** (P1 #8)
- Supprimer la stack WebUI (`services/webui/*`), les transforms/utils morts confirmés par knip, en **re-vérifiant l'usage depuis `cli/`** (knip l'ignore).
- Retirer les deps/devDeps inutilisées (OTEL, sharp, sql.js, posthog-node…) — **respecter la politique SBOM/HITL du CLAUDE.md root** (revue diff par dep).

**Lot 3 — Stubs & error handling** (P1 #9, #10)
- `MultiRootCheckpointManager` : bloquer le chemin ou implémenter.
- Empty catch JSON.parse → log/propagation.

**Lot 4 — Cohérence rebrand** (P2 #11, #13)
- Naming `dirac`/`eu-kiki`/`AGENT_KIKI` → `isaac`/`ailiance` (+ facade migration paths disque), `AGENTS.md`, `pack-cli.yml` artefacts.
- IPs Tailscale → config (P2 #12).

**Lot 5 — Filet de sécurité** (P3 #19)
- Rendre la suite vitest (MCP+cli) bloquante en CI (fixer `bootstrap.test.ts:173` timeout d'abord).
- Tests `src/core/tracing/` (scrubber + format JSONL).

**Estimation dette totale auditée : ~11-12 j-homme** (hors purge providers, qui est surtout du retrait guidé par knip + le factory switch).

## Garde-fous
- `node`/`npm` ne sont PAS dans le PATH SSH non-login de `claude2` → la session interactive doit charger le bon PATH (nvm/homebrew) avant `npm install`.
- `npm install` d'abord (node_modules non transférés — regénérables).
- Remotes : `origin` = Gitea `ailiance/isaac-cli`, `github` = backup. Pousser sur Gitea.
