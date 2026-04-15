import { describe, expect, it } from "vitest";
import {
  getRoleDefaultPinnedSkills,
  getRoleRuntimeBaselineSkills,
} from "../../src/state/role-skill-defaults.js";

const ROLES = ["analyzer", "architect", "planner", "implementer", "reviewer"] as const;

describe("state/role-skill-defaults", () => {
  it("provides non-empty pinned skill defaults for all roles", () => {
    for (const role of ROLES) {
      const pinned = getRoleDefaultPinnedSkills(role);
      expect(pinned.length).toBeGreaterThan(0);
      expect(new Set(pinned).size).toBe(pinned.length);
    }
  });

  it("provides baseline runtime pools that include pinned defaults", () => {
    for (const role of ROLES) {
      const pinned = getRoleDefaultPinnedSkills(role);
      const baseline = getRoleRuntimeBaselineSkills(role);
      expect(baseline.length).toBeGreaterThanOrEqual(pinned.length);
      for (const skill of pinned) {
        expect(baseline.includes(skill)).toBe(true);
      }
      expect(new Set(baseline).size).toBe(baseline.length);
    }
  });
});

