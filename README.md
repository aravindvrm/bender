# Bender

Bender is a local-first AI engineering workspace for planning, implementation, review, and evals across real repositories.

It runs one shared backend across three interfaces:
- CLI (`bender ...`)
- Web dashboard (`bender bend`)
- Electron desktop app (`npm run desktop:start`)

## Core Capabilities

- Project lifecycle commands: `init`, `analyze`, `plan`, `implement`, `status`
- Role-based runtimes: analyzer, architect, planner, implementer, reviewer
- Task planning + execution with persisted state
- Built-in workflows with run history and API execution
- Promptfoo-backed eval compare and suite execution
- Skills catalog/library (curated + user + project packages)
- Git and GitHub integration (including issue extraction/import flows)
- Project-scoped and global chat with tool-backed operator actions
- Local SQLite persistence (no external database required)

## Product Shape

- No-project mode is first-class: the app can start with `projectRoot: null`.
- Home view supports recent projects, opening existing paths, creating a new project, and clone entrypoints.
- Chat runs in the bottom operation drawer (not a standalone sidebar page).
- Chat scope is explicit:
  - Global scope uses `~/.bender/global-chat.db`
  - Project scope uses `<project>/.bender/bender.db`

## Requirements

- Node.js `>=20`
- npm

## Quick Start

```bash
npm install
npm run build
npm run bend
```

Then open `http://localhost:3142` (or your configured port).

For desktop:

```bash
npm run desktop:start
```

## CLI Reference

- `bender init -d <dir>`: initialize a project (`.bender/`, brief, architecture, task plan)
- `bender analyze -d <dir>`: analyze an existing codebase into Bender state
- `bender plan "<description>" -d <dir>`: plan a feature/change for an initialized project
- `bender implement -d <dir>`: execute implementation pipeline for current plan/tasks
- `bender status -d <dir>`: show state, tasks, and recent decisions
- `bender bend [-d <dir>]`: run local dashboard server (aliases: `open`, `review`)
- `bender stop`: stop dashboard server
- `bender eval-ci --suite <suite-id> -d <dir>`: run eval suite as CI gate

## Web/Desktop UI

Primary views:
- `Overview`
- `Tasks`
- `Workflows`
- `Architecture`
- `Evals`
- `Agents`
- `Settings`

Behavior notes:
- Settings and Agents are available without an open project.
- Uninitialized projects show an explicit "Analyze Project" flow.
- The top bar includes current project context and diff summary panel toggles.

### Operation Drawer + Chat

- Chat, operation output, and terminal panel live in the bottom drawer.
- Thread lifecycle: create, rename, archive/restore, delete.
- Keyboard shortcut for new thread: `Cmd/Ctrl+K`.
- Chat supports deterministic command fallbacks and tool-backed actions.

## Workflows

Built-in workflow definitions are auto-seeded:
- `issue-extract-candidates`
- `task-to-implement`
- `review-current-changes`

API surface includes:
- `GET/PUT/DELETE /api/workflows/:id`
- `POST /api/workflows/:id/run`
- `GET /api/workflow-runs`
- `GET /api/workflow-runs/:runId`

## Evals

Evals are backed by Promptfoo and exposed through both API and UI:
- Eval tasks, configs, and suites CRUD
- Compare runs (`/api/run/evals/compare`)
- Suite runs (`/api/run/evals/suites/:suiteId`)
- Historical run inspection endpoints
- CI gating via `bender eval-ci`

## Backend and API

Core server: `src/cli/server.ts`

- Health endpoint: `GET /api/health` returns `{ ok: true }`
- Port resolution order: `BENDER_PORT` -> `PORT` -> `3142`
- Serves built web assets from `dist/web`
- Structured per-request logging with request IDs

High-level API domains:
- Project and state: `/api/project*`, `/api/projects*`, `/api/state`
- Chat: `/api/chat/*`
- Run operations and answer handling: `/api/run/*`
- Tasks and task-GitHub linking: `/api/tasks/*`
- Workflows and workflow runs: `/api/workflows*`, `/api/workflow-runs*`
- Git/GitHub: `/api/git/*`, `/api/github/*`, `/api/github/work-items/*`
- Skills, agents, connectors, LLM, config, logs, terminal, evals, themes

## Persistence Model

Per-project:
- `<project>/.bender/` artifacts (brief, architecture, tasks, logs, skills, etc.)
- `<project>/.bender/bender.db` (structured local records)

Global:
- `~/.bender/bender-home.db` (home-level settings/registry)
- `~/.bender/global-chat.db` (chat in no-project scope)

Override global home path with `BENDER_HOME_DIR`.

## LLM Providers

Supported providers:
- `anthropic`
- `openai`
- `google`
- `groq`
- `ollama`
- `local`
- `openai-compatible`

Tiers:
- `fast`
- `default`
- `strong`

`openai-compatible` and `local` include capability probing and endpoint fallback logic for local/self-hosted servers.

## Testing

```bash
npm run test:unit
npm run test:integration
npm run test:harness
npm run test:e2e:smoke
npm run test:e2e:playwright
npm run test:harness:full
```

## Build, Packaging, Release

- `npm run build`: build CLI + web
- `npm run build:cli`: build CLI only
- `npm run build:web`: build web only
- `npm run desktop:start`: launch Electron app
- `npm run desktop:backend`: run desktop backend entrypoint
- `npm run desktop:pack:dmg`: build macOS DMG into `dist-desktop/`
- `npm run desktop:pack:dir`: build unpacked macOS app into `dist-desktop/`

CI workflows:
- `.github/workflows/playwright-smoke.yml`
- `.github/workflows/desktop-dmg.yml`

## Environment Variables

- `BENDER_PORT`: preferred backend port
- `PORT`: fallback backend port
- `BENDER_HOME_DIR`: override default `~/.bender`
- `BENDER_PROJECT_DIR`: optional initial project path for desktop backend
- `BENDER_NODE_BIN`: explicit Node executable for desktop backend spawn
- `BENDER_LOG_LEVEL`: log-level override (`debug|info|warn|error`)

## Troubleshooting

- Backend health: check `GET /api/health`
- Logs: inspect `.bender/bender.log` and `/api/logs`
- Desktop backend startup failures: confirm Node path or set `BENDER_NODE_BIN`
- Local provider model detection issues: verify base URL/model and provider settings in `Settings`
