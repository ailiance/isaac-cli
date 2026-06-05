# CLI Agent

`IsaacAgent` = implémentation `acp.Agent` découplée de stdio : enveloppe un `Controller`
core par session et traduit ses `IsaacMessage` en `acp.SessionUpdate` via EventEmitter.

## Files

| Fichier | Rôle |
|---------|------|
| `IsaacAgent.ts` | Classe `IsaacAgent` (L88) implémente `acp.Agent`. `newSession` L273 (1 `Controller`/session), `loadSession` L324 (rehydrate depuis history, lazy), `prompt` L737 (entrée principale), `cancel` L1203, `setSessionMode` L1238, `unstable_setSessionConfigOption` L599 (mode/provider/model/reasoning/thinking). Émission : `emitSessionUpdate` L1285, `sendAvailableCommands` L1306, `publishSessionSetupUpdates` L374 |
| `messageTranslator.ts` | `translateMessage` L176 (IsaacMessage → updates). `translateSayMessage` L209, `translateAskMessage` L450, `translateToolMessage` L673, `translateCommandMessage` L818, `translateCommandOutputMessage` L862. `parseWebSearchMarkerText` L73, `TOOL_KIND_MAP` L19, `parseUnifiedDiff` L104 |
| `permissionHandler.ts` | `handlePermissionResponse` L110 (outcome ACP → `IsaacAskResponse`). `requiresPermission` L79, `ASK_TYPE_PERMISSION_MAP` L39, `AutoApprovalTracker` L178 (non câblé dans IsaacAgent) |
| `IsaacSessionEmitter.ts` | `IsaacSessionEmitter` L34 — wrapper typé sur `EventEmitter` (maxListeners 20), clés = `SessionUpdateType` + `error` |
| `review.ts` | `handleAcpReviewCommand` L157 (`/review`, `/review-branch`, `/review-commit`), `runReviewModelOnDiff` L277 (LLM read-only → JSON findings) |
| `public-types.ts` | Types lib-safe : `IsaacAgentOptions`, `PermissionHandler` L45, `IsaacSessionEvents` L58, `AcpSessionState`, `AcpSessionStatus` L131 |
| `types.ts` | Re-export interne (public-types + types ACP du SDK). Lib consumers passent par `exports.ts`, pas ici |

## Pattern

- `newSession` crée un `Controller(ctx.extensionContext)` stocké dans une **WeakMap**
  `#sessionControllers` (L107) — jamais exposé au consumer. Map publique `sessions` = métadonnées seules.
- `prompt` (L737) : extrait text/image/resource des blocks ACP → intercepte `/review*` (review.ts)
  → décide new task / continue / resume loaded (`hasActiveTask` ignore les tasks `abort:true`, L819)
  → `controller.initTask` ou `task.handleWebviewAskResponse`. Puis s'abonne à
  `task.messageStateHandler.on("diracMessagesChanged")` et **retourne une promesse** résolue
  par `checkMessageForPromptResolution` (L1041) sur message non-partial (`completion_result`,
  `followup`, `plan_mode_respond`, `resume_*`).
- Chaque `IsaacMessageChange` → `processMessageWithDelta` (L1090) : texte/reasoning streamés en
  **delta** (slice vs `partialMessageLastContent`) ; le reste passe par `translateMessage`.
  `messageToToolCallId` (L125) réutilise le toolCallId entre updates partiels d'un même tool.
- Permissions : un `ask` `command`/`tool`/`browser_action_launch` met `requiresPermission` →
  `handlePermissionRequest` (L955) appelle le `permissionHandler` callback, mappe la réponse via
  `handlePermissionResponse`, émet `tool_call_update` puis répond au core par
  `task.handleWebviewAskResponse(yes/noButtonClicked)`.
- Émission : `emitterForSession(sessionId)` → `IsaacSessionEmitter`. `AcpAgent` (cli/src/acp/)
  s'abonne et forwarde vers `connection.sessionUpdate()` ; usage programmatique consomme l'emitter direct.

## Gotchas

- **1 Controller par session**, pas via `CliWebviewProvider`. Ce dernier sert le mode TUI ;
  `IsaacAgent` instancie le `Controller` core directement (chemin ACP/lib, pas le chemin Ink).
- **Aborted task = task morte** : sans le filtre `abort !== true` (L819), tout prompt suivant
  ré-essaierait de continuer la task abandonnée ("Dirac instance aborted").
- **act_mode_respond** exclu du delta streaming (L1100) et no-op dans `translateAskMessage` (L491) :
  son texte est déjà sorti via `say:"text"`, le ré-émettre duplique.
- **plan_mode_respond / followup** : `message.text` est du JSON (`{response|question, options}`),
  pas du texte brut — parser avant delta (L1114), sinon le JSON fuit à l'écran.
- **`setPermissionHandler` obligatoire** avant un prompt déclenchant un tool/command :
  `requestPermission` (L152) throw "Permission handler not set" sinon.
- **`AutoApprovalTracker`** (permissionHandler.ts L178) existe mais n'est PAS branché par
  IsaacAgent — l'auto-approval réel vient des options `allow_always` côté client + state core.
- **Terminal capability** : `command`/`command_output` émettent du `type:"terminal"` seulement si
  `clientCapabilities._meta.terminal_output === true` (L940), sinon fallback texte `$ cmd`.
- **`publishSessionSetupUpdates`** (available_commands + config) doit être appelé APRÈS que le
  wrapper stdio se soit abonné, sinon les updates initiaux sont perdus.
