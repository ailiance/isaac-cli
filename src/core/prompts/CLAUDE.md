# Prompts

Système prompt + tool specs (function calling natif, pas XML).

## Files

| Fichier | Rôle |
|---------|------|
| `system-prompt/template.ts` | `SYSTEM_PROMPT(context)` — "You are Dirac…" + PRIME DIRECTIVES / TOOL USE / ACT/PLAN / SYSTEM INFO / OBJECTIVE / FEEDBACK / USER CUSTOM INSTRUCTIONS |
| `system-prompt/registry/PromptBuilder.ts` | Assemble template + placeholders + post-process (collapse blanks, `====` separators) |
| `system-prompt/registry/PromptRegistry.ts` | Singleton, register tools via `tools/init.ts`, expose `nativeTools` |
| `system-prompt/registry/IsaacToolSet.ts` | Registry tools ; converter OpenAI unique (souverain strict) |
| `system-prompt/spec.ts` | `IsaacToolSpec` + converter OpenAI (`toolSpecFunctionDefinition`) |
| `system-prompt/tools/*.ts` | 23 tools (1 fichier chacun) : description + `parameters[]` (name/required/type/instruction/usage) |
| `system-prompt/templates/{TemplateEngine,placeholders}.ts` | `{{VAR}}` engine + enum `SystemPromptSection` |
| `commands.ts`, `responses.ts`, `tool-examples.ts`, `contextManagement.ts` | Slash-cmd defs, formatted user responses, exemples partagés |
| `system-prompt/README.md` | Doc détaillée — lire avant gros refactor |

## Convention

- **Function calling natif**, pas de XML tags (héritage Cline supprimé)
- Headings ALL-CAPS sans `#` (`PRIME DIRECTIVES`, `TOOL USE`, `OBJECTIVE`)
- `====` séparateurs de section (postProcess les nettoie)
- Tool descriptions : EN, exemples inline dans `description`

## Placeholders runtime

Injectés par `PromptBuilder` : `{{OS}}`, `{{SHELL}}`, `{{SHELL_TYPE}}`, `{{HOME_DIR}}`, `{{CURRENT_DATE}}`, `{{AVAILABLE_CORES}}`, `{{SKILLS_SECTION}}`. **CWD interpolé directement** dans le template literal (pas placeholder).

Conditionnels inline : `yoloModeToggled`, `enableParallelToolCalling`, `activeShellIsPosix`, `git-bash`, `wsl`, `win32`.

## Modèles spécifiques

Pas de prompt par modèle. Tous les providers gardés (souverain strict) utilisent le converter OpenAI ; `vscode-lm` a son propre format.

Subagents dynamiques injectés à runtime via `AgentConfigLoader` quand `subagentsEnabled` — chaque subagent apparaît comme un tool partageant l'id `USE_SUBAGENTS`.

## Gotchas

- **Token bloat** : `description` de chaque tool grossit (read_file en a déjà ~5 exemples), envoyée à *chaque* requête. Pas de cache prompt côté template
- **Drift schema/handler** : `IsaacToolSpec.parameters` = source de vérité, mais handlers vivent dans `../task/tools/handlers/`. Aucun lien typé → rename param côté spec ne casse pas le compile handler
- **postProcess regex fragile** : 8 regex consécutives sur `====` et `##`. Diff blocks SEARCH/REPLACE protégés par lookahead approximatif (`isDiffLike`). Risque de faux positif si futur tool utilise `====` dans description
- **Singleton PromptRegistry** : `registerDiracToolSets()` appelé 1× ; tests doivent appeler `PromptRegistry.dispose()`
- **CWD non placeholder** : un changement de cwd entre requêtes nécessite reconstruction (pas un simple replace)
- **`enableParallelToolCalling`** modifie le texte en 2 endroits (TOOL USE et OBJECTIVE step 2) — facile d'oublier l'un en édition
