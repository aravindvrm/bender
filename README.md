# Bender

Bender is a local AI software-factory tool: a CLI plus dashboard that analyzes a codebase, plans work, and executes tasks with persistent project state in `.bender/`.

## Requirements

- Node.js `>=20`
- npm

## Quick Start

```bash
npm install
npm run build
npm run bend
```

Optional global CLI usage:

```bash
npm link
bender bend
```

## Core Commands

- `bender bend` — start the local dashboard
- `bender init -d <dir>` — initialize a new project
- `bender analyze -d <dir>` — analyze an existing project
- `bender plan "<description>" -d <dir>` — generate a task plan
- `bender implement -d <dir>` — execute the active task plan
- `bender status -d <dir>` — show project status

`bender open` and `bender review` are supported aliases for `bender bend`.

## Dashboard Structure

- Sidebar: global controls + project views
- Main views: `Overview`, `Tasks`, `Architecture`, `Changes`, `Agents`, `Settings`
- Bottom panel: `Console` (read-only operation logs) and `Terminal`

## New Task / Project Flows

- New Project modal includes:
  - Directory picker + browser
  - Project description
  - Stack template choice (`nextjs-saas`, `express-api`, `auto`)
  - LLM setup when no key is configured
- New Task flow runs inside the modal and captures prompts/approvals there.

## Persistent State

Bender stores project data under `.bender/`, including:

- `brief.md`
- `architecture.md`
- `conventions.md`
- `schema.sql`
- `flows.md`
- `config.yaml`
- `tasks/current.md`
- `tasks/completed/*.md`
- `decisions/*.md`
- `sessions/*.md`
- `api-contracts/routes.yaml`

## Scripts

- `npm run build` — build CLI + web
- `npm run build:cli` — build CLI only
- `npm run build:web` — build web only
- `npm run dev` — TypeScript watch
- `npm run dev:web` — Vite dev server
- `npm run bend` — build CLI and run dashboard
- `npm run test` — full test harness
- `npm run test:unit` — unit tests
- `npm run test:integration` — integration tests

## Notes

- Bender is local-first: project files and `.bender/` state remain on your machine.
- API keys can be configured via Settings or environment variables.
