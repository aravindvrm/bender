# Bender

Bender is a local AI software execution workspace for planning, implementation, review, and evaluation across real codebases.

Bender supports three first-class interfaces:

- CLI
- Browser WebUI
- Electron desktop app (thin shell over the same backend + WebUI)

## What Bender Includes

- Project workflows: `init`, `analyze`, `plan`, `implement`, `status`
- Role-based agents: analyzer, architect, planner, implementer, reviewer
- Custom agent overrides and role skill curation
- Skills system with curated catalog plus project/user extensions
- MCP connector configuration with capability-aware runtime behavior
- Git and GitHub integration, including project-scoped issue ingestion and task linking
- Promptfoo-backed eval compare/suite execution with CI gating
- Project chat panel with a fixed `Bender Operator` role, tool-backed actions, and deterministic command fallbacks
- Local-first embedded SQLite persistence (no Docker/Postgres requirement)

## Interfaces

- CLI: `bender ...`
- Browser dashboard: `bender bend` (aliases: `bender open`, `bender review`)
- Desktop: `npm run desktop:start`

## Architecture

### Backend

- Express server: [server.ts](/Volumes/SD3.2_256/Repos/bender/src/cli/server.ts)
- Health endpoint: `GET /api/health` returns `{ ok: true }`
- Port resolution order: `BENDER_PORT` → `PORT` → `3142` (default)

### Desktop wrapper

- Starts backend as a child process
- Waits for `/api/health` before loading UI
- Surfaces startup/crash errors in-app
- Handles default-port conflicts pragmatically
- Shuts down backend on app exit to avoid orphan processes
- Uses cross-platform process APIs (macOS/Windows/Linux)

## Persistence

Bender stores state locally in SQLite:

- Project DB: `.bender/bender.db`
- Home/global DB: `~/.bender/bender-home.db`

Project files under `.bender/` still include artifacts like `brief.md`, `architecture.md`, task files, and logs for reviewability/compatibility.

## Quick Start

### Requirements

- Node.js `>=20`
- npm

### Install

```bash
npm install
```

### Build

```bash
npm run build
```

### Run in browser

```bash
npm run bend
```

### Run desktop app

```bash
npm run desktop:start
```

### Install CLI globally (optional)

```bash
npm link
bender bend
```

## Core CLI Commands

- `bender bend` starts local backend/dashboard
- `bender stop` stops local dashboard server
- `bender init -d <dir>` initializes project state
- `bender analyze -d <dir>` analyzes existing repository state
- `bender plan "<description>" -d <dir>` generates/updates task plan
- `bender implement -d <dir>` executes active plan
- `bender status -d <dir>` prints project/task status
- `bender eval-ci --suite <suite-id> -d <dir>` runs saved eval suite as CI gate

## WebUI Areas

- Overview / Plan
- Architecture
- Changes (Git/GitHub helpers)
- Evals
- Agents
- Settings
- Console
- Chat (Bender Operator)

## Chat Operator

The chat panel is project-scoped and uses a fixed operator role. It supports:

- Normal conversational guidance
- Tool-backed actions (task list/add/update/delete/run, audits, analyze)
- Deterministic fallback commands when tool-calling is unavailable

Examples:

- `/task list`
- `/task add title: ...; description: ...`
- `/task update 3 title: ...`
- `/task run 3`
- `/audit security`
- `/analyze`

## LLM Providers

Bender is provider-agnostic and supports:

- `anthropic`
- `openai`
- `google`
- `groq`
- `ollama`
- `openai-compatible` (experimental)

Provider/model tiers (`fast`, `default`, `strong`) are configured in Settings and persisted per project/global scope.

### OpenAI-compatible local provider (experimental)

Use this for local/self-hosted OpenAI-shaped servers (for example LM Studio-compatible endpoints).

Settings fields:

- `provider`: `openai-compatible`
- `baseUrl`: required, e.g. `http://localhost:1234/v1`
- `model`: optional default model hint
- `apiKey`: optional bearer token
- `supportsTools`: optional capability override
- `supportsJson`: optional capability override
- `supportsStreaming`: optional capability override

Behavior notes:

- Bender normalizes host-only URLs (for example `100.102.218.63:7070` to `http://100.102.218.63:7070`)
- For compatibility, Bender can fall back between `/chat/completions` and `/responses` paths when server behavior is inconsistent
- Local capabilities are conservatively gated; unsupported features fail soft

## GitHub Integration

GitHub flows are project-scoped. Bender uses the currently open project and its linked repo.

Current capabilities include:

- Auth/linkage setup in Settings
- Issue listing/filtering for linked repo
- Role-based extraction (analyzer/architect/planner) into candidate tasks
- Review-and-import into task plan
- Task-to-issue linkage persistence

## Evals

Evals are backed by Promptfoo while preserving Bender-native entities and UI.

Supported now:

- Single task compare across multiple configs
- Saved suite execution/reports
- CI gating via `bender eval-ci`

## Environment Variables

- `BENDER_PORT`: preferred backend port
- `PORT`: secondary port fallback
- `BENDER_PROJECT_DIR`: optional initial project path for desktop backend entrypoint
- `BENDER_NODE_BIN`: optional Node executable path for Electron backend spawn
- `BENDER_LOG_LEVEL`: override minimum structured log level (`debug|info|warn|error`)

## Scripts

- `npm run build` build CLI + web
- `npm run build:cli` build CLI only
- `npm run build:web` build web only
- `npm run bend` build CLI + run dashboard
- `npm run desktop:start` build + launch desktop app
- `npm run desktop:backend` run desktop backend entrypoint only
- `npm run test` run harness tests
- `npm run test:unit` run unit tests
- `npm run test:integration` run integration tests
- `npm run test:harness` build CLI + unit + integration
- `npm run test:harness:full` harness + dashboard smoke
- `npm run test:e2e:smoke` dashboard smoke
- `npm run test:e2e:playwright` Playwright E2E
- `npm run test:e2e:playwright:headed` headed Playwright
- `npm run test:e2e:llm-smoke` LLM smoke

## Troubleshooting

- `Missing API key for provider ...`: verify provider keys in Settings for the active tier/provider
- Local provider URL errors (`Invalid URL`): include protocol or use host:port and let Bender normalize it
- Desktop native module mismatch (`better-sqlite3`): run `npm rebuild` after Node/Electron version changes
- GitHub MCP `401 Unauthorized`: refresh token/config in Settings
- For deep debugging, inspect `.bender/bender.log` and `GET /api/logs` (supports `limit`, `level`, `component`, `contains`, `sinceMs` query filters)
- Mermaid/UI render failures are reported into structured logs via `POST /api/logs/client`
