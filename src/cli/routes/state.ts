import type { Express } from "express";
import { createLogger, logError, resolveExistingProjectLogRoot } from "../../logger.js";
import { getProjectState, readSessions } from "../services/state.js";

interface StateRouteDeps {
  getCurrentProject: () => string | null;
  getProject: () => string;
}

const STATE_ROUTE_TIMEOUT_MS = 15_000;

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

export function registerStateRoutes(app: Express, deps: StateRouteDeps): void {
  app.get("/api/state", async (_req, res) => {
    const logger = createLogger("api:state", resolveExistingProjectLogRoot(deps.getCurrentProject()));
    const projectRoot = deps.getCurrentProject();
    if (!projectRoot) {
      res.json({ initialized: false, projectRoot: null });
      return;
    }

    try {
      const state = await withTimeout(
        getProjectState(projectRoot),
        STATE_ROUTE_TIMEOUT_MS,
        "State load",
      );
      res.json(state);
    } catch (err) {
      logError(logger, "Failed to load project state", err, {
        requestId: res.locals.requestId as string | undefined,
        projectRoot,
      });
      const message = (err as Error).message;
      if (message.includes("timed out")) {
        res.status(504).json({ error: message });
        return;
      }
      res.status(500).json({ error: message });
    }
  });

  app.get("/api/sessions", async (_req, res) => {
    const logger = createLogger("api:state", resolveExistingProjectLogRoot(deps.getCurrentProject()));
    try {
      const sessions = await readSessions(deps.getProject());
      res.json(sessions);
    } catch (err) {
      logError(logger, "Failed to load sessions", err, {
        requestId: res.locals.requestId as string | undefined,
      });
      res.status(500).json({ error: (err as Error).message });
    }
  });
}
