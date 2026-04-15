import type { Express, Response } from "express";
import type { UIAdapter } from "../adapter.js";
import {
  createEvalConfig,
  createEvalSuite,
  createEvalTask,
  deleteEvalConfig,
  deleteEvalSuite,
  deleteEvalTask,
  EvalServiceError,
  getCompareRun,
  getSuiteRun,
  listCompareRuns,
  listEvalConfigs,
  listEvalSuites,
  listEvalTasks,
  listSuiteRuns,
  runEvalCompare,
  runEvalSuite,
  updateEvalConfig,
  updateEvalSuite,
  updateEvalTask,
} from "../services/evals.js";

interface EvalsRouteDeps {
  getProject: () => string;
  runOperation: (
    res: Response,
    operation: (adapter: UIAdapter) => Promise<void>,
  ) => Promise<void>;
}

function toHttpError(err: unknown): { status: number; message: string } {
  if (err instanceof EvalServiceError) {
    return { status: err.status, message: err.message };
  }
  return { status: 500, message: (err as Error).message };
}

export function registerEvalRoutes(app: Express, deps: EvalsRouteDeps): void {
  app.get("/api/evals/tasks", async (_req, res) => {
    try {
      const tasks = await listEvalTasks(deps.getProject());
      res.json({ tasks });
    } catch (err) {
      const mapped = toHttpError(err);
      res.status(mapped.status).json({ error: mapped.message });
    }
  });

  app.post("/api/evals/tasks", async (req, res) => {
    try {
      const task = await createEvalTask(deps.getProject(), req.body ?? {});
      res.json({ task });
    } catch (err) {
      const mapped = toHttpError(err);
      res.status(mapped.status).json({ error: mapped.message });
    }
  });

  app.put("/api/evals/tasks/:id", async (req, res) => {
    try {
      const task = await updateEvalTask(deps.getProject(), req.params.id, req.body ?? {});
      res.json({ task });
    } catch (err) {
      const mapped = toHttpError(err);
      res.status(mapped.status).json({ error: mapped.message });
    }
  });

  app.delete("/api/evals/tasks/:id", async (req, res) => {
    try {
      await deleteEvalTask(deps.getProject(), req.params.id);
      res.json({ ok: true });
    } catch (err) {
      const mapped = toHttpError(err);
      res.status(mapped.status).json({ error: mapped.message });
    }
  });

  app.get("/api/evals/configs", async (_req, res) => {
    try {
      const configs = await listEvalConfigs(deps.getProject());
      res.json({ configs });
    } catch (err) {
      const mapped = toHttpError(err);
      res.status(mapped.status).json({ error: mapped.message });
    }
  });

  app.post("/api/evals/configs", async (req, res) => {
    try {
      const config = await createEvalConfig(deps.getProject(), req.body ?? {});
      res.json({ config });
    } catch (err) {
      const mapped = toHttpError(err);
      res.status(mapped.status).json({ error: mapped.message });
    }
  });

  app.put("/api/evals/configs/:id", async (req, res) => {
    try {
      const config = await updateEvalConfig(deps.getProject(), req.params.id, req.body ?? {});
      res.json({ config });
    } catch (err) {
      const mapped = toHttpError(err);
      res.status(mapped.status).json({ error: mapped.message });
    }
  });

  app.delete("/api/evals/configs/:id", async (req, res) => {
    try {
      await deleteEvalConfig(deps.getProject(), req.params.id);
      res.json({ ok: true });
    } catch (err) {
      const mapped = toHttpError(err);
      res.status(mapped.status).json({ error: mapped.message });
    }
  });

  app.get("/api/evals/suites", async (_req, res) => {
    try {
      const suites = await listEvalSuites(deps.getProject());
      res.json({ suites });
    } catch (err) {
      const mapped = toHttpError(err);
      res.status(mapped.status).json({ error: mapped.message });
    }
  });

  app.post("/api/evals/suites", async (req, res) => {
    try {
      const suite = await createEvalSuite(deps.getProject(), req.body ?? {});
      res.json({ suite });
    } catch (err) {
      const mapped = toHttpError(err);
      res.status(mapped.status).json({ error: mapped.message });
    }
  });

  app.put("/api/evals/suites/:id", async (req, res) => {
    try {
      const suite = await updateEvalSuite(deps.getProject(), req.params.id, req.body ?? {});
      res.json({ suite });
    } catch (err) {
      const mapped = toHttpError(err);
      res.status(mapped.status).json({ error: mapped.message });
    }
  });

  app.delete("/api/evals/suites/:id", async (req, res) => {
    try {
      await deleteEvalSuite(deps.getProject(), req.params.id);
      res.json({ ok: true });
    } catch (err) {
      const mapped = toHttpError(err);
      res.status(mapped.status).json({ error: mapped.message });
    }
  });

  app.get("/api/evals/runs/compare", async (req, res) => {
    try {
      const runs = await listCompareRuns(deps.getProject(), req.query.limit);
      res.json({ runs });
    } catch (err) {
      const mapped = toHttpError(err);
      res.status(mapped.status).json({ error: mapped.message });
    }
  });

  app.get("/api/evals/runs/compare/:id", async (req, res) => {
    try {
      const details = await getCompareRun(deps.getProject(), req.params.id);
      res.json(details);
    } catch (err) {
      const mapped = toHttpError(err);
      res.status(mapped.status).json({ error: mapped.message });
    }
  });

  app.get("/api/evals/runs/suites", async (req, res) => {
    try {
      const runs = await listSuiteRuns(deps.getProject(), req.query.limit);
      res.json({ runs });
    } catch (err) {
      const mapped = toHttpError(err);
      res.status(mapped.status).json({ error: mapped.message });
    }
  });

  app.get("/api/evals/runs/suites/:id", async (req, res) => {
    try {
      const details = await getSuiteRun(deps.getProject(), req.params.id);
      res.json(details);
    } catch (err) {
      const mapped = toHttpError(err);
      res.status(mapped.status).json({ error: mapped.message });
    }
  });

  app.post("/api/run/evals/compare", async (req, res) => {
    const body = (req.body ?? {}) as { taskId?: string; configIds?: string[]; concurrency?: number };
    await deps.runOperation(res, async (adapter) => {
      const { runs, configNameById } = await runEvalCompare(deps.getProject(), body, adapter);
      const successCount = runs.filter((r) => r.success).length;
      const failCount = runs.length - successCount;
      if (successCount === 0) {
        for (const run of runs) {
          const label = configNameById.get(run.configId) ?? run.configId;
          adapter.warn(`[${label}] ${run.error ?? "Run failed without a reported error."}`);
        }
        throw new Error(`Eval compare failed: 0/${runs.length} succeeded.`);
      }
      if (failCount > 0) {
        adapter.warn(`Eval compare partial success: ${successCount}/${runs.length} succeeded.`);
        for (const run of runs.filter((r) => !r.success)) {
          const label = configNameById.get(run.configId) ?? run.configId;
          adapter.warn(`[${label}] ${run.error ?? "Run failed without a reported error."}`);
        }
      } else {
        adapter.success(`Eval compare complete: ${successCount}/${runs.length} succeeded.`);
      }
    });
  });

  app.post("/api/run/evals/suites/:suiteId", async (req, res) => {
    const body = (req.body ?? {}) as { configIds?: string[]; concurrency?: number };
    await deps.runOperation(res, async (adapter) => {
      const { suiteRun, taskRuns } = await runEvalSuite(deps.getProject(), req.params.suiteId, body, adapter);
      const successCount = taskRuns.filter((r) => r.success).length;
      if (taskRuns.length > 0 && successCount === 0) {
        throw new Error(`Suite run failed: 0/${taskRuns.length} task-config runs succeeded.`);
      }
      if (taskRuns.length > 0 && successCount < taskRuns.length) {
        adapter.warn(`Suite run partial success: ${successCount}/${taskRuns.length} task-config runs succeeded.`);
      } else {
        adapter.success(`Suite run complete: ${suiteRun.perConfig.length} config summary entries generated.`);
      }
    });
  });
}
