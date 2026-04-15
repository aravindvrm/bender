import { describe, expect, it } from "vitest";
import { parseAuditResponse } from "../../src/cli/services/audits.js";

describe("audit response parser", () => {
  it("parses plain JSON payloads", () => {
    const parsed = parseAuditResponse(JSON.stringify({
      summary: "ok",
      issues: [{ id: "SEC-001", title: "Issue", severity: "high" }],
    }));
    expect(parsed.summary).toBe("ok");
    expect(parsed.issues?.[0]?.id).toBe("SEC-001");
  });

  it("parses fenced JSON payloads", () => {
    const parsed = parseAuditResponse([
      "```json",
      "{\"summary\":\"fenced\",\"issues\":[]}",
      "```",
    ].join("\n"));
    expect(parsed.summary).toBe("fenced");
    expect(parsed.issues).toEqual([]);
  });

  it("throws for invalid JSON payloads", () => {
    expect(() => parseAuditResponse("not-json")).toThrow("Audit returned invalid JSON");
  });
});

