import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import {
  DEFAULT_CONFIG,
  readConfig,
  readEffectiveConfig,
  writeGlobalConfig,
} from "../../src/state/config.js";
import { updateGlobalConfig } from "../../src/cli/services/config.js";
import { createTempDir, withTempHome, type TempHomeContext } from "../helpers/temp-env.js";

describe("cli/services/config", () => {
  let tempHome: TempHomeContext;
  let projectRoot: string;

  beforeEach(async () => {
    tempHome = await withTempHome();
    projectRoot = await createTempDir("bender-config-service-project-");
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
    await tempHome.restore();
  });

  it("preserves masked MCP authorization tokens in project-scoped updates via global fallback", async () => {
    const global = structuredClone(DEFAULT_CONFIG);
    global.mcp = {
      enabled: true,
      servers: [{
        id: "github",
        name: "GitHub",
        url: "https://api.githubcopilot.com/mcp/",
        enabled: true,
        authorizationToken: "ghp_global_token",
      }],
    };
    await writeGlobalConfig(global);

    // Simulate an existing project override that already dropped the token.
    await updateGlobalConfig({
      mcp: {
        servers: [{
          id: "github",
          name: "GitHub",
          url: "https://api.githubcopilot.com/mcp/",
          enabled: true,
          authorizationToken: "",
        }],
      },
    }, projectRoot);

    // Simulate masked payload from /api/config save roundtrip.
    await updateGlobalConfig({
      mcp: {
        servers: [{
          id: "github",
          name: "GitHub",
          url: "https://api.githubcopilot.com/mcp/",
          enabled: true,
          authorizationToken: "••••••••",
        }],
      },
    }, projectRoot);

    const project = await readConfig(projectRoot);
    const effective = await readEffectiveConfig(projectRoot);
    const projectToken = project.mcp?.servers?.[0]?.authorizationToken;
    const effectiveToken = effective.mcp?.servers?.[0]?.authorizationToken;

    expect(projectToken).toBe("ghp_global_token");
    expect(effectiveToken).toBe("ghp_global_token");
  });
});
