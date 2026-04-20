import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { StateManager } from "../../src/state/manager.js";
import { runWorkflow } from "../../src/workflows/runner.js";
import type { WorkflowDefinition } from "../../src/workflows/types.js";
import { createTempDir } from "../helpers/temp-env.js";

describe("workflows/runner", () => {
  let projectRoot: string;
  let state: StateManager;

  beforeEach(async () => {
    projectRoot = await createTempDir("bender-workflow-runner-");
    state = new StateManager(projectRoot);
    await state.init();
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it("executes sequentially and skips the immediate next step on false condition", async () => {
    const now = Date.now();
    const workflow: WorkflowDefinition = {
      id: "wf-condition",
      name: "Condition workflow",
      version: 1,
      enabled: true,
      steps: [
        {
          id: "s1",
          type: "prompt",
          name: "Start",
          config: { template: "begin" },
        },
        {
          id: "s2",
          type: "condition",
          name: "Gate",
          config: { field: "input.shouldRun", equals: true },
        },
        {
          id: "s3",
          type: "prompt",
          name: "Skipped",
          config: { template: "should not run" },
        },
        {
          id: "s4",
          type: "response",
          name: "Done",
          config: { template: "finished={{input.shouldRun}}" },
        },
      ],
      createdAt: now,
      updatedAt: now,
    };

    const run = await runWorkflow(projectRoot, workflow, { shouldRun: false });
    expect(run.status).toBe("completed");
    expect(run.steps.map((step) => step.status)).toEqual([
      "completed",
      "completed",
      "skipped",
      "completed",
    ]);
    expect(run.output?.message).toBe("finished=false");

    const persisted = await state.readWorkflowRun(run.id);
    expect(persisted?.status).toBe("completed");
    expect(persisted?.steps[2]?.status).toBe("skipped");
  });

  it("propagates failed step status and stops execution", async () => {
    const now = Date.now();
    const workflow: WorkflowDefinition = {
      id: "wf-fail",
      name: "Failure workflow",
      version: 1,
      enabled: true,
      steps: [
        {
          id: "a1",
          type: "action",
          name: "Bad action",
          config: { action: "not-supported" },
        },
        {
          id: "a2",
          type: "response",
          name: "Never reached",
          config: { template: "nope" },
        },
      ],
      createdAt: now,
      updatedAt: now,
    };

    const run = await runWorkflow(projectRoot, workflow, {});
    expect(run.status).toBe("failed");
    expect(run.error).toContain("Step 'a1' failed");
    expect(run.steps).toHaveLength(1);
    expect(run.steps[0]?.status).toBe("failed");
  });
});

