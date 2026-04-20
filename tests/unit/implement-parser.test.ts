import { describe, expect, it } from "vitest";
import { parseTaskPlan } from "../../src/cli/implement.js";

describe("cli/implement parseTaskPlan", () => {
  it("parses canonical task ids and acceptance criteria lists", () => {
    const markdown = [
      "### Task task-1: Add API tests",
      "- **Description**: Add endpoint coverage",
      "- **Acceptance criteria**:",
      "  - Tests pass",
      "  - No regressions",
    ].join("\n");

    const tasks = parseTaskPlan(markdown);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.id).toBe("task-1");
    expect(tasks[0]?.acceptanceCriteria).toEqual(["Tests pass", "No regressions"]);
  });

  it("migrates legacy numeric ids and single-line criteria", () => {
    const markdown = [
      "### Task 2: Placeholder task",
      "- **Description**: placeholder",
      "- **Acceptance criteria**: Done",
    ].join("\n");

    const tasks = parseTaskPlan(markdown);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.id).toBe("task-2");
    expect(tasks[0]?.acceptanceCriteria).toEqual(["Done"]);
  });
});
