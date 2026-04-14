import { describe, expect, it } from "vitest";
import { parseTaskPlan } from "../../src/cli/implement.js";

describe("cli/implement parseTaskPlan", () => {
  it("parses file targets from plain bullet list when backticks are absent", () => {
    const markdown = [
      "### Task 1: Add API tests",
      "- **Description**: Add endpoint coverage",
      "- **Files to create/modify**:",
      "  - tests/api/test_endpoints.py",
      "  - sable/tool_server.py",
      "- **Dependencies**: None",
      "- **Acceptance criteria**: Tests pass",
    ].join("\n");

    const tasks = parseTaskPlan(markdown);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.files).toEqual([
      "tests/api/test_endpoints.py",
      "sable/tool_server.py",
    ]);
  });

  it("ignores placeholder file bullets", () => {
    const markdown = [
      "### Task 2: Placeholder task",
      "- **Description**: placeholder",
      "- **Files to create/modify**:",
      "  - (to be determined)",
      "- **Dependencies**: None",
      "- **Acceptance criteria**: Done",
    ].join("\n");

    const tasks = parseTaskPlan(markdown);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.files).toEqual([]);
  });
});
