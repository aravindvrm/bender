import type { Express } from "express";
import type { SkillEvalCase } from "../../state/skill-workbench.js";
import {
  createSkillPackage,
  getSkillsCatalog,
  getSkillsRegistrySnapshot,
  importSkillPackage,
  readSkillWorkbench,
  refreshSkillsRegistrySnapshot,
  runSkillWorkbenchEval,
  SkillsServiceError,
  updateSkillEvalCases,
  updateSkillEvalFeedback,
} from "../services/skills.js";

interface SkillsRouteDeps {
  getCurrentProject: () => string | null;
}

function toHttpError(err: unknown): { status: number; message: string } {
  if (err instanceof SkillsServiceError) {
    return { status: err.status, message: err.message };
  }
  return { status: 500, message: (err as Error).message };
}

export function registerSkillRoutes(app: Express, deps: SkillsRouteDeps): void {
  app.get("/api/skills/registry", async (_req, res) => {
    try {
      res.json(await getSkillsRegistrySnapshot());
    } catch (err) {
      const mapped = toHttpError(err);
      res.status(mapped.status).json({ error: mapped.message });
    }
  });

  app.post("/api/skills/refresh", async (_req, res) => {
    try {
      res.json(await refreshSkillsRegistrySnapshot());
    } catch (err) {
      const mapped = toHttpError(err);
      res.status(mapped.status).json({ error: mapped.message });
    }
  });

  app.get("/api/skills/catalog", async (_req, res) => {
    try {
      res.json(await getSkillsCatalog(deps.getCurrentProject()));
    } catch (err) {
      const mapped = toHttpError(err);
      res.status(mapped.status).json({ error: mapped.message });
    }
  });

  app.post("/api/skills/library/create", async (req, res) => {
    try {
      const body = (req.body ?? {}) as { scope?: "user" | "project"; name?: string; description?: string };
      res.json(await createSkillPackage(deps.getCurrentProject(), body));
    } catch (err) {
      const mapped = toHttpError(err);
      res.status(mapped.status).json({ error: mapped.message });
    }
  });

  app.post("/api/skills/library/import", async (req, res) => {
    try {
      const body = (req.body ?? {}) as { scope?: "user" | "project"; sourcePath?: string; name?: string };
      res.json(await importSkillPackage(deps.getCurrentProject(), body));
    } catch (err) {
      const mapped = toHttpError(err);
      res.status(mapped.status).json({ error: mapped.message });
    }
  });

  app.get("/api/skills/workbench/:skillId", async (req, res) => {
    try {
      res.json(await readSkillWorkbench(req.params.skillId));
    } catch (err) {
      const mapped = toHttpError(err);
      res.status(mapped.status).json({ error: mapped.message });
    }
  });

  app.put("/api/skills/workbench/:skillId/cases", async (req, res) => {
    try {
      const body = (req.body ?? {}) as { cases?: SkillEvalCase[] };
      res.json(await updateSkillEvalCases(req.params.skillId, body.cases));
    } catch (err) {
      const mapped = toHttpError(err);
      res.status(mapped.status).json({ error: mapped.message });
    }
  });

  app.post("/api/skills/workbench/:skillId/runs/:runId/feedback", async (req, res) => {
    try {
      const body = (req.body ?? {}) as { pass?: boolean; feedback?: string };
      res.json(await updateSkillEvalFeedback(req.params.skillId, req.params.runId, body));
    } catch (err) {
      const mapped = toHttpError(err);
      res.status(mapped.status).json({ error: mapped.message });
    }
  });

  app.post("/api/skills/workbench/:skillId/run", async (req, res) => {
    try {
      const projectRoot = deps.getCurrentProject();
      if (!projectRoot) {
        res.status(400).json({ error: "No project selected" });
        return;
      }

      const body = (req.body ?? {}) as {
        prompt?: string;
        withSkill?: boolean;
        role?: "analyzer" | "architect" | "planner" | "implementer" | "reviewer";
        modelTier?: "fast" | "default" | "strong";
      };

      res.json(await runSkillWorkbenchEval(projectRoot, req.params.skillId, body));
    } catch (err) {
      const mapped = toHttpError(err);
      res.status(mapped.status).json({ error: mapped.message });
    }
  });
}
