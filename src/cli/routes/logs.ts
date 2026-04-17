import type { Express } from "express";
import { readSessionUsage, readStructuredLogsFiltered } from "../services/logs.js";
import { createLogger, resolveExistingProjectLogRoot } from "../../logger.js";

interface LogsRouteDeps {
  getCurrentProject: () => string | null;
  getProject: () => string;
  sessionStartedAtMs: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function registerLogRoutes(app: Express, deps: LogsRouteDeps): void {
  app.get("/api/logs", async (req, res) => {
    try {
      const projectRoot = deps.getProject();
      const limit = Math.min(500, parseInt((req.query.limit as string) ?? "200", 10) || 200);
      const rawLevel = typeof req.query.level === "string" ? req.query.level.toLowerCase() : "";
      const level = (
        rawLevel === "debug"
        || rawLevel === "info"
        || rawLevel === "warn"
        || rawLevel === "error"
      )
        ? rawLevel
        : undefined;
      const component = typeof req.query.component === "string" ? req.query.component.trim() : "";
      const contains = typeof req.query.contains === "string" ? req.query.contains.trim() : "";
      const sinceMsRaw = typeof req.query.sinceMs === "string"
        ? Number.parseInt(req.query.sinceMs, 10)
        : Number.NaN;
      const sinceMs = Number.isFinite(sinceMsRaw) ? sinceMsRaw : undefined;
      const payload = await readStructuredLogsFiltered(projectRoot, {
        limit,
        level,
        ...(component ? { component } : {}),
        ...(contains ? { contains } : {}),
        ...(sinceMs ? { sinceMs } : {}),
      });
      res.json(payload);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get("/api/usage/session", async (_req, res) => {
    try {
      const payload = await readSessionUsage(
        deps.getCurrentProject(),
        deps.sessionStartedAtMs,
      );
      res.json(payload);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post("/api/logs/client", async (req, res) => {
    try {
      const projectRoot = deps.getCurrentProject();
      const logger = createLogger("ui", resolveExistingProjectLogRoot(projectRoot));
      const body = isRecord(req.body) ? req.body : {};
      const component = typeof body.component === "string" && body.component.trim()
        ? body.component.trim()
        : "web";
      const level = typeof body.level === "string" ? body.level.toLowerCase() : "error";
      const message = typeof body.message === "string" ? body.message.trim() : "";
      if (!message) {
        res.status(400).json({ error: "message is required" });
        return;
      }

      const data = isRecord(body.data) ? body.data : undefined;
      const target = logger.child(component.replace(/[^a-z0-9:_-]/gi, "").slice(0, 80) || "web");
      if (level === "debug") target.debug(message, data);
      else if (level === "info") target.info(message, data);
      else if (level === "warn") target.warn(message, data);
      else target.error(message, data);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });
}
