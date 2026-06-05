# webview-ui

Panel React de l'extension VS Code (vue chat + settings + history). Build statique servi par
l'extension host dans une webview ; communique via gRPC-over-postMessage.

## Stack

- React 18.3 + TypeScript 5.7, bundler **Vite 7** (`@vitejs/plugin-react-swc`)
- **Tailwind CSS 4** via `@tailwindcss/vite` (config `tailwind.config.mjs`, `components.json` shadcn-style)
- UI primitives : Radix UI, HeroUI, `lucide-react`, `framer-motion`, `react-virtuoso`
- State : **Zustand 5** (stores per layer)
- Tests : **Vitest 3** + jsdom + Testing Library, setup `src/setupTests.ts`
- **Storybook 9** (`@storybook/react-vite`), config dans `.storybook/`
- Lint/format : Biome (root `biome.jsonc`)

## Layout `src/` — Feature-Sliced Design

```
app/         App.tsx, Providers.tsx, main.tsx, store/appStore.ts, styles/
features/    chat/ history/ settings/ worktrees/ dirac-rules/  (composants, stores, utils)
entities/    task/ user/  (stores Zustand domaine)
shared/      ui/ (primitives + shadcn) | api/ (grpc-client*, vscode.ts) | hooks/ | lib/
context/     IsaacAuthContext, PlatformContext (React context, pas store)
config/      platform.config.ts + platform-configs.json (vscode|standalone)
lib/utils.ts (cn helper)
```

Règle FSD : `app → features → entities → shared`. Une feature ne dépend **jamais** d'une autre
feature ni de `app/`. Imports remontants interdits. Alias : `@/*` → `src/*`,
`@shared` → `../src/shared` (extension host, pas webview), `@webview-shared` → `./src/shared`.

## Communication host ⇄ webview

**gRPC-over-postMessage**, pas de gRPC réseau. Voir `shared/api/grpc-client-base.ts`
(`ProtoBusClient.makeUnaryRequest` / `makeStreamingRequest`). Flux :

1. Webview `postMessage({ type: "grpc_request", grpc_request: { service, method, message, request_id } })`
2. Extension host (`src/core/controller/`) route, exécute, renvoie `{ type: "grpc_response", … }`
3. `PLATFORM_CONFIG` (vscode vs standalone) abstrait `postMessage` + encoding (`none`|`json`)

Les stubs typés sont générés depuis `proto/` par `npm run protos` (root) → `src/shared/proto/`.
Ne jamais éditer `shared/api/grpc-client.ts` (généré, exclu de la couverture).

## Ajouter une feature

1. `proto/<service>.proto` → `npm run protos` (à la racine du monorepo)
2. Côté host : handler dans `src/core/controller/<service>/`
3. Côté webview : créer `src/features/<feature>/{components,store,utils}`
4. Store Zustand local (`<feature>Store.ts`) ; appeler `<Service>ServiceClient.method(...)` depuis `shared/api/grpc-client.ts`
5. Monter dans `app/App.tsx` (ou route conditionnelle existante)
6. Stories `.stories.tsx` co-localisées + tests `__tests__/*.spec.tsx`

## Build / Dev

```bash
npm run dev               # vite dev, port 25463, écrit .vite-port (lu par l'extension host)
npm run build             # tsc -b && vite build → build/assets/{name}.js (single bundle)
npm run build:test        # dev-build : sourcemap inline, pas de minify
npm run storybook         # port 6006
npm test                  # vitest run (jsdom)
PLATFORM=standalone npm run build   # build pour mode standalone (hors VS Code)
```

`rollupOptions.output.inlineDynamicImports = true` → un seul bundle, requis par la CSP webview.
L'extension host charge `build/assets/index.js` ; HMR fonctionne en dev grâce au port écrit dans `.vite-port`.

## Pièges

- **CSP webview** : pas de `eval`, pas d'inline scripts, sources externes interdites. Tout doit
  passer par `inlineDynamicImports`. Pas de Web Worker chargé via URL externe.
- **Theming VS Code** : utiliser les CSS vars `--vscode-*` (cf. `app/styles/`). Storybook a son
  propre thème (`.storybook/themes.ts`) — les composants VS Code-only cassent hors webview, wrap
  avec `StorybookDecorator` (`config/StorybookDecorator.tsx`).
- **HMR** : marche en dev mais l'extension host doit être redémarrée si proto change.
- **gRPC streaming** : le listener `window.addEventListener("message", …)` doit être nettoyé
  manuellement (cf. `grpc-client-base.ts`) sinon fuite mémoire au remount.
