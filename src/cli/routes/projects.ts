import type { Express } from "express";
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

export function registerProjectRoutes(app: Express, deps: ProjectsRouteDeps): void {
  app.get("/api/project", (_req, res) => {
    res.json({ path: deps.getCurrentProject() });
  });

  app.get("/api/projects", async (_req, res) => {
    try {
      const projects = await listRecentProjects();
      res.json(projects);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post("/api/project/select", async (req, res) => {
    const { path } = req.body as { path?: string };
    if (!path) {
      res.status(400).json({ error: "path required" });
      return;
    }
    try {
      const normalizedPath = deps.normalizeUserPath(path);
      const selected = await selectExistingProject(normalizedPath);
      deps.setCurrentProject(selected);
      res.json({ ok: true, path: selected });
    } catch (err) {
      const message = (err as Error).message;
      if (message === "Directory does not exist" || message === "Path is not a directory") {
        res.status(400).json({ error: message });
        return;
      }
      res.status(500).json({ error: message });
    }
  });

  app.post("/api/project/open", async (req, res) => {
    const { path } = req.body as { path?: string };
    if (!path) {
      res.status(400).json({ error: "path required" });
      return;
    }
    try {
      const normalizedPath = deps.normalizeUserPath(path);
      const selected = await openProjectDirectory(normalizedPath);
      deps.setCurrentProject(selected);
      res.json({ ok: true, path: selected });
    } catch (err) {
      const message = (err as Error).message;
      if (message === "Path is not a directory") {
        res.status(400).json({ error: message });
        return;
      }
      res.status(500).json({ error: message });
    }
  });

  app.delete("/api/projects/:encodedPath", async (req, res) => {
    try {
      const path = decodeURIComponent(req.params.encodedPath);
      await removeRecentProject(path);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });
}

