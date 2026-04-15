import type { Express } from "express";
import { readSessionUsage, readStructuredLogs } from "../services/logs.js";

interface LogsRouteDeps {
  getCurrentProject: () => string | null;
  getProject: () => string;
  sessionStartedAtMs: number;
}

export function registerLogRoutes(app: Express, deps: LogsRouteDeps): void {
  app.get("/api/logs", async (req, res) => {
    try {
      const projectRoot = deps.getProject();
      const limit = Math.min(500, parseInt((req.query.limit as string) ?? "200", 10) || 200);
      const payload = await readStructuredLogs(projectRoot, limit);
      res.json(payload);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get("/api/usage/session", async (_req, res) => {
    try {
      const payload = await readSessionUsage(
        deps.getCurrentProject(),
        deps.sessionStartedAtMs,
      );
      res.json(payload);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });
}
