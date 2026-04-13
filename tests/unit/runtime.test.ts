import { describe, expect, it } from "vitest";
import { createRoleRuntime } from "../../src/llm/runtime.js";
import { DEFAULT_CONFIG, type BenderConfig } from "../../src/state/config.js";

function buildConfig(): BenderConfig {
  const config = structuredClone(DEFAULT_CONFIG);
  config.skills = {
    enabled: false,
    enabledSkills: [],
    paths: [],
    maxChars: 12000,
  };
  return config;
}

describe("llm/runtime", () => {
  it("enables OpenAI MCP tools when connectors are configured", async () => {
    const config = buildConfig();
    config.llm.provider = "openai";
    config.providers = { openai: { apiKey: "sk-test-openai" } };
    config.mcp = {
      enabled: true,
      servers: [
        { id: "github", name: "GitHub", url: "https://api.githubcopilot.com/mcp/", enabled: true },
        { id: "vercel", name: "Vercel", url: "https://mcp.vercel.com", enabled: true },
      ],
    };

    const runtime = await createRoleRuntime("/tmp/bender-runtime", config, {
      role: "planner",
    });

    expect(runtime.summary.mcpEnabled).toBe(true);
    expect(runtime.summary.mcpTools).toBe(2);
    expect(runtime.tools).toBeDefined();
    expect(Object.keys(runtime.tools ?? {})).toHaveLength(2);
    await runtime.close();
  });

  it("filters MCP connectors by agent-assigned connector IDs", async () => {
    const config = buildConfig();
    config.llm.provider = "openai";
    config.providers = { openai: { apiKey: "sk-test-openai" } };
    config.mcp = {
      enabled: true,
      servers: [
        { id: "github", name: "GitHub", url: "https://api.githubcopilot.com/mcp/", enabled: true },
        { id: "vercel", name: "Vercel", url: "https://mcp.vercel.com", enabled: true },
      ],
    };

    const runtime = await createRoleRuntime("/tmp/bender-runtime", config, {
      role: "implementer",
      mcpServerIds: ["github"],
    });

    expect(runtime.summary.mcpEnabled).toBe(true);
    expect(runtime.summary.mcpTools).toBe(1);
    expect(Object.keys(runtime.tools ?? {})).toHaveLength(1);
    await runtime.close();
  });

  it("returns no MCP when explicitly assigned zero connectors", async () => {
    const config = buildConfig();
    config.llm.provider = "openai";
    config.providers = { openai: { apiKey: "sk-test-openai" } };
    config.mcp = {
      enabled: true,
      servers: [
        { id: "github", name: "GitHub", url: "https://api.githubcopilot.com/mcp/", enabled: true },
      ],
    };

    const runtime = await createRoleRuntime("/tmp/bender-runtime", config, {
      role: "planner",
      mcpServerIds: [],
    });

    expect(runtime.summary.mcpEnabled).toBe(false);
    expect(runtime.summary.mcpTools).toBe(0);
    expect(runtime.tools).toBeUndefined();
    await runtime.close();
  });

  it("configures Anthropic providerOptions MCP servers", async () => {
    const config = buildConfig();
    config.llm.provider = "anthropic";
    config.providers = { anthropic: { apiKey: "sk-ant-test" } };
    config.mcp = {
      enabled: true,
      servers: [
        { id: "github", name: "GitHub", url: "https://api.githubcopilot.com/mcp/", enabled: true },
      ],
    };

    const runtime = await createRoleRuntime("/tmp/bender-runtime", config, {
      role: "architect",
    });

    expect(runtime.summary.mcpEnabled).toBe(true);
    expect(runtime.summary.mcpTools).toBe(1);
    expect(runtime.providerOptions).toBeDefined();
    expect(
      ((runtime.providerOptions as { anthropic?: { mcpServers?: unknown[] } })?.anthropic?.mcpServers ?? []).length,
    ).toBe(1);
    await runtime.close();
  });
});

