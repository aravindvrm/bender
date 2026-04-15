import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
  appendSkillEvalRun,
  getSkillWorkbench,
  setSkillEvalCases,
  setSkillEvalRunFeedback,
} from "../../src/state/skill-workbench.js";
import { getBenderHomeDir } from "../../src/state/paths.js";
import { withTempHome, type TempHomeContext } from "../helpers/temp-env.js";

describe("state/skill-workbench sqlite-backed", () => {
  let tempHome: TempHomeContext;

  beforeEach(async () => {
    tempHome = await withTempHome();
  });

  afterEach(async () => {
    await tempHome.restore();
  });

  it("stores workbench state in sqlite and survives legacy json deletion", async () => {
    const skillId = "security-best-practices";

    await setSkillEvalCases(skillId, [
      { id: "case-1", prompt: "Check auth middleware" },
    ]);
    const runResult = await appendSkillEvalRun({
      id: "run-1",
      skillId,
      prompt: "Check auth middleware",
      withSkill: true,
      role: "reviewer",
      modelTier: "default",
      output: "Looks fine",
      createdAt: Date.now(),
    });
    expect(runResult.runs).toHaveLength(1);

    await setSkillEvalRunFeedback(skillId, "run-1", {
      pass: true,
      feedback: "Good",
    });

    const homeDir = getBenderHomeDir();
    const dbPath = join(homeDir, "bender-home.db");
    const filePath = join(homeDir, "skill-workbench.json");
    expect(existsSync(dbPath)).toBe(true);
    expect(existsSync(filePath)).toBe(true);

    await rm(filePath, { force: true });
    const loaded = await getSkillWorkbench(skillId);
    expect(loaded.cases).toHaveLength(1);
    expect(loaded.runs[0]?.id).toBe("run-1");
    expect(loaded.runs[0]?.pass).toBe(true);
  });
});

