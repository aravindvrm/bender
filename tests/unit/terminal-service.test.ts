import { describe, expect, it } from "vitest";
import { validateTerminalCommand } from "../../src/cli/services/terminal.js";

describe("cli/services/terminal", () => {
  it("flags dangerous commands", () => {
    const result = validateTerminalCommand("rm -rf /tmp/foo");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.dangerous).toBe(true);
    }
  });

  it("does not flag normal commands", () => {
    const result = validateTerminalCommand("npm run test");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.dangerous).toBe(false);
    }
  });
});
