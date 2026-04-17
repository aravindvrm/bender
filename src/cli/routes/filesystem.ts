import type { Express } from "express";
import { createLogger, logError, resolveExistingProjectLogRoot } from "../../logger.js";
import { browseDirectory, FilesystemServiceError, inspectDirectory } from "../services/filesystem.js";

interface FilesystemRouteDeps {
  normalizeUserPath: (input?: string) => string;
  getCurrentProject?: () => string | null;
}

function toHttpError(err: unknown): { status: number; message: string } {
  if (err instanceof FilesystemServiceError) {
    return { status: err.status, message: err.message };
  }
  return { status: 500, message: (err as Error).message };
}

export function registerFilesystemRoutes(app: Express, deps: FilesystemRouteDeps): void {
  app.get("/api/fs/browse", async (req, res) => {
    const logger = createLogger("api:fs", resolveExistingProjectLogRoot(deps.getCurrentProject?.() ?? null));
    const queryPath = typeof req.query.path === "string" ? req.query.path : "";
    try {
      const targetPath = deps.normalizeUserPath(queryPath);
      const result = await browseDirectory(targetPath);
      res.json(result);
    } catch (err) {
      logError(logger, "Failed to browse directory", err, {
        requestId: res.locals.requestId as string | undefined,
        queryPath,
      });
      const mapped = toHttpError(err);
      res.status(mapped.status).json({ error: mapped.message });
    }
  });

  app.get("/api/fs/inspect", async (req, res) => {
    const logger = createLogger("api:fs", resolveExistingProjectLogRoot(deps.getCurrentProject?.() ?? null));
    const rawPath = typeof req.query.path === "string" ? req.query.path : "";
    try {
      if (!rawPath.trim()) {
        logger.warn("Rejected inspect directory request: path missing", {
          requestId: res.locals.requestId as string | undefined,
        });
        res.status(400).json({ error: "path required" });
        return;
      }

      const targetPath = deps.normalizeUserPath(rawPath);
      const result = await inspectDirectory(targetPath);
      res.json(result);
    } catch (err) {
      logError(logger, "Failed to inspect directory", err, {
        requestId: res.locals.requestId as string | undefined,
        rawPath,
      });
      const mapped = toHttpError(err);
      res.status(mapped.status).json({ error: mapped.message });
    }
  });
}
