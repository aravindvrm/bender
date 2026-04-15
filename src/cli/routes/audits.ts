import type { Express, Response } from "express";
import { StateManager } from "../../state/manager.js";
import type { UIAdapter } from "../adapter.js";
import { runAuditWorkflow } from "../services/audits.js";

interface AuditsRouteDeps {
  getProject: () => string;
  runOperation: (
    res: Response,
    operation: (adapter: UIAdapter) => Promise<void>,
  ) => Promise<void>;
}

export function registerAuditRoutes(app: Express, deps: AuditsRouteDeps): void {
  app.get("/api/audits", async (_req, res) => {
    try {
      const state = new StateManager(deps.getProject());
      const [security, tests] = await Promise.all([
        state.readAudit("security"),
        state.readAudit("tests"),
      ]);
      res.json({ security, tests });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post("/api/run/audit/security", async (_req, res) => {
    await deps.runOperation(res, async (adapter) => {
      await runAuditWorkflow(deps.getProject(), "security", adapter);
    });
  });

  app.post("/api/run/audit/tests", async (_req, res) => {
    await deps.runOperation(res, async (adapter) => {
      await runAuditWorkflow(deps.getProject(), "tests", adapter);
    });
  });
}
