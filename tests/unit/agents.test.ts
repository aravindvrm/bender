import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BUILTIN_AGENTS,
  getAllAgents,
  getDefaultAgentForRole,
  getEffectiveAgentForRole,
  readCustomAgents,
  writeCustomAgents,
  writeRoleSelection,
  type AgentConfig,
} from "../../src/state/agents.js";
import { withTempHome, type TempHomeContext } from "../helpers/temp-env.js";

describe("state/agents", () => {
  let tempHome: TempHomeContext;

  beforeEach(async () => {
    tempHome = await withTempHome();
  });

  afterEach(async () => {
    await tempHome.restore();
  });

  it("exposes five built-in agents with pinned skills and MCP assignments", async () => {
    const all = await getAllAgents();
    const builtins = all.filter((a) => a.isBuiltin);
    expect(builtins).toHaveLength(5);
    expect(BUILTIN_AGENTS.map((a) => a.baseRole).sort()).toEqual(
      ["analyzer", "architect", "planner", "implementer", "reviewer"].sort(),
    );
    expect(builtins.every((a) => Array.isArray(a.pinnedSkills))).toBe(true);
    expect(builtins.every((a) => Array.isArray(a.mcpServerIds))).toBe(true);
  });

  it("persists custom agents", async () => {
    const customAgents: AgentConfig[] = [
      {
        id: "custom-planner",
        name: "Custom Planner",
        baseRole: "planner",
        modelTier: "fast",
        pinnedSkills: ["security-best-practices"],
        mcpServerIds: ["github"],
        systemPromptAddition: "Bias toward milestone-first plans.",
        isBuiltin: false,
      },
    ];

    await writeCustomAgents(customAgents);
    const readBack = await readCustomAgents();
    expect(readBack).toHaveLength(1);
    expect(readBack[0].id).toBe("custom-planner");
    expect(readBack[0].isBuiltin).toBe(false);
    expect(readBack[0].pinnedSkills).toEqual(["security-best-practices"]);
    expect(readBack[0].mcpServerIds).toEqual(["github"]);
  });

  it("resolves effective agent by priority preferred > selected role > builtin", async () => {
    const customPlanner: AgentConfig = {
      id: "custom-planner",
      name: "Custom Planner",
      baseRole: "planner",
      modelTier: "fast",
      pinnedSkills: [],
      mcpServerIds: ["github"],
      isBuiltin: false,
    };

    await writeCustomAgents([customPlanner]);
    await writeRoleSelection("planner", "custom-planner");

    const preferred = await getEffectiveAgentForRole("planner", "default-planner");
    expect(preferred.id).toBe("default-planner");

    const selected = await getEffectiveAgentForRole("planner", "not-real");
    expect(selected.id).toBe("custom-planner");

    await writeRoleSelection("planner", null);
    await writeCustomAgents([]);

    const fallback = await getEffectiveAgentForRole("planner");
    expect(fallback.id).toBe(getDefaultAgentForRole("planner").id);
  });
});
