import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { addToRegistry, readRegistry, removeFromRegistry } from "../../src/state/registry.js";
import { getBenderHomeDir } from "../../src/state/paths.js";
import { withTempHome, type TempHomeContext } from "../helpers/temp-env.js";

describe("state/registry sqlite-backed", () => {
  let tempHome: TempHomeContext;

  beforeEach(async () => {
    tempHome = await withTempHome();
  });

  afterEach(async () => {
    await tempHome.restore();
  });

  it("persists registry entries in sqlite and remains readable without legacy file", async () => {
    const projectPath = "/tmp/demo-project";
    await addToRegistry(projectPath);

    const homeDir = getBenderHomeDir();
    const dbPath = join(homeDir, "bender-home.db");
    const filePath = join(homeDir, "projects.json");
    expect(existsSync(dbPath)).toBe(true);
    expect(existsSync(filePath)).toBe(true);

    await rm(filePath, { force: true });
    const entries = await readRegistry();
    expect(entries.some((entry) => entry.path === projectPath)).toBe(true);

    await removeFromRegistry(projectPath);
    const afterRemove = await readRegistry();
    expect(afterRemove.some((entry) => entry.path === projectPath)).toBe(false);
  });
});

