# Passe de réconciliation — prep (2026-06-05)

Préparation read-only (aucune action mutante). Deux axes : (1) config local-router
(décisions apertus/mascarade), (2) réconciliation des branches. État de départ :
branche `feat/simplify-souverain` après le refactor souverain-strict (~22.5k LOC retirées).

---

## Axe 1 — Branches / merge debt

### Position de `feat/simplify-souverain`
| vs | ahead | behind | note |
|----|---:|---:|----|
| `master` / `origin/master` | 12 | 0 | base propre, **fast-forwardable** |
| `upstream/master` (dirac-run) | 302 | 51 | divergence **volontaire** — hors scope |

Diff vs master : 870 fichiers, +9254 / −31598, 137 suppressions. **Aucun conflit delete/modify** :
aucune branche vivante ne modifie un fichier supprimé par souverain.

### Branches mortes (100% mergées dans master → `git branch -d`)
`chore/upstream-sync-phase1-clean`, `feat/upstream-sync-acp`, `feat/upstream-sync-openai-cost`,
`feat/upstream-sync-openai-providers`, `fix/upstream-sync-cli`, `feat/cli-mcp-flag`,
`fix/mcp-dedupe-servers`, `test/green-ci-ink-tty-shim`.

### Branches redondantes (contenu déjà dans master/souverain → supprimer)
- `docs/tool-call-research` — `fa6db95` déjà ancêtre de souverain.
- `feat/mcp-adaptive-retrieval` — feature déjà mergée (squash PR #50, `d31e7f6`). NE PAS merger (régénère des conflits add/add factices).
- `docs/fix-install-instructions` — `d7fcad5` déjà dans master (PR #51).

### Plan recommandé (à exécuter sur go-ahead)
1. Confirmer que `master` contient bien le contenu mcp-adaptive voulu.
2. **FF `master` → `feat/simplify-souverain`** (12 commits, 0 conflit ; linéaire, pas de merge commit).
3. `git branch -d` les 11 branches mortes/redondantes.
4. Push `origin` (Gitea) + `github` (backup).
- Ne PAS rebaser souverain (déjà 0-behind). Stratégie conflits future = `-X ours`/`git rm` sur chemins supprimés.

---

## Axe 2 — Config local-router (apertus / mascarade)

### Flotte actuelle (`src/services/local-router/defaults.ts:11-39`)
| id | url | modelId | ctxMax | tools | note |
|----|----|---------|---:|---|----|
| tower-gemma | `100.78.6.122:9304` | ailiance-gemma | 32768 | false | emulation |
| studio-apertus | `100.116.92.12:9301` | apertus-70b | **8192** | false | **éliminé en pratique** (≈ system prompt) |
| studio-eurollm | `100.116.92.12:9303` | eurollm-22b | **4096** | true | éliminé sauf fallback largest-ctx |

- `apertus` → `ModelRegistry.ts:70` = `markdown_fence` (non-native), cohérent `supportsTools:false`.
- **Aucun worker tool-capable gros-ctx** dans defaults (Qwen 32B/80B « primary FC » des docs **absent** du client) → la force-route `tools[]` n'a pas de candidat viable côté local-router.

### mascarade — aucune action code
`mascarade` (ex. `mascarade-kicad`) n'existe **que** dans des commentaires/CHANGELOG. Le routage LoRA
est **100% gateway** ; le CLI lit passivement `x-ailiance-domain`/`x-ailiance-upstream-model`
(`ailiance-worker-info.ts:57-84`). Pas de liste de domaines en dur. → déclarer/retirer un domaine
mascarade **n'impacte aucun fichier** de ce repo (sauf l'exemple commentaire).

### Config en dur désynchronisée / périmée
- **IP studio `100.116.92.12` jamais migrée** vers `100.122.254.98` (grep du nouveau = vide).
  Touche : `defaults.ts:23,32`, `webui/WebuiServer.ts:212-213`, `litellm/LiteLLMProxyManager.ts:52`,
  `types.ts:5` (exemple), docs.
- **Deux listes de workers parallèles désynchronisées** : `defaults.ts` (3 workers) vs
  `WebuiServer.ts:211-215` (5 : ajoute gw `:9300`, devstral `100.112.121.126:9302`).
- `LiteLLMProxyManager.ts:49` : modelId `ailiance-apertus-70b` vs `apertus-70b` (defaults) — préfixe divergent.

### Cohérence post-refactor : OK
`useLocalRouter` câblé sur `openai`/`litellm`/`openrouter` (tous gardés). Pas de model-id orphelin.
**Note `dirac`** : c'est un **provider de config** (membre de l'union `ApiProvider`, réutilise l'infra
OpenRouter via `usesOpenRouterModels`/`provider-config.ts`) — pas de fichier `dirac.ts` dédié, donc
l'absence relevée par l'audit local-router est normale (pas un orphelin).

### DÉCISIONS À TRANCHER
| # | Décision | Défaut suggéré | Impact |
|---|----------|----------------|--------|
| D1 | Garder `apertus` dans DEFAULT_WORKERS ? | **Retirer/désactiver** (mort de fait à ctx 8192) | defaults.ts:21-29 + registry:70 + probe webui:212 |
| D2 | Si gardé : ctxMax réel ? | Mesurer live ; ≥16k pour le rendre routable | routabilité `reason` |
| D3 | Si gardé : model-id/préfixe | `apertus-70b` (sans `ailiance-`) + fix commentaire litellm | cohérence headers |
| D4 | IP studio `100.116.92.12` → `100.122.254.98` | **Migrer** (confirmer ports 9301/9303 identiques) | defaults + webui + litellm + types + docs |
| D5 | Source unique workers (defaults vs webui) | Faire dériver les probes webui de DEFAULT_WORKERS | élimine la dérive devstral/gw |
| D6 | Ajouter worker tool-capable gros-ctx (Qwen) ? | **Ajouter** (supportsTools, ctx ~196k) sinon force-route tools[] sans candidat | nouvelle entrée defaults + registry |
| D7 | Domaines mascarade | **Rien côté repo** (agnostique) ; MAJ commentaire si noms LoRA changent | exemple `ailiance-worker-info.ts:20` |
| D8 | Provider `dirac` à brancher sur local-router ? | **Statu quo** (dirac = alias openrouter ; useLocalRouter déjà OK) | aucun |

---

## Récap : ce que la passe de réconciliation devra faire (sur go-ahead)
- **Branches** : FF master→souverain + supprimer 11 branches + push origin/github. (mécanique, 0 conflit)
- **Local-router** : trancher D1-D6 (apertus + IP studio + source unique + Qwen) ; D7/D8 = no-op code.
- Hors scope ici mais lié : P0 sécurité (`AUDIT-DETTE.md`), Lot E lourd (`REFACTOR-SIMPLIFY-PLAN.md`).
