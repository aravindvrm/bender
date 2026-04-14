import { describe, expect, it } from "vitest";
import { parseFileOperations } from "../../src/roles/implementer.js";

describe("roles/implementer parseFileOperations", () => {
  it("parses strict FILE/ACTION fenced format", () => {
    const output = [
      "### FILE: src/app.ts",
      "ACTION: modify",
      "```ts",
      "export const x = 1;",
      "```",
    ].join("\n");

    const ops = parseFileOperations(output);
    expect(ops).toHaveLength(1);
    expect(ops[0]?.path).toBe("src/app.ts");
    expect(ops[0]?.action).toBe("modify");
    expect(ops[0]?.content).toContain("export const x = 1");
  });

  it("recovers from token-fragmented FILE/ACTION headers", () => {
    const output = [
      "###",
      " FILE",
      ":",
      " sable",
      "/tool",
      "_server",
      ".py",
      "",
      "ACTION",
      ":",
      " modify",
      "",
      "```",
      "python",
      "print('ok')",
      "```",
    ].join("\n");

    const ops = parseFileOperations(output);
    expect(ops).toHaveLength(1);
    expect(ops[0]?.path).toBe("sable/tool_server.py");
    expect(ops[0]?.action).toBe("modify");
    expect(ops[0]?.content).toContain("print('ok')");
  });
});
