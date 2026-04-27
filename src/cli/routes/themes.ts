import type { Express } from "express";
import { readConfig, readEffectiveConfig, readGlobalConfig, writeConfig, writeGlobalConfig } from "../../state/config.js";
import { importVsCodeTheme, listThemes, resolveTheme, saveTheme } from "../../themes/service.js";

interface ThemeRouteDeps {
  getCurrentProject: () => string | null;
}

interface ImportVsCodePayload {
  scope?: "global" | "project";
  id?: string;
  name?: string;
  author?: string;
  theme?: unknown;
  json?: unknown;
}

export function registerThemeRoutes(app: Express, deps: ThemeRouteDeps): void {
  app.get("/api/themes", async (_req, res) => {
    try {
      const projectRoot = deps.getCurrentProject();
      const config = await readEffectiveConfig(projectRoot);
      const result = await listThemes(projectRoot, config.ui?.themeId);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get("/api/themes/active", async (_req, res) => {
    try {
      const projectRoot = deps.getCurrentProject();
      const config = await readEffectiveConfig(projectRoot);
      const resolved = await resolveTheme(config.ui?.themeId, projectRoot);
      res.json({
        themeId: resolved.activeThemeId,
        source: resolved.source,
        theme: resolved.theme,
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post("/api/themes/import/vscode", async (req, res) => {
    try {
      const payload = (req.body ?? {}) as ImportVsCodePayload;
      const projectRoot = deps.getCurrentProject();
      const scope = payload.scope === "project" ? "project" : "global";
      if (scope === "project" && !projectRoot) {
        res.status(400).json({ error: "No project selected. Open a project before importing a project theme." });
        return;
      }
      const sourcePayload = payload.theme ?? payload.json;
      if (!sourcePayload) {
        res.status(400).json({ error: "Missing theme payload. Provide `theme` or `json`." });
        return;
      }
      const parsedPayload = (() => {
        if (typeof sourcePayload === "string") {
          return JSON.parse(sourcePayload) as unknown;
        }
        return sourcePayload;
      })();

      const imported = importVsCodeTheme({
        payload: parsedPayload,
        id: payload.id,
        name: payload.name,
        author: payload.author,
      });
      await saveTheme(imported.theme, scope, projectRoot);

      if (scope === "project" && projectRoot) {
        const config = await readConfig(projectRoot);
        config.ui = {
          ...config.ui,
          themeId: imported.theme.id,
        };
        await writeConfig(projectRoot, config);
      } else if (scope === "global") {
        const config = await readGlobalConfig();
        config.ui = {
          ...config.ui,
          themeId: imported.theme.id,
        };
        await writeGlobalConfig(config);
      }

      res.json({
        ok: true,
        scope,
        importedThemeId: imported.theme.id,
        warnings: imported.warnings,
        theme: imported.theme,
      });
    } catch (err) {
      const message = (err as Error).message;
      if (err instanceof SyntaxError || message.toLowerCase().includes("json")) {
        res.status(400).json({ error: message });
        return;
      }
      res.status(500).json({ error: message });
    }
  });
}
