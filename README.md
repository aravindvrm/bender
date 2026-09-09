# Bender

A local-first AI engineering workspace — CLI, web dashboard, and desktop app on a
single backend — built to work through agent architecture properly rather than
read about it.

**Status: exploratory, dormant.** This was a learning project: how do you
decompose coding work across specialised agents, attach tools and skills to them,
and — the part most agent tooling skips — *measure whether the output is any
good?* It runs, it is tested, and it is not a maintained product.

```
49,000 lines TypeScript · 156 source modules · 63 test files · 8 role runtimes
```

---

## What it explores

**Role decomposition instead of one large agent.** Eight runtimes with distinct
prompts, tools and skill defaults — `analyzer`, `architect`, `clarifier`,
`flowcharter`, `planner`, `implementer`, `reviewer`, `office-hours` — sharing a
common `base`. A plan produced by the architect is executed by the implementer
and checked by the reviewer, each with its own context rather than one thread
accumulating everything.

**Evals as a first-class subsystem, not an afterthought.** `src/evals/` is a
runner, a scorer and an aggregator, wired to Promptfoo and exposed through both
the API and the UI. `bender eval-ci --suite <id>` runs a suite as a CI gate, so a
prompt change that scores worse can fail a build. Most agent tooling ships on
vibes; this was an attempt not to.

**Skills and MCP as attachable capability.** Skills come from three sources
(curated, user, project) with per-role defaults, and agents carry
`mcpServerIds` pointing at a registry of MCP servers validated at runtime. The
question being explored: what belongs in a prompt, what belongs in a tool, and
what belongs in a skill package?

**One backend, three surfaces.** The CLI, the web dashboard and the Electron app
are clients of the same Express server and the same SQLite state, rather than
three implementations that drift. Adding a capability once makes it available in
all three.

**Local-first throughout.** SQLite for state (`better-sqlite3`), the OS keyring
for API credentials (`@napi-rs/keyring`), no external database and no hosted
component. Provider abstraction over the Vercel AI SDK covers Anthropic, OpenAI,
Google, Groq, Ollama and any OpenAI-compatible endpoint, in `fast` / `default` /
`strong` tiers.

---

## Quick start

Requires Node `>=20`.

```bash
npm install
npm run build
npm run bend          # dashboard at http://localhost:3142
npm run desktop:start # or the Electron app
```

## CLI

```
bender init      -d <dir>   scaffold .bender/ — brief, architecture, task plan
bender analyze   -d <dir>   read an existing codebase into Bender state
bender plan "…"  -d <dir>   plan a change against that state
bender implement -d <dir>   run the implementation pipeline for the current plan
bender status    -d <dir>   state, tasks, recent decisions
bender bend      [-d <dir>] start the dashboard
bender eval-ci --suite <id> run an eval suite as a CI gate
```

## Layout

```
src/roles/      the eight role runtimes, on a shared base
src/evals/      runner, scoring, aggregation — Promptfoo-backed
src/llm/        provider abstraction, tiers, MCP server wiring
src/state/      SQLite persistence, skills, skill packages, secrets
src/cli/        Express server, 22 route modules, commands
src/web/        React dashboard
src/desktop/    Electron main + backend spawn
tests/          38 unit, 18 integration
```

State lives in `<project>/.bender/` per project and `~/.bender/` globally;
`BENDER_HOME_DIR` overrides the latter.

## Tests

```bash
npm run test:unit
npm run test:integration
npm run test:e2e:playwright
```

---

## What I would do differently

The three-surface decision was the expensive one. A shared backend keeps the
clients honest, but it also means every capability needs three presentations, and
the Electron packaging in particular consumed time that the CLI and web app
together would not have.

The eval subsystem is the part worth keeping. Scoring agent output is the
difficult and interesting problem, and it is the piece that generalises beyond
this codebase.

## Configuration

| variable | purpose |
|---|---|
| `BENDER_PORT` / `PORT` | backend port (default `3142`) |
| `BENDER_HOME_DIR` | override `~/.bender` |
| `BENDER_NODE_BIN` | explicit Node binary for the desktop backend |
| `BENDER_LOG_LEVEL` | `debug` / `info` / `warn` / `error` |

API credentials are stored in the OS keyring, never in the repository or in
environment files.
