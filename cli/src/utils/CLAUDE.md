# CLI Utils

Helpers purs/non-React du CLI `isaac` (rendu terminal, parsing input, fs, lifecycle). Hooks Ink → `cli/src/hooks/`.

## Files

### Rendu terminal & lifecycle
| Fichier | Rôle |
|---------|------|
| `console.ts` | Capture `originalConsole*` AVANT import du core ; `suppressConsoleUnlessVerbose` + `restoreConsole`. Source des prints "qui survivent au mute" |
| `display.ts` | ANSI `colors`/`style`, `formatMessage`/`formatState` (IsaacMessage→terminal), `Spinner` (l.375), `print*` (via originalConsole), `createContextBar` (l.498), `setTerminalTitle` (OSC, l.511) |
| `ink.ts` | `runInkApp` (l.30) : drain des réponses sonde terminal (`drainEscapeSequencesOnly`, l.6), clear screen, render Ink puis cleanup |
| `cleanup.ts` | `disposeCliContext`/`createInkCleanup` (l.52, flush state + dispose services + exit code), `drainStdout` (l.68, critique pour pipes) |
| `errors.ts` | `setupSignalHandlers` (l.49) : SIGINT/SIGTERM, `unhandledRejection` (ignore les "abort"), `uncaughtException` |
| `state.ts` | Singletons mutables process-wide : `activeContext`, `isShuttingDown`, `isPlainTextMode`, `telemetryDisposed` (+ setters) |

### Parsing input & menus
| Fichier | Rôle |
|---------|------|
| `input.ts` | Filtres clavier : `isMouseEscapeSequence` (SGR `[<…M`), `isTerminalResponseSequence` (jette les CSI/kitty inconnus, garde les vraies touches) |
| `parser.ts` | `parseImagesFromInput` (`@path`/standalone, vérifie existence disque), `processImagePaths`→data URLs, `parseHeaders`, `jsonParseSafe` |
| `file-search.ts` | `searchWorkspaceFiles` (ripgrep→fallback fs, fzf), `extractMentionQuery`/`insertMention` (mentions `@`) |
| `slash-commands.ts` | `extractSlashQuery` (1ʳᵉ slash/msg seulement), `filterCommands`, `getVisibleWindow` (scroll centré), `insertSlashCommand` |
| `fuzzy-search.ts` | `fuzzyFilter<T>(items, query, selector)` — wrapper fzf générique |

### Domaine (providers, options, modèles)
| Fichier | Rôle |
|---------|------|
| `providers.ts` | `getValidCliProviders`/`isValidCliProvider` (exclut `vscode-lm`), `getProviderLabel` depuis `providers.json` |
| `openrouter-models.ts` | `fetchOpenRouterModels` (cache mémoire + promesse partagée), `usesOpenRouterModels` (= openrouter ou `dirac`) |
| `tools.ts` | `FILE_EDIT_TOOLS`/`FILE_SAVE_TOOLS` Sets, `isFileEditTool`, `normalizeToolName` (snake_case ↔ camelCase) |
| `options.ts` | `setModeScopedState` (act/plan), `normalizeReasoningEffort` — normalisation des flags CLI |

### Piping / non-TTY
| Fichier | Rôle |
|---------|------|
| `piped.ts` | `readStdinIfPiped` : null si TTY, attend EOF (timeout 5 min), `""` = pipe vide vs `null` = pas de pipe |
| `plain-text-task.ts` | Runner sans Ink (CI/redirection) : stdout = résultat final nu, stderr = erreurs/verbose |

## Gotchas

- **`display.print*` ≠ console.log** : ils passent par `originalConsole*` de `console.ts` pour survivre à `suppressConsoleUnlessVerbose`. N'utilise pas `console.log` direct.
- **`isTerminalResponseSequence` est agressif** : jette TOUT escape inconnu. Si tu ajoutes une touche custom, ajoute-la au garde sinon elle est filtrée.
- **`parseImagesFromInput` touche le disque** : `fileExists` sur chaque match avant de retirer du prompt → un `@chemin.png` inexistant reste dans le texte.
- **`piped.ts` : `""` vs `null`** — distinction load-bearing. Pipe vide renvoie `""` (pas `null`) pour différencier de "pas de pipe".
- **`isPlainTextMode` (state.ts)** : lu par `errors.ts` pour NE PAS émettre les ANSI de clear-lines (corromprait le flux pipé). Set par le runTask quand stdin pipé.
- **`drainStdout` avant exit** : sans ça les pipes chaînés (`isaac … | isaac …`) perdent la fin du buffer.
- **`tools.ts` double convention** : les Sets contiennent snake_case ET camelCase (`edit_file` + `editedExistingFile`) — toujours passer par `isFileEditTool`/`normalizeToolName`.
- **`openrouter-models` cache process-wide** : `cachedModels`/`fetchPromise` en module scope, jamais invalidés ; déduplique les fetch concurrents.
