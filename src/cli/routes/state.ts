import type { Express } from "express";
import { getProjectState, readSessions } from "../services/state.js";

interface StateRouteDeps {
  getCurrentProject: () => string | null;
  getProject: () => string;
}

export function registerStateRoutes(app: Express, deps: StateRouteDeps): void {
  app.get("/api/state", async (_req, res) => {
    const projectRoot = deps.getCurrentProject();
    if (!projectRoot) {
      res.json({ initialized: false, projectRoot: null });
      return;
    }

    try {
      const state = await getProjectState(projectRoot);
      res.json(state);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get("/api/sessions", async (_req, res) => {
    try {
      const sessions = await readSessions(deps.getProject());
      res.json(sessions);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });
}
