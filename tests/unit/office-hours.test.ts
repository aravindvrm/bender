import { describe, expect, it } from "vitest";
import { parseOfficeHoursVerdict } from "../../src/roles/office-hours.js";

describe("parseOfficeHoursVerdict", () => {
  it("parses supported verdict values", () => {
    expect(parseOfficeHoursVerdict("## Verdict\nVERDICT: SHIP_NOW")).toBe("SHIP_NOW");
    expect(parseOfficeHoursVerdict("VERDICT: SIMPLIFY_FIRST")).toBe("SIMPLIFY_FIRST");
    expect(parseOfficeHoursVerdict("VERDICT: VALIDATE_FIRST")).toBe("VALIDATE_FIRST");
    expect(parseOfficeHoursVerdict("VERDICT: DEFER")).toBe("DEFER");
    expect(parseOfficeHoursVerdict("VERDICT: KILL")).toBe("KILL");
  });

  it("returns null for unsupported or missing verdict", () => {
    expect(parseOfficeHoursVerdict("VERDICT: MAYBE")).toBeNull();
    expect(parseOfficeHoursVerdict("No verdict line")).toBeNull();
  });
});
