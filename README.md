<div align="center">

# ISAAC

### Agent de code souverain — extension VS Code + CLI Ink, audit JSONL EU AI Act, branché sur la passerelle ailiance par défaut

[![release](https://img.shields.io/badge/release-v0.5.0--beta-7e3af2)](CHANGELOG.md)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![sovereignty](https://img.shields.io/badge/EU--sovereign-100%25-7e3af2)](https://github.com/ailiance/ailiance)
[![heritage](https://img.shields.io/badge/heritage-Dirac%20%2F%20Cline-1f4e8a)](https://github.com/dirac-run/dirac)
[![tracing](https://img.shields.io/badge/tracing-EU%20AI%20Act%20JSONL-success)](src/core/tracing/JsonlTracer.ts)
[![backend](https://img.shields.io/badge/backend-eu--kiki-7e3af2)](https://github.com/ailiance/ailiance)

CLI : **`isaac`** · Extension VS Code · UI webview React · Provider par défaut : passerelle [ailiance](https://github.com/ailiance/ailiance) (`http://studio:9300`)

</div>

---

## C'est quoi

Un agent de code conversationnel forké de [Dirac](https://github.com/dirac-run/dirac) (lui-même basé sur [Cline](https://github.com/cline/cline)) avec **trois différences qui comptent** :

1. **Tracing JSONL EU AI Act** — chaque tour de plan / d'outil est écrit dans `.ailiance-agent/runs/<task_id>/`, secrets scrubés, audit prêt pour Annex IV §1(c).
2. **Backend ailiance par défaut** — la passerelle souveraine 5 workers (Apertus, Devstral, EuroLLM, Gemma 3, Qwen3-Next) au lieu d'OpenAI/Anthropic. 41 autres providers branchables (Bedrock, Vertex, DeepSeek, Mistral, OpenRouter, etc.).
3. **Télémétrie désactivée** — upstream Dirac envoie des events à PostHog. Ce fork coupe tout. Aucune donnée ne sort de l'hôte.

### Vue d'ensemble

```mermaid
flowchart TB
    user([👤 Utilisateur])

    subgraph clients["Clients"]
        cli["CLI Ink<br/><code>isaac</code> "]
        vscode["Extension VS Code<br/>+ webview React"]
    end

    subgraph core["Cœur agent (TypeScript strict)"]
        loop["Boucle agent<br/><code>src/core/task/</code>"]
        tools["Tool handlers<br/><code>src/core/task/tools/</code>"]
        tracer["JsonlTracer<br/><code>.ailiance-agent/runs/&lt;task&gt;/</code>"]
        store["State / disk<br/><code>~/.dirac · globalStorage</code>"]
        loop --> tools
        loop --> tracer
        loop --> store
    end

    subgraph providers["Providers LLM (42)"]
        ailiance["🇪🇺 ailiance gateway<br/><b>par défaut</b><br/>:9300 → 5 workers"]
        cloud["Anthropic · OpenAI<br/>Bedrock · Vertex · Mistral<br/>DeepSeek · Qwen · …"]
        local["🏠 Local stack<br/>Jina :5050 / LiteLLM :4000<br/>(auto-detect)"]
    end

    user --> cli
    user --> vscode
    cli --> loop
    vscode --> loop
    loop --> ailiance
    loop -.->|fallback| cloud
    loop -.->|<code>useLocalStack=true</code>| local

    classDef sov fill:#dbeafe,stroke:#1e40af,stroke-width:2px,color:#0c2a5b
    classDef ext fill:#fef3c7,stroke:#92400e
    classDef audit fill:#d1fae5,stroke:#065f46,stroke-width:2px
    class ailiance,local sov
    class cloud ext
    class tracer audit
```

## v0.5.0-beta — Universal tool calling

isaac now ships a full agentic loop with tool emulation that works
across **every** EU-sovereign worker on the cluster:

- **Qwen 32B AWQ** (primary, vLLM native function calling)
- **Eurollm 22B**, **Apertus 70B**, **Devstral 24B** (worker-side emulation)
- **Gemma 3 4B** (gateway-side emulation)

The gateway force-routes any request with `tools[]` to the most reliable
worker, so file editing (`write_to_file`, `edit_file`, `read_file`) and
command execution (`execute_command`) work end-to-end with `isaac` running
against your local stack.

See [`docs/local-router.md`](./docs/local-router.md) and [`CHANGELOG.md`](./CHANGELOG.md) for details.

### What's new in v0.5

- **Universal tool emulation** — 5 formats parsed in LocalRouter (`<tool_call>`,
  ` ```tool `, ` ```json `, ` ```bash `, ` ```tool_code `, plain `read_file("...")`)
- **Force-route to tool-capable workers** — requests with `tools[]` prioritize
  `supportsTools:true` workers automatically
- **`isaac timeline`** — Ink CLI view of task history grouped by day with emoji
  classification and cursor navigation
- **Anti-hallucination guard** — "TOOL CONSTRAINTS" section in system prompt
  prevents workers from inventing tool names (`digikey:`, `bom:`, `kicad:` etc.)
- **Imperative verbs → ACT** — "fais/fait/écris/ajoute/réalise/génère/construis/
  implémente" always trigger Act mode regardless of prompt length
- **`function.id` propagation fix** — critical fix for multi-turn tool calls
  (commit `783cc66`). Previously `tool_result` fell back to plain text, breaking
  the OpenAI tools protocol. Now `toolUseIdMap` maps correctly across turns.

## v0.4 highlights

- **Plugin marketplace**: `isaac plugin install <github-url>` to install Claude Code plugins
- **MCP integration**: discover and use MCP servers from installed plugins
- **LocalRouter** (in-process LLM router): cache, health monitoring, ctx-aware skip,
  SSE streaming. See [docs/local-router.md](./docs/local-router.md).
- **Local stack** (`isaac stack {start,stop,status}`): managed LiteLLM proxy + Jina
  semantic router. See [docs/local-stack.md](./docs/local-stack.md).
- **Auto plan/act mode** (opt-in): `autoModeFromPrompt: true` to choose mode
  from prompt content. See [docs/auto-mode.md](./docs/auto-mode.md).
- **Web UI** at `http://127.0.0.1:25463` with worker status dashboard, SPA standalone
  on `/spa`, gRPC HTTP backend on `/grpc/StackService/*`.
- **Refactor**: Task class reduced from 1970 → 592 lines (-70%) for maintainability.
- **+170 tests** (1047 → 1238), 0 régressions.

## Démarrer en 30 secondes

```bash
# Installation globale (Node 20 / 22 / 24 — pas Node 25)
# ISAAC n'est PAS publié sur npm public (ne pas faire `npm install -g isaac`,
# qui installe un paquet CSPRNG sans rapport). Deux voies souveraines :

# A. Depuis la source (contributeurs / dev) — cf. « Démarrage rapide (dev) »
git clone https://git.saillant.cc/ailiance/isaac-cli.git && cd isaac-cli
./setup.sh                                 # Node (nvm) + deps + protos + build + link `isaac`

# B. Déploiement depuis un tarball pré-buildé (méthode utilisée sur MacStudio)
#   machine de build :  cd cli && npm pack                  # -> isaac-cli-<ver>.tgz
#   machine cible :     npm install -g ./isaac-cli-<ver>.tgz
# Le tarball embarque dist/ et résout les binaires natifs (better-sqlite3,
# ripgrep via l'optionalDependency @vscode/ripgrep-<plateforme>) à l'install.

# Premier prompt — passerelle ailiance par défaut (https://gateway.ailiance.fr/v1)
isaac "résume-moi ce dépôt en 5 puces"

# Provider explicite
isaac --provider anthropic --model claude-opus-4-7 "ajoute un test pour foo()"

# Mode plan (réfléchit avant d'agir)
isaac -p "refactor le module bar/ en deux modules"
```

### Setup multi-OS (mac / linux / windows)

Scripts de bootstrap idempotents (check Node 20–24 → `install:all` → `protos` →
build CLI → link global `isaac`) :

```bash
# macOS / Linux / WSL
git clone https://git.saillant.cc/ailiance/isaac-cli.git && cd isaac-cli
./setup.sh            # CLI + link global `isaac` (Node piné via nvm)
./setup.sh --all      # + extension VS Code
./setup.sh --help     # toutes les options
```

```powershell
# Windows (PowerShell 7+)
git clone https://git.saillant.cc/ailiance/isaac-cli.git; cd isaac-cli
./scripts/setup.ps1           # CLI + link global `isaac`
./scripts/setup.ps1 -All      # + extension VS Code
```

| OS | Prérequis | Notes |
|----|-----------|-------|
| macOS | Node 20/22/24 (`nvm use` lit `.nvmrc`) | natifs résolus à l'install |
| Linux | idem | idem |
| WSL | idem | lancer `code` côté Windows pour l'extension |
| Windows | Node 20/22/24 + **VS Build Tools** (C++) + Python | requis pour compiler `better-sqlite3` |

> ⚠️ Le vieux `scripts/install.sh` est un résidu Dirac (binaire `dirac` pré-buildé,
> mac/linux only) — **ne pas l'utiliser**. Voir `scripts/CLAUDE.md`.

### Modes de lancement

| Commande | Comportement |
|----------|--------------|
| `isaac` (ou `isaac`) sans argument | TUI interactive (Ink/React). **Requiert un vrai TTY** (Warp / iTerm / zellij / tmux). Bail clair si lancé en pipe / subprocess / CI. |
| `isaac "<task>"` | Run one-shot avec le prompt positionnel. Pas besoin de TTY. |
| `echo "<task>" \| isaac` | Run one-shot via stdin pipé. Le contenu pipé devient le prompt. |
| `cat file.md \| isaac "résume"` | Stdin pipé prepend au prompt positionnel. |
| `isaac --continue` | Reprend la dernière task du `cwd` courant. |
| `isaac --acp` | Mode Agent Client Protocol pour intégration éditeur (Zed, etc.). |
| `isaac t -y "<task>"` | Sous-commande `task` (alias `t`) avec yolo mode (auto-approve actions). |

Override de la passerelle (par exemple en mobilité / on-tailnet) :

```bash
# On-tailnet, moins de latence (skip Cloudflare hop)
AILIANCE_GATEWAY="http://electron-server:9300/v1" isaac "..."

# Endpoint custom (OpenAI-compatible)
AILIANCE_GATEWAY="https://my-proxy.example.com/v1" isaac "..."
```

L'extension VS Code s'installe via le `.vsix` du repo (paquet `isaac-0.3.1.vsix`).

## Outils de l'agent — read / write / bash

L'agent dispose de 27 outils canoniques (`IsaacDefaultTool`) ; les trois principaux sont :

| Outil | Enum | Handler | Limite |
|-------|------|---------|--------|
| `read_file` | `FILE_READ` | `ReadFileToolHandler` | 50 KB par fichier (PDF/code/Word via `extractFileContent`) |
| `write_to_file` | `FILE_NEW` | `WriteToFileToolHandler` | Pas de cap, mais content tronqué côté UI streamée |
| `execute_command` | `BASH` | `ExecuteCommandToolHandler` | Output 10 KB head/tail, timeout 30 s (300 s pour long-runners) |

### Auto-approve — 3 modes

| Mode | Comment | Effet |
|------|---------|-------|
| **yolo** (`-y`) | flag CLI ou toggle session | Approuve TOUT (read + write + bash + browser), sauf `hard_deny` zone shell |
| **autoApproveAll** | toggle persistant TUI | Idem yolo mais entre sessions |
| **per-action** | `autoApprovalSettings.actions.{readFiles, editFiles, executeCommands, useBrowser}` | Granulaire ; par défaut tout `false` → approbation manuelle de chaque appel |

### Zones de sécurité shell (`execute_command`)

Le `zoneClassifier` (`src/core/safety/zoneClassifier.ts`) classe chaque commande dans 3 zones :

#### Zone `auto_ok` — exécutées sans prompt
Commandes lecture-seule ou outils de build standards :

```
ls, cat, head, tail, find, wc, file
pytest, uv, cargo, npm, pnpm, yarn, bun, make, cmake, go, rustc, ctest
black, ruff, prettier, rustfmt, gofmt, clang-format
git status / diff / log / show / branch / tag / remote
```

#### Zone `confirm` — toujours approbation explicite
Commandes avec effets de bord network / package / push :

```
{npm,pnpm,yarn,pip,uv,cargo} install/add/update/publish
git push, git commit (write)
docker run / build / push
curl / wget / ssh / scp / rsync (network egress)
```

Même en yolo mode, ces commandes demandent confirmation si `autoApprovalSettings.actions.executeCommands` est `false`.

#### Zone `hard_deny` — refusées TOUJOURS (exit code 8)

```
rm -rf <path>                    rm -r <path>
dd of=/dev/...                   mkfs.<fs>
shutdown / reboot / halt         sudo / su / doas
:(){ :|:& };:                    (fork bomb)
curl ... | sh                    (pipe-to-shell)
> /dev/sd[a-z]                   (raw disk write)
chmod 777 -R /                   chown -R root /
```

Yolo mode ne déverrouille **pas** cette zone. Le LLM reçoit l'exit code 8 et doit choisir une alternative.

### Long-runners — timeout 300 s

Pour ces commandes le timeout par défaut passe de 30 s à 5 minutes :

```
{npm,pnpm,yarn,bun} install/ci/build/test
{pip,uv,poetry,pipenv} install
{cargo,go,mvn,gradle} build/test/install
make, cmake, ctest
pytest, tox, nox, jest, vitest, mocha
docker/podman build
torchrun, deepspeed, accelerate launch
{rails,alembic,prisma,django} migrate
ffmpeg
python ... train|finetune
```

### XML hallucination fallback (v0.7)

Quand un backend MLX (Mistral-Medium-128B, Devstral, etc.) sans native function calling reçoit un schéma `tools[]`, il émet parfois du XML hallucination :

```xml
<function=list_files>
<parameter=paths>["."]</parameter>
</function>
```

Le CLI parse ces blocs en `ToolUse` synthétiques (cf. `src/utils/parse-hallucinated-tool-xml.ts`), valide chaque nom contre `IsaacDefaultTool` (avec alias map : `bash`/`grep`/`writefile`/`listfiles` mappés à leur enum canonique), et dispatche via le même handler que les tool_calls natifs. Le root-cause fix vit dans la gateway (`FC_FORCE_ROUTE_PORT`) qui redirige les `tools[]` vers le worker natif-FC Qwen 32B, mais ce parser CLI reste comme defense-in-depth.

## Extension VS Code

[![Install in VS Code](https://img.shields.io/badge/Install-VS%20Code-007ACC?logo=visualstudiocode)](https://github.com/ailiance/isaac-cli/releases) [![VSIX](https://img.shields.io/badge/.vsix-agent--kiki--0.3.1-005a8b)](https://github.com/ailiance/isaac-cli/releases)

```bash
code --install-extension isaac-0.3.1.vsix
```

Une fois installée, l'extension ajoute :

- **Activity bar** — icône isaac ouvrant le panneau chat (webview React).
- **Walkthrough** — `isaac, the EU-sovereign autonomous coding agent` (Hash-anchored edits, AST precision, minimal roundtrips, speed).
- **Context menus** — clic droit sur sélection / terminal / commit / Jupyter cell.
- **Commit messages** — génération automatique sur le bouton de SCM Git.

### Surfaces UI

```mermaid
flowchart LR
    user([👤 Utilisateur VS Code])

    subgraph vscode["Extension VS Code"]
        sidebar["Activity Bar<br/>panneau chat<br/>(webview React)"]
        palette["Command Palette<br/>(Ctrl/Cmd + Shift + P)"]
        context["Context menu<br/>éditeur · terminal · SCM"]
        keys["Keybindings<br/>Cmd + ' · ?"]
        walk["Walkthrough<br/>onboarding 4 cartes"]
    end

    subgraph core["Cœur agent (partagé)"]
        loop["src/core/task/<br/>Task loop ReAct"]
        tracer["JsonlTracer"]
    end

    user --> sidebar --> loop
    user --> palette --> loop
    user --> context --> loop
    user --> keys --> loop
    user --> walk
    loop --> tracer

    classDef ui fill:#dbeafe,stroke:#1e40af
    classDef core fill:#ede9fe,stroke:#5b21b6
    class vscode ui
    class core core
```

### Commandes (palette)

| Commande | Effet |
|---|---|
| `New Task` | nouveau dialogue agent |
| `History` | historique des tâches |
| `Settings` | panneau de configuration (provider, modèles, MCP, hooks) |
| `Add to isaac` | ajoute la sélection ou la sortie terminale au chat |
| `Generate Commit Message with isaac` | sur le SCM Git, génère un commit via le LLM |
| `Explain with isaac` | explique la sélection |
| `Improve with isaac` | propose une amélioration |
| `Generate / Explain / Improve Jupyter Cell` | équivalents notebook |
| `Open Walkthrough` | (re)lance le tutoriel d'accueil |
| `Reconstruct Task History` | reconstruit l'historique depuis les traces JSONL |
| `Accept` / `Reject` / `Save with My Changes` | actions sur les diffs proposés par l'agent |

### Raccourcis

| Touche | Action | Quand |
|---|---|---|
| **`⌘'` / `Ctrl+'`** | `Add to isaac` | sélection active dans l'éditeur |
| **`⌘'` / `Ctrl+'`** | `Jump to Chat Input` | sans sélection |
| **`?`** | `Generate Commit Message with isaac` | dans la vue SCM Git |
| **`Enter`** | Reply (review comment) | dans un comment editor `dirac-ai-review` |

### Configuration via le panneau Settings

- Provider + modèle (par défaut `ailiance/auto`, ou `ailiance/devstral-24b` pour le code, etc.)
- API key par provider (chiffrée en `~/.dirac/`)
- Mode plan / act, auto-approve, double-check completion, auto-condense
- `useLocalStack` (auto-detect Jina / LiteLLM)
- `enabledMcpServers`, `mcpToolDenylist`, `mcpToolAllowlist`
- Plugin hooks dirs (`PreToolUse` / `PostToolUse`)
- Sub-agents

### Ce qui sort de l'extension

Aucune télémétrie. Aucune donnée n'atteint `dirac.run` ni PostHog. Les seules requêtes réseau sont :

- Vers le provider LLM choisi (ailiance gateway par défaut, sinon le backend que tu as configuré).
- Vers les serveurs MCP que tu autorises explicitement via `enabledMcpServers`.

Toute l'activité de la tâche est tracée localement dans `<workspace>/.ailiance-agent/runs/<task_id>/` avec scrubber secret-sensible.

## Statusline 2 lignes (v0.3)

Inspirée de Claude Code. Visible en bas de la chat view :

```
 ▸ ~/Documents/Projets/isaac   master
  devstral-24b      ◉ 73%    ⏱ 11:09:42
 / pour commandes · @ pour fichiers · Shift+↓ pour multi-ligne     ● Plan ○ Act (Tab)
 devstral-24b ███░░░░░░░ (12 345) | 0,082 €
 isaac (master) | 3 fichiers +120 -45
 ⏵⏵ Auto-approve all enabled (Shift+Tab)
```

- Ligne 1 : `▸ <cwd_complet>` + badge branche (vert si clean, jaune si dirty)
- Ligne 2 : badge magenta modèle + badge contexte coloré (vert ≥ 40 %, jaune ≥ 15 %, rouge sinon) + horloge live

## Ce qui distingue ce fork

| | isaac | Dirac upstream |
|---|---|---|
| **Provider par défaut** | ailiance gateway (5 modèles EU/CH/Asie souverains) | OpenAI |
| **Télémétrie** | aucune (PostHog désactivé) | events vers `dirac.run` |
| **Audit** | trace JSONL secret-scrubée par tâche, prête pour EU AI Act Annex IV | logs upstream classiques |
| **Routage local** | auto-detect Jina :5050 / LiteLLM :4000 si `useLocalStack` | absent |
| **Branding CLI** | `isaac` (court) + statusline 2 lignes | `dirac` |
| **Plugin hooks** | `PreToolUse` / `PostToolUse` câblés au runtime | upstream |
| **Filtrage MCP** | `enabledMcpServers` + `mcpToolDenylist` + `mcpToolAllowlist` | upstream |

Pour le reste — boucle ReAct, hash-anchored parallel edits, AST manipulation, `--auto-condense`, `--double-check-completion`, 41 providers tiers — **on hérite et on garde la compatibilité stricte avec Dirac**. Les améliorations qui ne sont pas spécifiques au fork remontent en upstream.

## Boucle agent + audit JSONL

```mermaid
sequenceDiagram
    autonumber
    participant U as Utilisateur
    participant A as Agent (Task)
    participant L as LLM (ailiance / autre)
    participant T as Outils
    participant J as JsonlTracer

    U->>A: prompt initial
    A->>J: meta.json (task_id, cwd, mode, model)

    loop ReAct jusqu'à attempt_completion
        A->>L: stream chat completions
        L-->>A: tokens (texte + tool_calls)
        A->>J: trace.jsonl ← phase=plan
        opt tool_call émis
            A->>T: exécute (read / edit / bash …)
            T-->>A: résultat
            A->>J: trace.jsonl ← phase=execute
        end
    end

    A->>J: trace.jsonl ← phase=summarize
    A-->>U: réponse finale + résumé

    Note over J: Scrubber sur tous les writes :<br/>AWS keys · PEM · URLs<br/>champs <code>password / apiKey / secret</code>
```

`.ailiance-agent/runs/<task_id>/`
- **`meta.json`** — task_id, cwd, mode (plan/act), model, provider, début, fin
- **`trace.jsonl`** — un évènement par ligne, phase ∈ `plan / execute / summarize / abort`

Les secrets sont retirés au moment de l'écriture par `JsonlTracer:210` (regex blocklist). Aucune purge a posteriori nécessaire.

## Providers branchables (42)

```mermaid
flowchart LR
    subgraph default["🇪🇺 Par défaut"]
        EU["ailiance gateway<br/>5 workers<br/>:9300/v1"]
    end

    subgraph cloud["☁️ Cloud / hébergés"]
        ANT["Anthropic"]
        OAI["OpenAI"]
        BED["AWS Bedrock"]
        VTX["Vertex AI"]
        AZ["Azure OpenAI"]
        OR["OpenRouter"]
        DS["DeepSeek"]
        QW["Qwen"]
        MIS["Mistral"]
        AIH["AIHubMix<br/>(nouveau v0.3)"]
        ETC["… 30+ autres<br/>cf. <code>src/core/api/providers/</code>"]
    end

    subgraph local["🏠 Local"]
        OL["Ollama"]
        LMS["LM Studio"]
        VLLM["vLLM"]
        TGI["TGI"]
        JINA["Jina :5050<br/>(auto)"]
        LL["LiteLLM :4000<br/>(auto)"]
    end

    cli([isaac / isaac])
    cli --> EU
    cli -.-> cloud
    cli -.-> local

    classDef def fill:#dbeafe,stroke:#1e40af,stroke-width:2px
    classDef cl fill:#fef3c7,stroke:#92400e
    classDef lo fill:#d1fae5,stroke:#065f46
    class default def
    class cloud cl
    class local lo
```

Switch : `isaac --provider <nom> --model <id>` ou via le panneau de config. La liste complète : `src/core/api/providers/` (un fichier par backend). 42 providers. Configurations stockées chiffrées dans `~/.dirac/`.

## Stack local auto-detect (v0.3)

Active le routage local dynamique :

```mermaid
flowchart LR
    REQ([requête LLM])
    USE{<code>useLocalStack</code><br/>activé ?}
    PROBE1{Jina :5050<br/>répond ?}
    PROBE2{LiteLLM :4000<br/>répond ?}

    REQ --> USE
    USE -- non --> CONF["base URL configurée<br/>(ailiance par défaut)"]
    USE -- oui --> PROBE1
    PROBE1 -- oui --> J["Jina semantic router<br/>:5050/v1"]
    PROBE1 -- non --> PROBE2
    PROBE2 -- oui --> LL["LiteLLM proxy<br/>:4000/v1"]
    PROBE2 -- non --> CONF

    classDef ok fill:#d1fae5,stroke:#065f46
    classDef miss fill:#fef3c7,stroke:#92400e
    class J,LL ok
    class CONF miss
```

Cache 30 s pour ne pas pinger les ports à chaque requête (`src/services/local-stack/LocalStackDetector.ts`). Activable globalement (`useLocalStack` setting key) ou par appel.

## Démarrage rapide (dev)

```bash
git clone https://git.saillant.cc/ailiance/isaac-cli.git   # forge primaire (GitHub = miroir/backup)
cd isaac-cli
./setup.sh            # tout-en-un : Node (nvm) + install:all + protos + cli:build + link `isaac`

# …ou étape par étape :
npm run install:all   # bootstrap monorepo (root + cli + webview-ui)
npm run protos        # génère src/generated/ + src/shared/proto/ — REQUIS avant build
npm run cli:build     # build du CLI (inclut protos) ; extension = npm run compile
npm test              # suite mocha (root) + vitest (cli, webview-ui)
npm run lint          # biome
```

Workspaces :

| Path | Rôle |
|------|------|
| `src/` | Extension VS Code + cœur agent (TS strict) |
| `cli/` | CLI Ink (binaire `isaac`, build esbuild → `dist/cli.mjs`) |
| `webview-ui/` | Frontend React (Vite + Storybook) |
| `proto/` | Protobuf (gRPC entre host / webview / CLI) |
| `agent-registry/`, `evals/`, `walkthrough/`, `locales/` | Assets non-code |

## Configuration

| Clef | Effet |
|---|---|
| `AGENT_KIKI_GATEWAY=<url>` (env) ou `--baseurl` | Override de la passerelle ailiance par défaut |
| `useLocalStack` (setting) | Active l'auto-detect Jina :5050 / LiteLLM :4000 |
| `enabledMcpServers` (setting) | Liste blanche des serveurs MCP à charger |
| `mcpToolDenylist` / `mcpToolAllowlist` (setting) | Filtrage fin par outil |
| `enableParallelToolCalling` | (déjà existant upstream) — true par défaut |

L'API gateway ailiance attend le suffixe `/v1` (cf. ailiance/src/gateway/server.py — `/v1/chat/completions` est la seule route exposée).

## Quoi regarder où

| Tâche | Location |
|---|---|
| Boucle d'exécution agent / state | `src/core/task/` |
| Provider LLM (anthropic, openai, …) | `src/core/api/providers/` |
| Tracing JSONL + scrubber | `src/core/tracing/JsonlTracer.ts` |
| Persistence disque | `src/core/storage/` |
| Tool handlers | `src/core/task/tools/handlers/` |
| Slash commands | `src/core/slash-commands/` |
| Prompts système | `src/core/prompts/` |
| CLI Ink (TUI) | `cli/src/` |
| Statusline (ChatFooter) | `cli/src/components/ChatFooter.tsx` |
| UI React (panel webview) | `webview-ui/src/` |
| Notes acceptance MVP | `docs/` |

## Changements récents

Voir [`docs/CHANGELOG.md`](docs/CHANGELOG.md). Versions actives :

- **v0.3.1** (2026-05-06) — fleet ailiance passé à 5 workers (Gemma 3, Qwen3-Next 80B MoE)
- **v0.3.0** (2026-05-06) — statusline 2 lignes, local stack auto-detect, plugin hooks runtime, filtrage MCP, provider AIHubMix
- **v0.2.0** (2026-05-05) — convergence agent end-to-end avec ailiance (parsing tool-calls Mistral)
- **v0.1.0** (2026-05-05) — fork initial : tracing JSONL, télémétrie off, defaults ailiance

## Limitations connues (v0)

- **Backend** : par défaut `http://studio:9300/v1` (Tailscale privé). Override via `AGENT_KIKI_GATEWAY` ou `--baseurl`. Le suffixe `/v1` est obligatoire.
- **ailiance LoRA adapters** : worker wrap base + `linear_to_lora_layers`, charge les poids via `strict=False` (`ailiance:1ed24b8`). Adapter par domaine activé quand le header `X-Lora-Domain` est présent.
- **Sentinel apiKey** : sans provider configuré, le fork persiste `openAiApiKey="unused"` comme sentinelle pour le code path openai-compatible. La passerelle ailiance ne valide pas les clés.
- **Trace gap** : les tâches abandonnées avant un tool call valide produisent un dossier de run avec meta/trace vides. Audit downstream : traiter comme `incomplete`.
- **Node.js v25 non supporté** (bug V8 Turboshaft upstream). Utiliser Node 20, 22 ou 24 LTS.
- **Pas de rotation des traces** : `<cwd>/.ailiance-agent/runs/` s'accumule sans purge auto. Nettoyage manuel jusqu'à v0.4.

## Origine et licence

Fork de [Dirac](https://github.com/dirac-run/dirac), lui-même basé sur [Cline](https://github.com/cline/cline). Les améliorations qui ne sont pas spécifiques au fork (boucle agent, optimisations de contexte, suite d'évals, parallel edits, AST manipulation, sub-agents) viennent d'upstream et restent compatibles. License **Apache-2.0**, préservée.

