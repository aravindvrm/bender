import type { Express } from "express";
import {
  executeWorkflow,
  getWorkflow,
  getWorkflowRun,
  listWorkflowRuns,
  listWorkflows,
  removeWorkflow,
  upsertWorkflow,
  WorkflowServiceError,
} from "../services/workflows.js";

interface GitHubSession {
  accessToken: string;
}

interface WorkflowRouteDeps {
  getCurrentProject: () => string | null;
  getProject: () => string;
  readGitHubSession: () => Promise<GitHubSession | null>;
  githubApi: <T>(path: string, token: string, init?: RequestInit) => Promise<T>;
}

function toHttpError(err: unknown): { status: number; message: string } {
  if (err instanceof WorkflowServiceError) {
    return { status: err.status, message: err.message };
  }
  return { status: 500, message: (err as Error).message };
}

function requireProject(getCurrentProject: () => string | null, getProject: () => string): string {
  const current = getCurrentProject();
  if (!current) {
    throw new WorkflowServiceError(400, "No project selected");
  }
  return getProject();
}

export function registerWorkflowRoutes(app: Express, deps: WorkflowRouteDeps): void {
  app.get("/api/workflows", async (_req, res) => {
    try {
      const workflows = await listWorkflows(requireProject(deps.getCurrentProject, deps.getProject));
      const summaries = workflows.map((workflow) => ({
        id: workflow.id,
        name: workflow.name,
        enabled: workflow.enabled,
        version: workflow.version,
        acceptanceCriteria: workflow.acceptanceCriteria ?? [],
      }));
      res.json({ workflows: summaries });
    } catch (err) {
      const mapped = toHttpError(err);
      res.status(mapped.status).json({ error: mapped.message });
    }
  });

  app.get("/api/workflows/:id", async (req, res) => {
    try {
      const workflow = await getWorkflow(
        requireProject(deps.getCurrentProject, deps.getProject),
        decodeURIComponent(req.params.id ?? ""),
      );
      res.json({ workflow });
    } catch (err) {
      const mapped = toHttpError(err);
      res.status(mapped.status).json({ error: mapped.message });
    }
  });

  app.put("/api/workflows/:id", async (req, res) => {
    try {
      const workflow = await upsertWorkflow(
        requireProject(deps.getCurrentProject, deps.getProject),
        decodeURIComponent(req.params.id ?? ""),
        (req.body ?? {}) as Record<string, unknown>,
      );
      res.json({ workflow });
    } catch (err) {
      const mapped = toHttpError(err);
      res.status(mapped.status).json({ error: mapped.message });
    }
  });

  app.delete("/api/workflows/:id", async (req, res) => {
    try {
      await removeWorkflow(
        requireProject(deps.getCurrentProject, deps.getProject),
        decodeURIComponent(req.params.id ?? ""),
      );
      res.json({ ok: true });
    } catch (err) {
      const mapped = toHttpError(err);
      res.status(mapped.status).json({ error: mapped.message });
    }
  });

  app.post("/api/workflows/:id/run", async (req, res) => {
    try {
      const run = await executeWorkflow(
        requireProject(deps.getCurrentProject, deps.getProject),
        decodeURIComponent(req.params.id ?? ""),
        (req.body ?? {}) as Record<string, unknown>,
        {
          readGitHubSession: deps.readGitHubSession,
          githubApi: deps.githubApi,
        },
      );
      res.json({
        runId: run.id,
        status: run.status,
        output: run.output ?? null,
      });
    } catch (err) {
      const mapped = toHttpError(err);
      res.status(mapped.status).json({ error: mapped.message });
    }
  });

  app.get("/api/workflow-runs", async (req, res) => {
    try {
      const workflowId = typeof req.query.workflowId === "string"
        ? req.query.workflowId.trim()
        : undefined;
      const runs = await listWorkflowRuns(
        requireProject(deps.getCurrentProject, deps.getProject),
        workflowId,
      );
      res.json({ runs });
    } catch (err) {
      const mapped = toHttpError(err);
      res.status(mapped.status).json({ error: mapped.message });
    }
  });

  app.get("/api/workflow-runs/:runId", async (req, res) => {
    try {
      const run = await getWorkflowRun(
        requireProject(deps.getCurrentProject, deps.getProject),
        decodeURIComponent(req.params.runId ?? ""),
      );
      res.json({ run });
    } catch (err) {
      const mapped = toHttpError(err);
      res.status(mapped.status).json({ error: mapped.message });
    }
  });
}

