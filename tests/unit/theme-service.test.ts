import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { createTempDir, withTempHome, type TempHomeContext } from "../helpers/temp-env.js";
import { DEFAULT_THEME_ID } from "../../src/themes/defaults.js";
import { importVsCodeTheme, listThemes, resolveTheme, saveTheme } from "../../src/themes/service.js";

describe("themes/service", () => {
  let tempHome: TempHomeContext;
  let projectRoot: string;

  beforeEach(async () => {
    tempHome = await withTempHome();
    projectRoot = await createTempDir("bender-theme-project-");
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
    await tempHome.restore();
  });

  it("imports VS Code themes with conservative fallbacks", () => {
    const imported = importVsCodeTheme({
      payload: {
        name: "Night Shift",
        type: "dark",
        colors: {
          "editor.background": "#0b1020",
          "editor.foreground": "#f3f4f6",
          "button.background": "#60a5fa",
        },
      },
    });

    expect(imported.theme.id).toBe("night-shift");
    expect(imported.theme.appearance).toBe("dark");
    expect(imported.theme.ui.colors.appBg).toBe("#0b1020");
    expect(imported.theme.ui.colors.textPrimary).toBe("#f3f4f6");
    expect(imported.theme.ui.legacy?.zinc?.["950"]).toBeDefined();
  });

  it("merges built-in, global, and project themes by precedence", async () => {
    const sharedId = "team-dark";
    const globalTheme = importVsCodeTheme({
      payload: {
        name: "Team Dark",
        type: "dark",
        colors: {
          "editor.background": "#10131f",
          "editor.foreground": "#e5e7eb",
        },
      },
      id: sharedId,
    }).theme;
    const projectTheme = importVsCodeTheme({
      payload: {
        name: "Team Dark Project Override",
        type: "dark",
        colors: {
          "editor.background": "#1f1022",
          "editor.foreground": "#f5d0fe",
        },
      },
      id: sharedId,
    }).theme;

    await saveTheme(globalTheme, "global");
    await saveTheme(projectTheme, "project", projectRoot);

    const list = await listThemes(projectRoot, sharedId);
    const shared = list.themes.find((theme) => theme.id === sharedId);

    expect(list.themes.some((theme) => theme.id === DEFAULT_THEME_ID)).toBe(true);
    expect(shared?.source).toBe("project");
    expect(list.activeThemeId).toBe(sharedId);

    const resolved = await resolveTheme(sharedId, projectRoot);
    expect(resolved.theme.name).toContain("Override");
    expect(resolved.source).toBe("project");
  });
});
