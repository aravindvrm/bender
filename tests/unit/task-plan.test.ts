import { describe, expect, it } from "vitest";
import {
  appendTaskToPlan,
  buildTaskBlock,
  nextTaskId,
  normalizeCanonicalTaskPlan,
  parseTaskIds,
  parseTaskPlanMarkdown,
  renderTaskPlanMarkdown,
  toCanonicalTaskPlan,
} from "../../src/state/task-plan.js";
import { parseTaskPlan } from "../../src/cli/implement.js";

describe("state/task-plan", () => {
  it("assigns task-1 for an empty plan", () => {
    expect(nextTaskId("")).toBe("task-1");
    expect(nextTaskId("\n\n")).toBe("task-1");
  });

  it("parses existing task ids and increments max id", () => {
    const markdown = [
      "### Task task-1: First",
      "- **Description**: a",
      "",
      "### Task 3: Third",
      "- **Description**: b",
    ].join("\n");

    expect(parseTaskIds(markdown)).toEqual(["task-1", "task-3"]);
    expect(nextTaskId(markdown)).toBe("task-4");
  });

  it("builds append blocks in parser-compatible task format", () => {
    const block = buildTaskBlock("task-7", "Fix flaky tests", "Repair instability in harness", ["Tests pass"], "implementer", "todo");
    const parsed = parseTaskPlan(block);

    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.id).toBe("task-7");
    expect(parsed[0]?.title).toBe("Fix flaky tests");
    expect(parsed[0]?.description).toContain("Repair instability");
    expect(parsed[0]?.acceptanceCriteria).toEqual(["Tests pass"]);
  });

  it("appends tasks and remains parseable by implement parser", () => {
    const first = appendTaskToPlan(null, {
      title: "Fix test audit issue",
      description: "Address missing integration checks",
    });
    const second = appendTaskToPlan(first.updatedMarkdown, {
      title: "Harden CI step",
      description: "Stabilize flaky pipeline path",
    });

    expect(first.taskId).toBe("task-1");
    expect(second.taskId).toBe("task-2");

    const parsed = parseTaskPlan(second.updatedMarkdown);
    expect(parsed).toHaveLength(2);
    expect(parsed.map((t) => t.id)).toEqual(["task-1", "task-2"]);
    expect(parsed[0]?.title).toBe("Fix test audit issue");
    expect(parsed[1]?.title).toBe("Harden CI step");
  });

  it("round-trips canonical task json from markdown", () => {
    const markdown = [
      "### Task 2: Add migrations",
      "- **Description**: add migration scripts",
      "- **Implementer Agent**: default-implementer",
      "- **Status**: in_progress",
      "- **Acceptance criteria**:",
      "  - migration runs locally",
      "  - rollback works",
    ].join("\n");

    const canonical = toCanonicalTaskPlan(markdown);
    expect(canonical.version).toBe(1);
    expect(canonical.tasks).toHaveLength(1);
    expect(canonical.tasks[0]?.id).toBe("task-2");
    expect(canonical.tasks[0]?.implementerAgentId).toBe("default-implementer");
    expect(canonical.tasks[0]?.status).toBe("in_progress");

    const rendered = renderTaskPlanMarkdown(canonical.tasks);
    const reparsed = parseTaskPlanMarkdown(rendered);
    expect(reparsed).toHaveLength(1);
    expect(reparsed[0]?.title).toBe("Add migrations");
    expect(reparsed[0]?.acceptanceCriteria).toEqual(["migration runs locally", "rollback works"]);
  });

  it("normalizes malformed canonical task json and migrates legacy ids", () => {
    const normalized = normalizeCanonicalTaskPlan({
      version: 7,
      generatedAt: "",
      tasks: [
        { id: 3, title: " Task title ", acceptanceCriteria: "", status: "nope", implementerAgentId: "" },
        { id: "bad", title: "skip me" },
      ],
    });

    expect(normalized).not.toBeNull();
    expect(normalized?.version).toBe(1);
    expect(normalized?.tasks).toHaveLength(1);
    expect(normalized?.tasks[0]).toMatchObject({
      id: "task-3",
      title: "Task title",
      implementerAgentId: "implementer",
      status: "todo",
    });
    expect(normalized?.tasks[0]?.acceptanceCriteria).toEqual(["Task implemented and tests pass"]);
  });
});
