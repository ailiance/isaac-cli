# slash-commands

Parse `/command` tokens dans les messages chat utilisateur, transforme le texte avec des
instructions système avant que l'agent ne le voie. Appelé après `parseMentions()`.

## Files

- `index.ts` : `parseSlashCommands(text, ...)` — point d'entrée unique. Regex extrait
  une commande dans les tags `<task>|<feedback>|<answer>|<user_message>`. Une seule
  commande par message (premier match).
- `PermissionsCommandHandler.ts` : handler dédié pour `/permissions` (interactif, mute
  via `CommandPermissionController`).
- `__tests__/index.test.ts` : tests unitaires.
- `../prompts/commands.ts` : prompts injectés par les commandes builtin
  (`newTaskToolResponse`, `condenseToolResponse`, `newRuleToolResponse`,
  `reportBugToolResponse`, `explainChangesToolResponse`).

## Pattern de résolution (ordre de priorité)

1. **Builtin** (`SUPPORTED_DEFAULT_COMMANDS` dans `index.ts:56`) :
   `newtask`, `smol`, `compact`, `newrule`, `reportbug`, `explain-changes`, `permissions`.
   Mappés vers `commandReplacements` (prompts depuis `../prompts/commands`).
2. **Workflows** (fichiers `.md` user) : local > global > remote, matchés par `fileName`.
   Injectés en `<explicit_instructions type="...">`.
3. **Skills** : matchés par `skill.name` via `getSkillContent()`. Si tag vide, ajoute un
   message d'activation pour que l'agent demande la cible.

Builtins gagnent toujours sur les workflows homonymes.

## How to add a new builtin command

1. Ajouter l'export `xxxToolResponse()` dans `src/core/prompts/commands.ts`.
2. Importer dans `index.ts:10-16`, ajouter au tableau `SUPPORTED_DEFAULT_COMMANDS:56`.
3. Ajouter l'entrée dans `commandReplacements:59`.
4. Si comportement spécial (comme `permissions`) : handler dédié + branche dans la
   boucle (`index.ts:134`).
5. Test dans `__tests__/index.test.ts`.

## Gotchas

- Regex `slashCommandInTextRegex:91` exige whitespace ou début avant `/` — évite faux
  matches sur URLs / chemins de fichiers.
- Telemetry : `telemetryService.captureSlashCommandUsed(ulid, name, kind)` à appeler
  pour chaque branche (`builtin` | `workflow` | `skill`).
- `needsDiracrulesFileCheck: true` uniquement pour `newrule`.
- CLI vs webview : la résolution est partagée (host process) ; UI rendu diffère
  (`cli/src/components/HighlightedInput.tsx` vs webview React) mais pas la logique.
- ailiance-agent : `askDirac` (RAG sur source upstream) **retiré** — ne pas restaurer.
