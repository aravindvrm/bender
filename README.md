# Bender

Bender is an AI software-factory CLI + local dashboard that plans and executes work against a project directory, with persistent state in `.bender/`.

## Current Product Spec

### CLI commands

- `bender bend` opens the local web dashboard.
- `bender open` and `bender review` are aliases to `bend`.
- `bender init -d <dir>` initializes `.bender/` state for a project.
- `bender analyze -d <dir>` analyzes an existing codebase into `.bender/` state.
- `bender plan "<description>" -d <dir>` creates a new task plan.
- `bender implement -d <dir>` executes the active task plan.
- `bender status -d <dir>` prints current project status.

### Dashboard IA (current)

- Two-pane sidebar:
- Left rail (global): project browser, new project, analyze, settings, git clean/dirty dot.
- Right panel (project): logo header + `Overview`, `Tasks`, `Architecture`, `Changes`.
- Main content area with view-specific pages.
- Bottom drawer labeled `Console` for streamed operation output + confirmations/prompts.

### New Project modal (current)

The `New Project` flow is fully multi-section:

1. Directory:
- path input + browse explorer
- directory inspection status (`does not exist`, `file path`, `empty dir`, `existing dir`, `already has .bender`)
2. Description:
- required "What are you building?" textarea
3. Stack (optional quick-pick):
- `Next.js SaaS`, `Express API`, `Let AI Decide`
4. LLM setup (conditional):
- shown when no usable API key/provider is detected
- provider picker + inline API key field (except `ollama`)

`/api/run/init` now accepts:
- `path`
- `description`
- `template` (`nextjs-saas` | `express-api` | `auto`)
- `llmProvider`
- `llmApiKey`

### Architecture view (current)

- Tabbed architecture page: `Architecture`, `Schema`, `Flows`, `Decisions`, `Conventions`.
- `Schema` renders an ERD from SQL via Mermaid and also shows raw SQL.
- `Flows` can generate Mermaid user flows via `/api/run/flows`, persisted to `.bender/flows.md`.

### Config/runtime capabilities

- Per-provider API key support (`anthropic`, `openai`, `google`, `groq`, `ollama`) in config + env fallback.
- MCP server configuration in Settings, with runtime support for:
- OpenAI provider tool wiring via AI SDK MCP tools.
- Anthropic provider MCP server options.
- Skills context injection from configured markdown/text paths.

### Persistent state

Bender writes project state under `.bender/`, including:

- `brief.md`
- `architecture.md`
- `conventions.md`
- `schema.sql`
- `flows.md`
- `config.yaml`
- `decisions/*.md`
- `tasks/current.md`
- `tasks/completed/*.md`
- `api-contracts/routes.yaml`
- `sessions/*.md`

## Setup

Requirements:

- Node.js `>=20`
- npm

Install + build:

```bash
npm install
npm run build
```

Run dashboard from repo:

```bash
npm run bend
```

Use `bender` as a command globally (optional):

```bash
npm link
bender bend
```

## Dev Scripts

- `npm run build` – build CLI + web
- `npm run build:cli` – build CLI only
- `npm run build:web` – build web only
- `npm run dev` – TypeScript watch
- `npm run dev:web` – Vite dev server
- `npm run bend` – build CLI and run `bender bend`
- `npm run test` – full test harness (`build:cli` + unit + integration)
- `npm run test:unit` – deterministic unit tests for config/state/skills/runtime
- `npm run test:integration` – CLI integration smoke tests against built `dist/cli`
- `npm run test:e2e:smoke` – end-to-end LLM smoke script (requires API key)
