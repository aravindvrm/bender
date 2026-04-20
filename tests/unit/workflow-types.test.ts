import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { StateManager } from "../../src/state/manager.js";
import type { WorkflowDefinition, WorkflowRun } from "../../src/workflows/types.js";
import { createTempDir } from "../helpers/temp-env.js";

describe("workflows/types + state persistence", () => {
  let projectRoot: string;
  let state: StateManager;

  beforeEach(async () => {
    projectRoot = await createTempDir("bender-workflow-types-");
    state = new StateManager(projectRoot);
    await state.init();
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it("round-trips workflow definitions including acceptanceCriteria", async () => {
    const now = Date.now();
    const definition: WorkflowDefinition = {
      id: "wf-custom",
      name: "Custom Workflow",
      description: "Test definition",
      acceptanceCriteria: [
        "Workflow can be persisted",
        "Acceptance criteria are retained",
      ],
      version: 1,
      enabled: true,
      steps: [
        {
          id: "step-1",
          type: "prompt",
          name: "Prompt",
          config: { template: "Hello" },
        },
      ],
      createdAt: now,
      updatedAt: now,
    };

    await state.writeWorkflow(definition);
    const readBack = await state.readWorkflow("wf-custom");
    expect(readBack).not.toBeNull();
    expect(readBack?.acceptanceCriteria).toEqual(definition.acceptanceCriteria);
    expect(readBack?.steps).toHaveLength(1);

    const all = await state.readWorkflows();
    expect(all.some((workflow) => workflow.id === "wf-custom")).toBe(true);
  });

  it("round-trips workflow runs and supports workflowId filtering", async () => {
    const now = Date.now();
    const runA: WorkflowRun = {
      id: "run-a",
      workflowId: "wf-a",
      status: "completed",
      input: { value: 1 },
      output: { ok: true },
      startedAt: now - 10,
      finishedAt: now,
      steps: [
        {
          stepId: "step-1",
          type: "prompt",
          status: "completed",
          startedAt: now - 9,
          finishedAt: now - 8,
          output: { prompt: "x" },
        },
      ],
    };
    const runB: WorkflowRun = {
      id: "run-b",
      workflowId: "wf-b",
      status: "failed",
      input: {},
      error: "boom",
      startedAt: now - 5,
      finishedAt: now - 4,
      steps: [],
    };

    await state.writeWorkflowRun(runA);
    await state.writeWorkflowRun(runB);

    const byId = await state.readWorkflowRun("run-a");
    expect(byId?.workflowId).toBe("wf-a");
    expect(byId?.status).toBe("completed");

    const allRuns = await state.readWorkflowRuns();
    expect(allRuns.map((run) => run.id)).toEqual(["run-a", "run-b"]);

    const filtered = await state.readWorkflowRuns("wf-a");
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.id).toBe("run-a");
  });
});
