import type { Express } from "express";
import { RunHistoryStore } from "../services/run-history.js";

interface RunsRouteDeps {
  getCurrentProject: () => string | null;
}

export function registerRunsRoutes(app: Express, deps: RunsRouteDeps): void {
  /** List the last N operation runs for the current project. */
  app.get("/api/runs", async (_req, res) => {
    const projectRoot = deps.getCurrentProject();
    if (!projectRoot) {
      res.json({ runs: [] });
      return;
    }
    try {
      const store = new RunHistoryStore(projectRoot);
      await store.init();
      const runs = await store.listRuns();
      res.json({ runs });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  /** Return all recorded events for a specific run. */
  app.get("/api/runs/:id", async (req, res) => {
    const projectRoot = deps.getCurrentProject();
    if (!projectRoot) {
      res.status(404).json({ error: "No project selected" });
      return;
    }
    const { id } = req.params;
    if (!id?.trim()) {
      res.status(400).json({ error: "id is required" });
      return;
    }
    try {
      const store = new RunHistoryStore(projectRoot);
      await store.init();
      const events = await store.getRunEvents(id);
      if (events.length === 0) {
        // Could be a valid empty run or a missing one — distinguish via index.
        const runs = await store.listRuns();
        const found = runs.some((r) => r.id === id);
        if (!found) {
          res.status(404).json({ error: "Run not found" });
          return;
        }
      }
      res.json({ id, events });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });
}
