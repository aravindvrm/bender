import type { Express } from "express";
import { browseDirectory, FilesystemServiceError, inspectDirectory } from "../services/filesystem.js";

interface FilesystemRouteDeps {
  normalizeUserPath: (input?: string) => string;
}

function toHttpError(err: unknown): { status: number; message: string } {
  if (err instanceof FilesystemServiceError) {
    return { status: err.status, message: err.message };
  }
  return { status: 500, message: (err as Error).message };
}

export function registerFilesystemRoutes(app: Express, deps: FilesystemRouteDeps): void {
  app.get("/api/fs/browse", async (req, res) => {
    try {
      const queryPath = typeof req.query.path === "string" ? req.query.path : "";
      const targetPath = deps.normalizeUserPath(queryPath);
      const result = await browseDirectory(targetPath);
      res.json(result);
    } catch (err) {
      const mapped = toHttpError(err);
      res.status(mapped.status).json({ error: mapped.message });
    }
  });

  app.get("/api/fs/inspect", async (req, res) => {
    try {
      const rawPath = typeof req.query.path === "string" ? req.query.path : "";
      if (!rawPath.trim()) {
        res.status(400).json({ error: "path required" });
        return;
      }

      const targetPath = deps.normalizeUserPath(rawPath);
      const result = await inspectDirectory(targetPath);
      res.json(result);
    } catch (err) {
      const mapped = toHttpError(err);
      res.status(mapped.status).json({ error: mapped.message });
    }
  });
}
