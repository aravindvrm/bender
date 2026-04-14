import { describe, expect, it } from "vitest";
import {
  hasCapability,
  normalizeCapabilityPolicy,
  resolveCapabilities,
  resolveConnectorAccess,
} from "../../src/state/capabilities.js";
import type { McpServerConfig } from "../../src/state/config.js";

describe("state/capabilities", () => {
  const servers: McpServerConfig[] = [
    { id: "github", name: "GitHub", url: "https://api.githubcopilot.com/mcp/" },
    { id: "figma", name: "Figma", url: "https://mcp.figma.com/mcp" },
    { id: "neon", name: "Neon", url: "https://mcp.neon.tech/mcp" },
  ];

  it("normalizes capability policy and drops unknown values", () => {
    const policy = normalizeCapabilityPolicy({
      allow: ["github.repo.read", "connector.github.use", "bad.capability"],
      deny: ["github.repo.write", "??"],
    });
    expect(policy).toEqual({
      allow: ["github.repo.read", "connector.github.use"],
      deny: ["github.repo.write"],
    });
  });

  it("derives github capabilities from legacy mcpServerIds", () => {
    const resolved = resolveCapabilities({ mcpServerIds: ["github"] });
    expect(hasCapability(resolved, "connector.github.use")).toBe(true);
    expect(hasCapability(resolved, "github.repo.read")).toBe(true);
    expect(hasCapability(resolved, "github.branch.manage")).toBe(true);
  });

  it("applies deny overrides over allow", () => {
    const resolved = resolveCapabilities({
      capabilityPolicy: {
        allow: ["connector.github.use", "github.repo.read", "github.repo.write"],
        deny: ["github.repo.write"],
      },
    });
    expect(hasCapability(resolved, "github.repo.read")).toBe(true);
    expect(hasCapability(resolved, "github.repo.write")).toBe(false);
  });

  it("resolves allowed connectors from policy + legacy compatibility", () => {
    const result = resolveConnectorAccess(
      {
        mcpServerIds: ["github"],
        capabilityPolicy: {
          allow: ["connector.figma.use"],
          deny: ["connector.github.use"],
        },
      },
      servers,
    );

    expect(result.allowedConnectorIds.has("github")).toBe(false);
    expect(result.allowedConnectorIds.has("figma")).toBe(true);
    expect(result.allowedConnectorIds.has("neon")).toBe(false);
  });
});

