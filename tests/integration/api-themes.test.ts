import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server as HttpServer } from "node:http";

async function reserveFreePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close(() => reject(new Error("Failed to reserve port")));
        return;
      }
      const port = addr.port;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

async function closeServer(server: HttpServer | null): Promise<void> {
  if (!server?.listening) return;
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
}

interface ThemeEntry {
  id: string;
  name?: string;
  appearance?: string;
  source?: string;
}

// Minimal VS Code dark theme JSON
const MINIMAL_VSCODE_THEME = {
  name: "Test Dark Theme",
  type: "dark",
  colors: {
    "editor.background": "#1e1e1e",
    "editor.foreground": "#d4d4d4",
    "sideBar.background": "#252526",
    "statusBar.background": "#007acc",
  },
};

describe("api themes integration", () => {
  let tempWorkspace = "";
  let tempBenderHome = "";
  let benderServer: HttpServer | null = null;
  let baseUrl = "";

  beforeAll(async () => {
    tempWorkspace = await mkdtemp(join(tmpdir(), "bender-themes-int-"));
    tempBenderHome = await mkdtemp(join(tmpdir(), "bender-themes-home-"));
    process.env.BENDER_HOME_DIR = tempBenderHome;

    const { startServer } = await import("../../src/cli/server.js");
    const port = await reserveFreePort();
    benderServer = await startServer(undefined, port);
    baseUrl = `http://127.0.0.1:${port}`;

    // Open a project so project-scoped theme endpoints work
    const projectPath = join(tempWorkspace, "project");
    await mkdir(projectPath, { recursive: true });
    const openRes = await fetch(`${baseUrl}/api/project/open`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: projectPath }),
    });
    expect(openRes.ok).toBe(true);
  });

  afterAll(async () => {
    await closeServer(benderServer);
    if (tempWorkspace) await rm(tempWorkspace, { recursive: true, force: true });
    if (tempBenderHome) await rm(tempBenderHome, { recursive: true, force: true });
    delete process.env.BENDER_HOME_DIR;
  });

  it("GET /api/themes lists built-in themes", async () => {
    const res = await fetch(`${baseUrl}/api/themes`);
    expect(res.ok).toBe(true);
    const body = await res.json() as { themes: ThemeEntry[]; activeThemeId?: string | null };
    expect(Array.isArray(body.themes)).toBe(true);
    expect(body.themes.length).toBeGreaterThan(0);
    const builtin = body.themes.filter((t) => t.source === "builtin");
    expect(builtin.length).toBeGreaterThan(0);
    expect(Object.prototype.hasOwnProperty.call(body, "activeThemeId")).toBe(true);
  });

  it("GET /api/themes/active returns a theme payload", async () => {
    const res = await fetch(`${baseUrl}/api/themes/active`);
    expect(res.ok).toBe(true);
    const body = await res.json() as {
      themeId?: string;
      source?: string;
      theme?: {
        id?: string;
        appearance?: string;
        ui?: { colors?: Record<string, string>; radius?: Record<string, string> };
      };
    };
    expect(body.themeId).toBeTruthy();
    expect(body.source).toBeTruthy();
    expect(body.theme?.id).toBeTruthy();
    expect(body.theme?.appearance === "dark" || body.theme?.appearance === "light").toBe(true);
    expect(typeof body.theme?.ui?.colors).toBe("object");
    expect(typeof body.theme?.ui?.radius).toBe("object");
  });

  it("POST /api/themes/import/vscode imports a theme and it appears in list", async () => {
    const res = await fetch(`${baseUrl}/api/themes/import/vscode`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ theme: MINIMAL_VSCODE_THEME, scope: "global" }),
    });
    expect(res.ok).toBe(true);
    const body = await res.json() as { theme?: ThemeEntry };
    expect(body.theme?.id).toBeTruthy();

    // Confirm it appears in the list
    const listRes = await fetch(`${baseUrl}/api/themes`);
    const listBody = await listRes.json() as { themes: ThemeEntry[] };
    const found = listBody.themes.find((t) => t.id === body.theme?.id);
    expect(found).toBeDefined();
  });

  it("POST /api/themes/import/vscode returns 400 when theme payload is missing", async () => {
    const res = await fetch(`${baseUrl}/api/themes/import/vscode`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope: "global" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error?: string };
    expect(body.error).toBeTruthy();
  });

  it("DELETE /api/themes/:id removes an imported theme", async () => {
    // Import a theme to delete
    const importRes = await fetch(`${baseUrl}/api/themes/import/vscode`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ theme: { ...MINIMAL_VSCODE_THEME, name: "Theme to delete" }, scope: "global" }),
    });
    expect(importRes.ok).toBe(true);
    const { theme } = await importRes.json() as { theme: ThemeEntry };

    const deleteRes = await fetch(`${baseUrl}/api/themes/${encodeURIComponent(theme.id)}?scope=global`, {
      method: "DELETE",
    });
    expect(deleteRes.ok).toBe(true);

    // Should no longer appear in the list
    const listRes = await fetch(`${baseUrl}/api/themes`);
    const { themes } = await listRes.json() as { themes: ThemeEntry[] };
    expect(themes.every((t) => t.id !== theme.id)).toBe(true);
  });

  it("DELETE /api/themes/:id returns 404 for a built-in theme", async () => {
    const listRes = await fetch(`${baseUrl}/api/themes`);
    const { themes } = await listRes.json() as { themes: ThemeEntry[] };
    const builtin = themes.find((t) => t.source === "builtin");
    expect(builtin).toBeDefined();

    const deleteRes = await fetch(`${baseUrl}/api/themes/${encodeURIComponent(builtin!.id)}?scope=global`, {
      method: "DELETE",
    });
    expect(deleteRes.status).toBeGreaterThanOrEqual(400);
  });
});
