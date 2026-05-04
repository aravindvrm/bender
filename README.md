# Bender

Bender is a local-first AI software workspace for planning, execution, and review across real codebases.

It ships as one shared backend with multiple interfaces:
- CLI (`bender ...`)
- Web dashboard (`bender bend`)
- Electron desktop app (`npm run desktop:start`)

## Current Product Shape (Audited April 30, 2026)

- No-project home mode is first-class.
- Project state is optional at app boot (`/api/state` can return `projectRoot: null`).
- Chat now runs in the bottom **Operation Drawer** (not a standalone sidebar view).
- Chat threads are **scope-bound**:
  - Global scope (no project): persisted in `~/.bender/global-chat.db`
  - Project scope: persisted in `<project>/.bender/bender.db`
- Switching project scope invalidates thread IDs from the previous scope; stale IDs correctly return `404 Thread not found`.

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

Desktop app:

```bash
npm run desktop:start
```

## CLI Commands

- `bender init -d <dir>`: Initialize a new project (clarification -> architecture -> task plan)
- `bender analyze -d <dir>`: Analyze an existing codebase into `.bender/` state
- `bender plan "<description>" -d <dir>`: Plan a feature/change
- `bender implement -d <dir>`: Execute the current task plan
- `bender status -d <dir>`: Show project state/status
- `bender bend [-d <dir>]`: Start local dashboard server (aliases: `open`, `review`)
- `bender stop`: Stop dashboard server
- `bender eval-ci --suite <id> -d <dir>`: Run saved eval suite as CI gate

## Web Dashboard

Primary views in current UI:
- `Overview`
- `Agents`
- `Tasks`
- `Workflows`
- `Architecture`
- `Evals`
- `Settings`

When no project is selected:
- Home tiles show recent projects, new project, and clone entrypoint.
- Settings and Agents remain accessible.

### Chat UX

- Chat lives inside the Operation Drawer.
- New conversation shortcut: `Cmd/Ctrl+K`.
- Thread picker supports rename, archive/restore, delete.
- Slash commands differ by scope:
  - Global scope: open/clone/recent project helpers
  - Project scope: task/audit/analyze/plan-oriented commands

## Backend Architecture

Core server:
- Express API + static web host in `src/cli/server.ts`
- Health check: `GET /api/health` -> `{ ok: true }`
- Port resolution: `BENDER_PORT` -> `PORT` -> `3142`

Route domains (high-level):
- Project/session: `/api/state`, `/api/project`, `/api/projects`
- Chat: `/api/chat/*`
- Run pipeline + SSE: `/api/run/*`
- Tasks + task GitHub links: `/api/tasks/*`
- Workflows + workflow runs: `/api/workflows*`, `/api/workflow-runs*`
- Git + GitHub integration: `/api/git/*`, `/api/github/*`, `/api/github/work-items/*`
- LLM/config/connectors/themes/logs/evals/skills/agents

## Data Model and Persistence

Per-project data:
- `<project>/.bender/` artifacts (brief, architecture, tasks, logs, etc.)
- `<project>/.bender/bender.db` for structured local records

Global (machine/user) data:
- `~/.bender/bender-home.db` (home-level registry/settings)
- `~/.bender/global-chat.db` (chat threads/messages in no-project mode)

`BENDER_HOME_DIR` can override `~/.bender` (useful for tests/isolation).

## LLM Providers

Configured providers currently include:
- `anthropic`
- `openai`
- `google`
- `groq`
- `ollama`
- `local`
- `openai-compatible`

Model tiers are configured as `fast`, `default`, `strong`.

## Testing

Commands:

```bash
npm run test:unit
npm run test:integration
npm run test:e2e:smoke
npm run test:e2e:playwright
npm run test:harness
npm run test:harness:full
```

Audit snapshot from April 30, 2026:
- `test:integration`: passing
- `test:e2e:smoke`: passing
- `test:unit`: failing in `tests/unit/chat-store.test.ts` (stale constructor usage vs current `ChatStore` API)
- `test:e2e:playwright`: partially failing due UI contract drift (notably chat/drawer interactions and outdated heading/selector assumptions)

## Environment Variables

- `BENDER_PORT`: preferred backend port
- `PORT`: fallback backend port
- `BENDER_HOME_DIR`: override global Bender home directory
- `BENDER_PROJECT_DIR`: initial project path for desktop backend entrypoint
- `BENDER_NODE_BIN`: Node binary path for Electron backend spawn
- `BENDER_LOG_LEVEL`: log level override (`debug|info|warn|error`)

## Build and Packaging Scripts

- `npm run build`: CLI + web build
- `npm run build:cli`: CLI build only
- `npm run build:web`: web build only
- `npm run desktop:start`: launch Electron app
- `npm run desktop:backend`: run desktop backend entrypoint directly
- `npm run desktop:pack:dmg`: macOS DMG package
- `npm run desktop:pack:dir`: unpacked macOS app directory

## Notes for Contributors

- Do not assume an open project at startup.
- Treat chat thread IDs as scope-local (global vs project).
- If you switch project context in the UI, refresh or re-resolve active thread before send.
- Prefer updating tests alongside UI contract changes (especially Playwright selectors and drawer interactions).
