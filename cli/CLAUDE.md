# cli/

Binaire `isaac` — CLI Ink/React, fork de Dirac. Entry point :
`src/index.ts` (utilise `commander`). Build esbuild → `dist/cli.mjs` (bin) et
`dist/lib.mjs` (lib programmatique). Réutilise le core de l'extension via alias
`@/`, `@core/`, `@shared/`, … résolus par `aliasResolverPlugin` (esbuild.mts).

## Stack

- **ink** `npm:@jrichman/ink@7.0.0` (fork) + **react 19.2** + TS 5.4 strict.
- **commander 12** (subcommands), **prompts**, **chalk**, **ora**, **marked**,
  **pino** (logs `.isaac/log/`), **@vscode/ripgrep**, **better-sqlite3**.
- **@agentclientprotocol/sdk** (ACP) pour le mode stdio.
- Node ≥20 <25, ESM uniquement (`"type":"module"`).

## Structure

| Path | Rôle |
|------|------|
| `src/index.ts` | Commander root — déclare `task`, `history`, `config`, `auth`, `resume`, `trace`, `welcome`, et lazy-import des handlers |
| `src/commands/` | Handlers de subcommands (un fichier par cmd) |
| `src/components/` | Vues Ink (`App.tsx` route les views, `ChatView`, `ConfigView`, `HistoryView`, `AuthView`, …) + tests `*.test.tsx` |
| `src/hooks/` | React hooks Ink-spécifiques (`useTerminalSize`, `useTextInput`, `useChatInputHandler`, `useRawBackspaceKeys`, `useHomeEndKeys`) |
| `src/controllers/` | `CliWebviewProvider` — adapte le Controller du core (qui parle webview) au CLI |
| `src/agent/` | `IsaacAgent` (boucle agent réutilisable), `IsaacSessionEmitter`, `messageTranslator`, `permissionHandler` |
| `src/acp/` | `AcpAgent` — wrap `IsaacAgent` derrière une `AgentSideConnection` ACP/stdio |
| `src/context/` | React context providers (`StdinContext`, `TaskContext`) |
| `src/vscode-shim.ts`, `vscode-context.ts` | Stubs `vscode.*` pour faire tourner le core hors extension |
| `src/exports.ts` | Surface lib programmatique (re-exports IsaacAgent + types) |

## Pont CLI ↔ core

Pas de gRPC ni IPC : le CLI **importe directement** `src/core/**` via les alias
esbuild. `vscode-shim.ts` fournit les stubs (`URI`, FS, …) ; `CliWebviewProvider`
remplace le `WebviewProvider` de l'extension. Mode stdio externe = ACP via
`AcpAgent` (`@agentclientprotocol/sdk`).

## Ajouter une commande

1. Crée `src/commands/<name>.ts` exportant `run<Name>(args, options)`.
2. Dans `src/index.ts`, ajoute `program.command(...).action(async (...) => { const { runX } = await import("./commands/x"); return runX(...) })` (lazy import obligatoire — réduit le cold start).

## Ajouter un component Ink

Drop dans `src/components/Foo.tsx`, exporte un `FunctionComponent`. Si input
clavier : utilise `useInput` d'Ink, **pas** stdin natif. Si dimensions :
`useTerminalSize()` (déjà tient compte de SIGWINCH). Toujours wrap les vues
top-level dans `<ErrorBoundary>` (cf `App.tsx`). Tests : `ink-testing-library`
+ vitest, voir `App.test.tsx`.

## Build / Test

```bash
npm run build          # typecheck + esbuild + dts (build:types)
npm run watch          # esbuild --watch
npm run dev            # link global + watch
npm test               # vitest (pas mocha — root utilise mocha, cli utilise vitest)
npm run typecheck      # tsc --noEmit
```

## Pièges

- **Console silencieux par défaut** : `suppressConsoleUnlessVerbose()` est appelé
  au top de `index.ts`. Pour debug, passe `-v/--verbose` ou logue via `pino`
  (fichier dans `.isaac/log/`), pas `console.log`.
- **Raw mode stdin** : géré par Ink + `StdinContext`. Ne pas toucher
  `process.stdin.setRawMode` directement, ça casse les hooks `useInput`.
- **Backspace / Home-End** : terminaux variés → `useRawBackspaceKeys` /
  `useHomeEndKeys` normalisent. Réutilise-les plutôt que de parser les escape codes.
- **Resize** : `useTerminalSize` est la source de vérité ; ne lis pas
  `process.stdout.columns` directement dans le render (test : `App.resize-initial-prompt.test.tsx`).
- **Alias esbuild** : un import `@/foo` marche au build mais **pas** dans `tsc`
  sans `tsconfig.lib.json` paths — vérifie les deux configs si tu ajoutes un alias.
- **Ink fork** (`@jrichman/ink`) : ne pas remplacer par l'upstream `ink`, des
  patches y vivent (notamment terminal handling).
- **Subcommands lazy-import** : ne pas importer les handlers en haut de
  `index.ts`, ça plombe le startup et peut crasher avant `suppressConsole`.
