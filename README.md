# Bender

Bender is a local AI software execution workspace for planning, implementing, reviewing, and evaluating real project work.

It supports three first-class interfaces:

- CLI
- Browser WebUI
- Electron desktop app (thin wrapper over the same backend + WebUI)

## What Bender Includes

- Project-aware planning and implementation workflows (`init`, `analyze`, `plan`, `implement`, `status`)
- Role-based agent system (analyzer, architect, planner, implementer, reviewer) with custom agent overrides
- Skills system with curated catalog + local project/user library extension
- MCP connector configuration and capability policy controls
- Git and GitHub integration:
  - GitHub auth/session + repo workflows
  - project-scoped GitHub issue ingestion
  - role-based extraction (analyzer/architect/planner)
  - review-and-import into task plan with task↔issue linking
- Evals system backed by Promptfoo (single compares + saved suites + CI gating)
- Local-first persistence using embedded SQLite (no Docker/Postgres required)

## Architecture (Current)

### Interfaces

- CLI: `bender ...`
- Browser: `bender bend` (or `open` / `review`)
- Desktop: `npm run desktop:start`

### Backend

- Express API server (`src/cli/server.ts`) shared by browser and Electron
- Health endpoint: `GET /api/health` → `{ ok: true }`
- Port resolution:
  - `BENDER_PORT`
  - fallback `PORT`
  - default `3142`

### Desktop Wrapper

Electron wrapper behavior:

- starts backend as child process
- waits for `/api/health` before loading UI
- handles backend startup failure/crash with visible status screens
- handles port conflicts pragmatically (auto-pick for default-port conflicts, explicit-port conflicts fail clearly)
- kills backend on quit to avoid orphans
- uses cross-platform process APIs

## Persistence

Bender persists data locally in two SQLite stores:

- Project-scoped: `.bender/bender.db`
- Home/global-scoped: `~/.bender/bender-home.db`

Legacy file compatibility is preserved where needed, but SQLite is the primary persistence layer.

Typical project state under `.bender/`:

```text
.bender/
  bender.db
  brief.md
  architecture.md
  conventions.md
  schema.sql
  flows.md
  config.yaml
  decisions/
  tasks/
  api-contracts/
  sessions/
```

## Core CLI Commands

- `bender bend`  
  Start local server and open dashboard flow.

- `bender open` / `bender review`  
  Aliases for `bender bend`.

- `bender stop`  
  Stop local dashboard server.

- `bender init -d <dir>`  
  Initialize new project state.

- `bender analyze -d <dir>`  
  Analyze existing codebase into Bender state.

- `bender plan "<description>" -d <dir>`  
  Create/update task plan.

- `bender implement -d <dir>`  
  Execute active task plan.

- `bender status -d <dir>`  
  Show project/task status.

- `bender eval-ci --suite <suite-id> -d <dir>`  
  Run saved eval suite as CI quality gate.

## WebUI Areas

- Overview / Plan
- Architecture (docs, schema, flows, decisions, API contracts)
- Changes (git + GitHub helpers)
- Evals (Promptfoo-backed compare/suite runs)
- Agents (builtin + custom agent configuration)
- Settings (providers, GitHub auth/config, MCP connectors, skills)
- Console (streamed operation output)

## Setup

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

### Run (Browser)

```bash
npm run bend
```

### Run (Electron Desktop)

```bash
npm run desktop:start
```

### Install CLI Globally

```bash
npm link
bender bend
```

## Environment Variables

- `BENDER_PORT`  
  Preferred backend port.

- `PORT`  
  Secondary backend port fallback.

- `BENDER_PROJECT_DIR`  
  Optional initial project path for desktop backend entrypoint.

- `BENDER_NODE_BIN`  
  Optional Node executable path used by Electron to spawn backend (useful when Node is not on PATH in desktop envs).

## NPM Scripts

- `npm run build` — build CLI + web
- `npm run build:cli` — build CLI only
- `npm run build:web` — build web only
- `npm run dev` — TypeScript watch
- `npm run dev:web` — Vite dev server
- `npm run bend` — build CLI + run dashboard server
- `npm run desktop:start` — build + launch Electron wrapper
- `npm run desktop:dev` — alias for desktop start
- `npm run desktop:backend` — run desktop backend entrypoint only
- `npm run test` — harness tests
- `npm run test:unit` — unit tests
- `npm run test:integration` — integration tests
- `npm run test:harness` — build CLI + unit + integration
- `npm run test:harness:full` — harness + dashboard smoke
- `npm run test:e2e:smoke` — dashboard smoke
- `npm run test:e2e:playwright` — Playwright E2E
- `npm run test:e2e:playwright:headed` — headed Playwright
- `npm run test:e2e:llm-smoke` — LLM smoke

## Eval CI Example

```bash
bender eval-ci \
  --suite <suite-id> \
  --min-success-rate 0.9 \
  --max-median-latency-ms 2000 \
  --max-average-cost-usd 0.01 \
  -d .
```

Exits non-zero when thresholds are violated.
