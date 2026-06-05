# Task Loop

Cœur de l'agent : boucle ReAct streaming, dispatch des tool blocks, état de tâche.

## Files

| Fichier | Rôle |
|---------|------|
| `index.ts` (74 KB) | Classe `Task` (L132), `recursivelyMakeDiracRequests` (L1341), `presentAssistantMessage` (L1337), `initiateTaskLoop` (L796) |
| `ToolExecutor.ts` | Dispatch des blocs partiels, gating auto-approve |
| `LifecycleManager.ts` | `startTask` / `resumeTaskFromHistory` |
| `ContextLoader.ts` | Environment details, file context injection |
| `TaskMessenger.ts` | `ask` / `say` vers UI (webview + CLI) |
| `ResponseProcessor.ts` | Parse stream LLM → blocs typés |
| `ApiConversationManager.ts` | Historique conversation API (≠ `message-state.ts` qui est l'UI) |
| `HookManager.ts`, `EnvironmentManager.ts`, `StreamResponseHandler.ts` | Helpers |

## Subdirs

- `tools/handlers/` — 23 handlers (1 fichier par tool : `ReadFile`, `WriteToFile`, `EditFile`, `ExecuteCommand`, `Subagent`, `AttemptCompletion`, …)
- `tools/` — `ToolExecutorCoordinator.ts` (registre + dispatch), `ToolValidator.ts`, `autoApprove.ts`
- `tools/subagent/` — `SubagentBuilder` / `Runner` / `AgentConfigLoader` (sous-tâches imbriquées)
- `tools/utils/` — `PathResolver`, `CommandSafetyChecker`, `PatchParser`, `ToolResultUtils`, `ToolHookUtils`
- `types/` — interfaces des managers
- `utils/` — helpers user-content (excerpt, symbol-block)

## Pattern

`initiateTaskLoop` → `recursivelyMakeDiracRequests` (stream API) → `presentAssistantMessage` (parse blocs partiels) → `ToolExecutor` → `ToolExecutorCoordinator.execute(block)` → handler → résultat poussé dans `userMessageContent` → récursion (`index.ts:1855`). État dans `TaskState.ts`, lock global via `TaskLockUtils`.

## How to add a tool handler

1. Créer `tools/handlers/FooToolHandler.ts` implémentant `IFullyManagedTool` (= `IToolHandler` + `IPartialBlockHandler`, voir `ToolExecutorCoordinator.ts:34-49`)
2. Enregistrer via `coordinator.registerByName(toolName, validator)` (L117) — mapping basé sur `IsaacDefaultTool`
3. Schema/validation côté `src/core/prompts/system-prompt/spec.ts` (source de vérité)
4. Hooks via `ToolHookUtils`

## Gotchas

- `index.ts:1536` — flags `presentAssistantMessageLocked` / `HasPendingUpdates` : NE JAMAIS appeler `presentAssistantMessage` directement, le streaming le ré-entre
- Lock exclusif `lockedTaskExecution` (L146) sur toute mutation d'état — éviter accès direct à `taskState`
- `ApiConversationManager` ≠ `message-state.ts` : un pour le LLM, l'autre pour l'UI. Ne pas mélanger
- `SharedToolHandler` (`coordinator.ts:52`) : un handler peut être enregistré sous plusieurs noms — pas d'état d'instance
- `tools/subagent/` lance `Task` récursivement — attention boucles infinies / budget
- Tool spec (`@core/prompts/.../spec.ts`) et handler (ici) ne sont PAS liés par les types — un rename de param côté spec ne casse pas le compile
