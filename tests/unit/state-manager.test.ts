import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { StateManager, formatContextForPrompt } from "../../src/state/manager.js";
import { createTempDir } from "../helpers/temp-env.js";

describe("state/manager", () => {
  let projectRoot: string;
  let state: StateManager;

  beforeEach(async () => {
    projectRoot = await createTempDir("bender-project-state-");
    state = new StateManager(projectRoot);
    await state.init();
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it("creates expected .bender directory structure", () => {
    expect(existsSync(join(projectRoot, ".bender"))).toBe(true);
    expect(existsSync(join(projectRoot, ".bender", "decisions"))).toBe(true);
    expect(existsSync(join(projectRoot, ".bender", "tasks"))).toBe(true);
    expect(existsSync(join(projectRoot, ".bender", "tasks", "completed"))).toBe(true);
    expect(existsSync(join(projectRoot, ".bender", "api-contracts"))).toBe(true);
    expect(existsSync(join(projectRoot, ".bender", "sessions"))).toBe(true);
  });

  it("round-trips core project artifacts", async () => {
    await state.writeBrief("# Product Brief\n\nBrief text");
    await state.writeArchitecture("## Architecture\n\nArch text");
    await state.writeConventions("Use strict TypeScript.");
    await state.writeSchema("create table users(id text primary key);");
    await state.writeCurrentTasks("### Task 1: Ship");
    await state.writeApiContracts("openapi: 3.1.0");
    await state.writeFlows("flowchart TD\nA-->B");
    await state.writeDecision("001-adr.md", "# Decision 1");
    await state.writeSession("plan", "Session details");

    expect(await state.readBrief()).toContain("Brief text");
    expect(await state.readArchitecture()).toContain("Arch text");
    expect(await state.readConventions()).toContain("strict TypeScript");
    expect(await state.readSchema()).toContain("create table users");
    expect(await state.readCurrentTasks()).toContain("Task 1");
    expect(await state.readApiContracts()).toContain("openapi");
    expect(await state.readFlows()).toContain("flowchart");
    expect((await state.readDecisions()).length).toBe(1);
    expect((await state.readSessions()).length).toBe(1);
  });

  it("uses current.json as canonical task plan store while keeping markdown", async () => {
    await state.writeCurrentTasks([
      "### Task 1: Ship",
      "- **Description**: done",
      "- **Files to create/modify**:",
      "  - `src/index.ts`",
      "- **Dependencies**: None",
      "- **Acceptance criteria**: works",
    ].join("\n"));

    const jsonPath = join(projectRoot, ".bender", "tasks", "current.json");
    const mdPath = join(projectRoot, ".bender", "tasks", "current.md");
    expect(existsSync(jsonPath)).toBe(true);
    expect(existsSync(mdPath)).toBe(true);

    const json = JSON.parse(await readFile(jsonPath, "utf-8")) as { tasks?: Array<{ id?: number }> };
    expect(json.tasks?.[0]?.id).toBe(1);
    expect(await state.readCurrentTasks()).toContain("### Task 1: Ship");
  });

  it("migrates markdown-only task plan into canonical current.json", async () => {
    const tasksDir = join(projectRoot, ".bender", "tasks");
    const mdPath = join(tasksDir, "current.md");
    const jsonPath = join(tasksDir, "current.json");
    await writeFile(mdPath, [
      "### Task 4: Legacy plan",
      "- **Description**: from markdown",
      "- **Files to create/modify**:",
      "  - `legacy/file.ts`",
      "- **Dependencies**: None",
      "- **Acceptance criteria**: migrated",
    ].join("\n"), "utf-8");

    expect(existsSync(jsonPath)).toBe(false);
    const markdown = await state.readCurrentTasks();
    expect(markdown).toContain("Legacy plan");
    expect(existsSync(jsonPath)).toBe(true);

    const json = JSON.parse(await readFile(jsonPath, "utf-8")) as { tasks?: Array<{ id?: number; title?: string }> };
    expect(json.tasks?.[0]).toMatchObject({ id: 4, title: "Legacy plan" });
  });

  it("recovers from corrupted current.json by falling back to markdown", async () => {
    const tasksDir = join(projectRoot, ".bender", "tasks");
    const mdPath = join(tasksDir, "current.md");
    const jsonPath = join(tasksDir, "current.json");
    await writeFile(mdPath, [
      "### Task 2: Markdown fallback",
      "- **Description**: valid markdown source",
      "- **Files to create/modify**:",
      "  - `src/fallback.ts`",
      "- **Dependencies**: None",
      "- **Acceptance criteria**: recovered",
    ].join("\n"), "utf-8");
    await writeFile(jsonPath, "{ invalid json", "utf-8");

    const markdown = await state.readCurrentTasks();
    expect(markdown).toContain("Markdown fallback");

    const repaired = JSON.parse(await readFile(jsonPath, "utf-8")) as { tasks?: Array<{ id?: number; title?: string }> };
    expect(repaired.tasks?.[0]).toMatchObject({ id: 2, title: "Markdown fallback" });
  });

  it("manages per-task agent assignments", async () => {
    await state.setTaskAgent("task-1", "custom-agent");
    await state.setTaskAgent("task-2", "reviewer-agent");
    expect(await state.readTaskAgents()).toEqual({
      "task-1": "custom-agent",
      "task-2": "reviewer-agent",
    });

    await state.setTaskAgent("task-1", null);
    expect(await state.readTaskAgents()).toEqual({
      "task-2": "reviewer-agent",
    });
  });

  it("formats gathered context into prompt-friendly sections", async () => {
    await state.writeBrief("# Product Brief: Bender\n\n## Overview\n\nTest");
    await state.writeArchitecture("## Architecture\n\nNode + React");
    await state.writeConventions("Keep functions pure when possible.");
    await state.writeSchema("create table tasks(id text primary key);");
    await state.writeCurrentTasks("### Task 1: Add harness");
    await state.writeApiContracts("openapi: 3.1.0");
    await state.writeDecision("001-adr.md", "# Prefer local-first");

    const context = await state.gatherContext();
    const prompt = formatContextForPrompt(context);

    expect(prompt).toContain("# Project Context");
    expect(prompt).toContain("## Product Brief");
    expect(prompt).toContain("## Architecture");
    expect(prompt).toContain("## Coding Conventions");
    expect(prompt).toContain("## Database Schema");
    expect(prompt).toContain("## Architecture Decisions");
    expect(prompt).toContain("## API Contracts");
    expect(prompt).toContain("## Current Task Plan");
  });
});
