import type { Express } from "express";
import type { TaskGitHubLink } from "../../state/manager.js";
import {
  appendTask,
  deleteTask,
  patchTask,
  readTaskAgents,
  readTaskLinks,
  setTaskAgent,
  setTaskLink,
  TasksServiceError,
} from "../services/tasks.js";

interface TasksRouteDeps {
  getCurrentProject: () => string | null;
  getProject: () => string;
}

function toHttpError(err: unknown): { status: number; message: string } {
  if (err instanceof TasksServiceError) {
    return { status: err.status, message: err.message };
  }
  return { status: 500, message: (err as Error).message };
}

export function registerTaskRoutes(app: Express, deps: TasksRouteDeps): void {
  app.get("/api/tasks/agents", async (_req, res) => {
    const projectRoot = deps.getCurrentProject();
    if (!projectRoot) {
      res.json({ assignments: {} });
      return;
    }
    try {
      const assignments = await readTaskAgents(projectRoot);
      res.json({ assignments });
    } catch (err) {
      const mapped = toHttpError(err);
      res.status(mapped.status).json({ error: mapped.message });
    }
  });

  app.put("/api/tasks/agents/:taskId", async (req, res) => {
    const projectRoot = deps.getCurrentProject();
    if (!projectRoot) {
      res.status(400).json({ error: "No project selected" });
      return;
    }
    try {
      const { taskId } = req.params;
      const { agentId } = req.body as { agentId?: string | null };
      const assignments = await setTaskAgent(projectRoot, taskId, agentId);
      res.json({ ok: true, assignments });
    } catch (err) {
      const mapped = toHttpError(err);
      res.status(mapped.status).json({ error: mapped.message });
    }
  });

  app.get("/api/tasks/links", async (_req, res) => {
    const projectRoot = deps.getCurrentProject();
    if (!projectRoot) {
      res.json({ links: {} });
      return;
    }
    try {
      const links = await readTaskLinks(projectRoot);
      res.json({ links });
    } catch (err) {
      const mapped = toHttpError(err);
      res.status(mapped.status).json({ error: mapped.message });
    }
  });

  app.put("/api/tasks/links/:taskId", async (req, res) => {
    const projectRoot = deps.getCurrentProject();
    if (!projectRoot) {
      res.status(400).json({ error: "No project selected" });
      return;
    }
    try {
      const { taskId } = req.params;
      const body = (req.body ?? {}) as Partial<TaskGitHubLink> & { clear?: boolean };
      const { links, link } = await setTaskLink(projectRoot, taskId, body);
      res.json({ ok: true, links, link });
    } catch (err) {
      const mapped = toHttpError(err);
      res.status(mapped.status).json({ error: mapped.message });
    }
  });

  app.post("/api/tasks/append", async (req, res) => {
    try {
      const { title, description, files } = req.body as { title?: string; description?: string; files?: string[] };
      const projectRoot = deps.getProject();
      const result = await appendTask(projectRoot, { title, description, files });
      res.json({ ok: true, taskId: result.taskId });
    } catch (err) {
      const mapped = toHttpError(err);
      res.status(mapped.status).json({ error: mapped.message });
    }
  });

  app.patch("/api/tasks/:taskId", async (req, res) => {
    try {
      const projectRoot = deps.getProject();
      const { taskId } = req.params;
      const { title, description, dependencies, criteria } = (req.body ?? {}) as {
        title?: string;
        description?: string;
        dependencies?: string;
        criteria?: string;
      };
      await patchTask(projectRoot, taskId, {
        title,
        description,
        dependencies,
        criteria,
      });
      res.json({ ok: true });
    } catch (err) {
      const mapped = toHttpError(err);
      res.status(mapped.status).json({ error: mapped.message });
    }
  });

  app.delete("/api/tasks/:taskId", async (req, res) => {
    try {
      const projectRoot = deps.getProject();
      const { taskId } = req.params;
      const { cascadeDependents } = (req.body ?? {}) as { cascadeDependents?: boolean };
      const deletedTaskIds = await deleteTask(projectRoot, taskId, Boolean(cascadeDependents));
      res.json({ ok: true, deletedTaskIds });
    } catch (err) {
      const mapped = toHttpError(err);
      res.status(mapped.status).json({ error: mapped.message });
    }
  });
}
