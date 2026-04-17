import type { Express } from "express";
import { createLogger, logError, resolveExistingProjectLogRoot } from "../../logger.js";
import {
  listRecentProjects,
  openProjectDirectory,
  removeRecentProject,
  selectExistingProject,
} from "../services/projects.js";

interface ProjectsRouteDeps {
  getCurrentProject: () => string | null;
  setCurrentProject: (path: string) => void;
  normalizeUserPath: (input?: string) => string;
}

const PROJECT_ROUTE_TIMEOUT_MS = 15_000;

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function registerProjectRoutes(app: Express, deps: ProjectsRouteDeps): void {
  app.get("/api/project", (_req, res) => {
    res.json({ path: deps.getCurrentProject() });
  });

  app.get("/api/projects", async (_req, res) => {
    const logger = createLogger("api:projects", resolveExistingProjectLogRoot(deps.getCurrentProject()));
    try {
      const projects = await listRecentProjects();
      res.json(projects);
    } catch (err) {
      logError(logger, "Failed to list recent projects", err, {
        requestId: res.locals.requestId as string | undefined,
      });
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post("/api/project/select", async (req, res) => {
    const logger = createLogger("api:projects", resolveExistingProjectLogRoot(deps.getCurrentProject()));
    const { path } = req.body as { path?: string };
    if (!path) {
      logger.warn("Rejected project select: path missing", {
        requestId: res.locals.requestId as string | undefined,
      });
      res.status(400).json({ error: "path required" });
      return;
    }
    try {
      const normalizedPath = deps.normalizeUserPath(path);
      const selected = await withTimeout(
        selectExistingProject(normalizedPath),
        PROJECT_ROUTE_TIMEOUT_MS,
        "Project select",
      );
      deps.setCurrentProject(selected);
      logger.info("Project selected", {
        requestId: res.locals.requestId as string | undefined,
        inputPath: path,
        normalizedPath,
      });
      res.json({ ok: true, path: selected });
    } catch (err) {
      logError(logger, "Failed to select project", err, {
        requestId: res.locals.requestId as string | undefined,
        inputPath: path,
      });
      const message = (err as Error).message;
      if (message === "Directory does not exist" || message === "Path is not a directory") {
        res.status(400).json({ error: message });
        return;
      }
      if (message.includes("timed out")) {
        res.status(504).json({ error: message });
        return;
      }
      res.status(500).json({ error: message });
    }
  });

  app.post("/api/project/open", async (req, res) => {
    const logger = createLogger("api:projects", resolveExistingProjectLogRoot(deps.getCurrentProject()));
    const { path } = req.body as { path?: string };
    if (!path) {
      logger.warn("Rejected project open: path missing", {
        requestId: res.locals.requestId as string | undefined,
      });
      res.status(400).json({ error: "path required" });
      return;
    }
    try {
      const normalizedPath = deps.normalizeUserPath(path);
      const selected = await withTimeout(
        openProjectDirectory(normalizedPath),
        PROJECT_ROUTE_TIMEOUT_MS,
        "Project open",
      );
      deps.setCurrentProject(selected);
      logger.info("Project opened", {
        requestId: res.locals.requestId as string | undefined,
        inputPath: path,
        normalizedPath,
      });
      res.json({ ok: true, path: selected });
    } catch (err) {
      logError(logger, "Failed to open project path", err, {
        requestId: res.locals.requestId as string | undefined,
        inputPath: path,
      });
      const message = (err as Error).message;
      if (message === "Path is not a directory" || message === "Directory does not exist") {
        res.status(400).json({ error: message });
        return;
      }
      if (message.includes("timed out")) {
        res.status(504).json({ error: message });
        return;
      }
      res.status(500).json({ error: message });
    }
  });

  app.delete("/api/projects/:encodedPath", async (req, res) => {
    const logger = createLogger("api:projects", resolveExistingProjectLogRoot(deps.getCurrentProject()));
    try {
      const path = decodeURIComponent(req.params.encodedPath);
      await removeRecentProject(path);
      res.json({ ok: true });
    } catch (err) {
      logError(logger, "Failed to remove recent project", err, {
        requestId: res.locals.requestId as string | undefined,
      });
      res.status(500).json({ error: (err as Error).message });
    }
  });
}
