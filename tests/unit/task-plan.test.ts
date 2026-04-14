import { describe, expect, it } from "vitest";
import { appendTaskToPlan, buildTaskBlock, nextTaskId, parseTaskIds } from "../../src/state/task-plan.js";
import { parseTaskPlan } from "../../src/cli/implement.js";

describe("state/task-plan", () => {
  it("assigns task id 1 for an empty plan", () => {
    expect(nextTaskId("")).toBe(1);
    expect(nextTaskId("\n\n")).toBe(1);
  });

  it("parses existing task ids and increments max id", () => {
    const markdown = [
      "### Task 1: First",
      "- **Description**: a",
      "",
      "### Task 3: Third",
      "- **Description**: b",
    ].join("\n");

    expect(parseTaskIds(markdown)).toEqual([1, 3]);
    expect(nextTaskId(markdown)).toBe(4);
  });

  it("builds append blocks in parser-compatible task format", () => {
    const block = buildTaskBlock(7, "Fix flaky tests", "Repair instability in harness");
    const parsed = parseTaskPlan(block);

    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.id).toBe(7);
    expect(parsed[0]?.title).toBe("Fix flaky tests");
    expect(parsed[0]?.description).toContain("Repair instability");
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

    expect(first.taskId).toBe(1);
    expect(second.taskId).toBe(2);

    const parsed = parseTaskPlan(second.updatedMarkdown);
    expect(parsed).toHaveLength(2);
    expect(parsed.map((t) => t.id)).toEqual([1, 2]);
    expect(parsed[0]?.title).toBe("Fix test audit issue");
    expect(parsed[1]?.title).toBe("Harden CI step");
  });
});
