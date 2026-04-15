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

  it("preserves explicit file targets when appending", () => {
    const appended = appendTaskToPlan(null, {
      title: "Add API route tests",
      description: "Cover ping and OpenAPI routes",
      files: ["tests/api/test_routes.py", "sable/tool_server.py"],
    });

    const parsed = parseTaskPlan(appended.updatedMarkdown);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.files).toEqual([
      "tests/api/test_routes.py",
      "sable/tool_server.py",
    ]);
  });

  it("round-trips canonical task json from markdown", () => {
    const markdown = [
      "### Task 2: Add migrations",
      "- **Description**: add migration scripts",
      "- **Files to create/modify**:",
      "  - `db/migrations/001.sql`",
      "- **Dependencies**: 1",
      "- **Acceptance criteria**: migration runs locally",
    ].join("\n");

    const canonical = toCanonicalTaskPlan(markdown);
    expect(canonical.version).toBe(1);
    expect(canonical.tasks).toHaveLength(1);
    expect(canonical.tasks[0]?.id).toBe(2);
    expect(canonical.tasks[0]?.dependencies).toBe("1");

    const rendered = renderTaskPlanMarkdown(canonical.tasks);
    const reparsed = parseTaskPlanMarkdown(rendered);
    expect(reparsed).toHaveLength(1);
    expect(reparsed[0]?.title).toBe("Add migrations");
    expect(reparsed[0]?.files).toEqual(["db/migrations/001.sql"]);
  });

  it("normalizes malformed canonical task json", () => {
    const normalized = normalizeCanonicalTaskPlan({
      version: 7,
      generatedAt: "",
      tasks: [
        { id: 3, title: " Task title ", files: [" a.ts ", ""], dependencies: "", acceptanceCriteria: "" },
        { id: "bad", title: "skip me" },
      ],
    });

    expect(normalized).not.toBeNull();
    expect(normalized?.version).toBe(1);
    expect(normalized?.tasks).toHaveLength(1);
    expect(normalized?.tasks[0]).toMatchObject({
      id: 3,
      title: "Task title",
      files: ["a.ts"],
      dependencies: "None",
    });
  });
});
