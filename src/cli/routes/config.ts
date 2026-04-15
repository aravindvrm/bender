import type { Express } from "express";
import { getGlobalConfig, updateGlobalConfig } from "../services/config.js";

interface ConfigRouteDeps {
  getCurrentProject: () => string | null;
}

export function registerConfigRoutes(app: Express, deps: ConfigRouteDeps): void {
  app.get("/api/config", async (_req, res) => {
    try {
      res.json(await getGlobalConfig(deps.getCurrentProject()));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.put("/api/config", async (req, res) => {
    try {
      await updateGlobalConfig((req.body ?? {}) as Record<string, unknown>);
      res.json({ ok: true, scope: "global" });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });
}
