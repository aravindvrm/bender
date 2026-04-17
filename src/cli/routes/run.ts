import type { Express, Response } from "express";
import type { UIAdapter } from "../adapter.js";
import { createLogger, resolveExistingProjectLogRoot } from "../../logger.js";
import {
  runAnalyzeOperation,
  runFlowsOperation,
  runImplementOperation,
  runInitOperation,
  runPlanOperation,
} from "../services/run-operations.js";

interface RunRouteDeps {
  getProject: () => string;
  setCurrentProject: (path: string) => void;
  normalizeUserPath: (input?: string) => string;
  resolvePendingAnswer: (id: string, answer: string) => boolean;
  runOperation: (
    res: Response,
    operation: (adapter: UIAdapter) => Promise<void>,
  ) => Promise<void>;
  getCurrentProject?: () => string | null;
}

export function registerRunRoutes(app: Express, deps: RunRouteDeps): void {
  app.post("/api/run/answer", (req, res) => {
    const logger = createLogger(
      "api:run",
      resolveExistingProjectLogRoot(deps.getCurrentProject?.() ?? null),
    );
    const { id, answer } = req.body as { id: string; answer: string };
    if (deps.resolvePendingAnswer(id, answer)) {
      res.json({ ok: true });
      return;
    }
    logger.warn("Rejected run answer request: pending question not found", {
      requestId: res.locals.requestId as string | undefined,
      id,
    });
    res.status(404).json({ error: "No pending question with that id" });
  });

  app.post("/api/run/init", async (req, res) => {
    const body = (req.body ?? {}) as {
      description?: string;
      path?: string;
      template?: "nextjs-saas" | "express-api" | "auto";
      llmProvider?: "anthropic" | "openai" | "google" | "groq" | "ollama" | "openai-compatible";
      llmApiKey?: string;
    };

    await deps.runOperation(res, async (adapter) => {
      await runInitOperation(
        {
          getProject: deps.getProject,
          setCurrentProject: deps.setCurrentProject,
          normalizeUserPath: deps.normalizeUserPath,
        },
        body,
        adapter,
      );
    });
  });

  app.post("/api/run/plan", async (req, res) => {
    const logger = createLogger(
      "api:run",
      resolveExistingProjectLogRoot(deps.getCurrentProject?.() ?? null),
    );
    const body = (req.body ?? {}) as {
      feature?: string;
      role?: "analyzer" | "architect" | "planner" | "implementer" | "reviewer";
      agentId?: string;
      officeHoursMode?: "pressure-test" | "execution-plan";
      askClarifyingQuestions?: boolean;
      requireArchitectureApproval?: boolean;
      requirePlanApproval?: boolean;
    };

    if (!body.feature) {
      logger.warn("Rejected run plan request: feature missing", {
        requestId: res.locals.requestId as string | undefined,
      });
      res.status(400).json({ error: "feature is required" });
      return;
    }

    await deps.runOperation(res, async (adapter) => {
      await runPlanOperation(deps.getProject(), body, adapter);
    });
  });

  app.post("/api/run/implement", async (req, res) => {
    const body = (req.body ?? {}) as { taskId?: number };
    await deps.runOperation(res, async (adapter) => {
      await runImplementOperation(deps.getProject(), body, adapter);
    });
  });

  app.post("/api/run/analyze", async (_req, res) => {
    await deps.runOperation(res, async (adapter) => {
      await runAnalyzeOperation(deps.getProject(), adapter);
    });
  });

  app.post("/api/run/flows", async (_req, res) => {
    await deps.runOperation(res, async (adapter) => {
      await runFlowsOperation(deps.getProject(), adapter);
    });
  });
}
