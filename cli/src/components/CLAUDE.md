# Components (TUI)

Vues et widgets Ink/React du binaire `isaac`. `App.tsx` route les top-level views ; `ChatView` est le cœur (chat + input + panels).

## Files

| Fichier | Rôle |
|------|------|
| `App.tsx` | Router de views via `switch(currentView)` (L221). `ViewType = "task"\|"history"\|"config"\|"auth"\|"welcome"` (L20). Wrappe tout dans `ErrorBoundary` + `TerminalInfoProvider` + `StdinProvider` ; `task`/`welcome` ⇒ `TaskContextProvider`. `jsonOutput` ⇒ `TaskJsonView`. Bloque sur `AiActDisclosure` au 1er render TTY (L211) |
| `ChatView.tsx` | Vue principale. `<Static>` = header + messages complétés (zéro re-render), région dynamique = streaming + input. State input persistant inter-remount via `inputStateStorage` Map (L109). Délègue aux hooks `useChatMessages`/`useChatTask`/`useChatInputHandler` |
| `ChatMessage.tsx` | Rend un `IsaacMessage` (L284) ; markdown via `marked` (`case "heading"`/`"code"`/… L70+) |
| `ActionButtons.tsx` | `getButtonConfig(message, isStreaming)` (L189) → boutons selon le `ask`. `ButtonActionType` (L17) consommé par `ChatView.handleButtonAction` |
| `AskPrompt.tsx` | Rend le prompt selon `message.ask` (followup/tool/command/…) ; lit le `pendingAsk` du TaskContext |
| `ConfigView.tsx` / `ConfigViewWrapper.tsx` | Vue plein écran `config` (toggles rules/hooks/skills). Le **Wrapper** est stateful (handlers toggle) et est le point d'entrée appelé par `commands/config.ts` |
| `Panel.tsx` | Conteneur bordé réutilisable des panels bas-écran (label, `tabs`, `isSubpage` → "Esc to go back") |
| `SearchableList.tsx` / `SelectList.tsx` | Listes génériques `<T extends {id,label,suffix?}>` + `useInput`. SearchableList = fuzzy + scroll ; base de Provider/Model/LanguagePicker |
| `*PanelContent.tsx` | Contenu des panels in-chat (Settings/History/Help/Skills). Convention props : `{ controller, onClose, … }` |

## Subdirs

- `settings/` — gros panel Settings refactoré : `SettingsPanelContent.tsx` (orchestrateur, ~490 L, `useInput` central), `SettingsListView.tsx`, `constants.ts` (`TABS`, `FEATURE_SETTINGS`), `subpages/` (Picker/Edit/Setup/Auth pages), `hooks/` (`useSettingsItems`, `useSettingsActions`, `useAuthStatus`). Le `SettingsPanelContent.tsx` racine n'est qu'un ré-export.

## Pattern

- **View-routing** : top-level dans `App.tsx` (`currentView` state). In-chat : `ChatView.activePanel` (`"settings"|"history"|"help"|"skills"|null`, L230) — un seul panel à la fois, fermé par `onClose`.
- **Panel = `<Panel>` + contenu** : tout panel bas-écran wrappe son contenu dans `<Panel>` (cf `settings/SettingsPanelContent` L486).
- **Couleurs** : toujours `COLORS` de `../constants/colors` (`COLORS.primaryBlue`), jamais de hex en dur.
- **Mode act/plan** : borderColor bleu (act) / jaune (plan) — propagé en prop `mode` aux enfants.
- **Source de vérité settings** : `StateManager.get()` (synchrone) priorité sur `taskState.apiConfiguration` (async, laggy) — cf `ChatView` provider/modelId memos (L331+).

## How to add a panel (in-chat)

1. Crée `FooPanelContent.tsx`, props `{ controller, onClose, … }`, wrappe le rendu dans `<Panel label="Foo" …>`.
2. Ajoute le variant au union `activePanel` de `ChatView.tsx` (L230).
3. Render conditionnel `{activePanel?.type === "foo" && <FooPanelContent … />}` dans le bloc dynamique (vers L839).
4. Ouvre via `setActivePanel({type:"foo"})` (slash command / shortcut routé par `useChatInputHandler`).

## Gotchas

- `useInput` des panels doit passer `{ isActive: isRawModeSupported && !<subpage flags> }` (cf settings L378) sinon double-capture clavier avec `ChatView`.
- Quand un panel est ouvert, `ChatView` désactive `useHomeEndKeys`/`useRawBackspaceKeys` via `isActive: !activePanel` (L273-283). Respecte ce gating.
- `<Static>` ne re-render jamais ses items : ne mets dedans que du contenu **figé** (messages complétés). Le streaming va dans la région dynamique.
- L'input survit aux resize via `inputStateStorage` keyé par `getInputStorageKey(ctrl, taskId)` — ne pas remplacer par un simple `useState`, le remount le perdrait.
- Filtrer les escape souris : `isMouseEscapeSequence(input)` en tête de `useInput` (settings L279) avant tout parsing.
- `SettingsPanelContent.tsx` racine = ré-export ; éditer la vraie impl dans `settings/`.
- `pendingAsk` peut être supprimé en yolo : `isYoloSuppressed(yolo, ask)` cache boutons/input (L819) — tester les deux modes.
