# Bender

Bender is a local AI agent workspace for planning, implementing, and tracking software work.

It combines a CLI, a browser dashboard, and an optional Electron desktop shell to analyze codebases, persist project context in `.bender/`, and execute work through custom agents, reusable skills, and MCP-connected tools.

## Why Bender

Bender is built for project-aware execution, not one-off code generation.

It helps you work against a real codebase by combining:

- persistent local project memory
- task planning and implementation workflows
- custom agents that can be assigned to tasks
- reusable skills
- MCP server integration for external tools and systems
- a local dashboard for visibility, review, and control

The result is a workspace where AI agents can operate with more structure, more context, and better tool access.

## Core Concepts

### Persistent Project State

Bender stores structured project state under `.bender/`, including architecture, conventions, flows, decisions, contracts, tasks, and session history. This gives agents durable context across runs.

### Custom Agents

Bender lets you build custom agents from providers, models, skills, MCP connectors, and prompts, then save and assign them to specific tasks.

### Skills

Bender can inject reusable skill context from configured markdown or text sources. Skills let you package instructions, workflows, and domain-specific guidance so agents can execute tasks consistently.

### MCP Integration

Bender supports MCP server configuration so agents can access external tools and systems at runtime. This creates a path for integrating things like filesystem access, GitHub, databases, or other tool servers into task execution.

## What Bender Does

Bender helps you work against a real project directory by maintaining structured project state, including:

- project brief
- architecture and conventions
- schema and flows
- decisions and API contracts
- active and completed tasks
- session history and runtime config

All project state is stored locally under `.bender/`.

## Core Commands

- `bender bend`  
  Open the local dashboard.

- `bender open` / `bender review`  
  Aliases for `bender bend`.

- `bender init -d <dir>`  
  Initialize `.bender/` state for a project.

- `bender analyze -d <dir>`  
  Analyze an existing codebase and generate project state.

- `bender plan "<description>" -d <dir>`  
  Create a new task plan.

- `bender implement -d <dir>`  
  Execute the active task plan.

- `bender status -d <dir>`  
  Show current project status.

- `bender eval-ci --suite <suite-id> -d <dir>`  
  Run a saved eval suite as a CI gate (Promptfoo-backed), with optional thresholds for success rate, latency, and cost.

## Dashboard

The local dashboard is organized around project execution:

- **Overview** — high-level project status
- **Tasks** — active and completed work
- **Architecture** — architecture, schema, flows, decisions, and conventions
- **Changes** — tracked project modifications
- **Console** — streamed execution output, prompts, and confirmations

## Project Initialization

`bender init` supports a guided new-project flow with:

- target directory selection and validation
- required project description
- optional stack quick-pick:
  - `Next.js SaaS`
  - `Express API`
  - `Let AI Decide`
- provider/API key setup when required

## Architecture Support

Bender can persist and render project architecture artifacts, including:

- architecture documentation
- conventions
- SQL schema
- Mermaid ERD generation from SQL
- Mermaid flow generation
- architectural decisions
- API contracts

Generated flows are persisted to `.bender/flows.md`.

## Runtime and Integrations

Bender supports:

- per-provider API key configuration for:
  - `anthropic`
  - `openai`
  - `google`
  - `groq`
  - `ollama`
- environment variable fallback for provider credentials
- MCP server configuration in Settings
- provider-specific MCP tool wiring
- skills context injection from configured markdown or text files
- custom agent composition and task assignment

## Project State

Bender stores project state under `.bender/`, including:

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

`bender.db` is the embedded local SQLite store used for project-scoped state/query persistence.
Global/home-scoped state is stored in `~/.bender/bender-home.db`.
No external server (Docker/Postgres) is required.

## Installation

### Requirements

- Node.js `>=20`
- npm

### Install and Build

```bash
npm install
npm run build
```

### Run the Dashboard

```bash
npm run bend
```

### Run the Desktop App (Electron Wrapper)

```bash
npm run desktop:start
```

The Electron app is a thin shell over the same local backend + WebUI used by CLI/browser workflows.
CLI and browser usage remain fully supported.
Desktop lifecycle uses cross-platform Node/Electron APIs for backend spawn/shutdown.
Installer/signing/notarization workflow is intentionally out of scope for now.

### Install the CLI Globally

```bash
npm link
bender bend
```

## Development Scripts

- `npm run build` — build CLI and web
- `npm run build:cli` — build CLI only
- `npm run build:web` — build web only
- `npm run dev` — TypeScript watch mode
- `npm run dev:web` — Vite dev server
- `npm run bend` — build CLI and run `bender bend`
- `npm run desktop:start` — build CLI/web and launch Electron desktop wrapper
- `npm run desktop:dev` — alias for `desktop:start`
- `npm run desktop:backend` — build CLI and run desktop backend entrypoint only
- `npm run test` — full test suite
- `npm run test:unit` — unit tests
- `npm run test:integration` — CLI integration smoke tests
- `npm run test:e2e:smoke` — end-to-end LLM smoke test (requires API key)

## Eval CI Gate

Use saved eval suites as repeatable quality gates in CI:

```bash
bender eval-ci \
  --suite <suite-id> \
  --min-success-rate 0.9 \
  --max-median-latency-ms 2000 \
  --max-average-cost-usd 0.01 \
  -d .
```

This command exits non-zero when thresholds are violated.

## Backend Port Configuration

Bender backend port can be configured with:

- `BENDER_PORT`
- `PORT` (fallback)

If neither is set, Bender defaults to `3142`.
