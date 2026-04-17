import express from "express";
import cors from "cors";
import { join } from "node:path";
import { existsSync } from "node:fs";
import type { Server as HttpServer } from "node:http";
import type { Request, Response, NextFunction } from "express";
import { addToRegistry } from "../state/registry.js";
import { registerAgentRoutes } from "./routes/agents.js";
import { registerAuditRoutes } from "./routes/audits.js";
import { registerConfigRoutes } from "./routes/config.js";
import { registerChatRoutes } from "./routes/chat.js";
import { registerConnectorRoutes } from "./routes/connectors.js";
import { registerEvalRoutes } from "./routes/evals.js";
import { registerFilesystemRoutes } from "./routes/filesystem.js";
import { registerGitRoutes } from "./routes/git.js";
import { registerGitHubRoutes } from "./routes/github.js";
import { registerGitHubWorkItemRoutes } from "./routes/github-work-items.js";
import { registerLlmRoutes } from "./routes/llm.js";
import { registerLogRoutes } from "./routes/logs.js";
import { registerProjectRoutes } from "./routes/projects.js";
import { registerRunRoutes } from "./routes/run.js";
import { registerSkillRoutes } from "./routes/skills.js";
import { registerStateRoutes } from "./routes/state.js";
import { registerTaskRoutes } from "./routes/tasks.js";
import { registerTaskGitHubRoutes } from "./routes/task-github.js";
import { registerTerminalRoutes } from "./routes/terminal.js";
import {
  authCloneUrl,
  clearGitHubSession,
  consumeGitHubAuthState,
  createGitHubAuthState,
  getGithubAuthConfig,
  githubApi,
  pollGitHubDeviceFlow,
  readGitHubSession,
  readStoredGitHubAuthConfig,
  startGitHubDeviceFlow,
  writeGitHubSession,
  writeStoredGitHubAuthConfig,
} from "./services/github-auth.js";
import { normalizeUserPath } from "./services/path-utils.js";
import { createSseOperationRunner } from "./services/sse.js";
import { CURATED_MCP_CONNECTORS, createConnectorHealthManager } from "./services/connector-health.js";
import {
  detectOpenAiCompatibleCapabilities,
  fetchLiveModels,
  resolveProviderApiKey,
  resolveProviderBaseUrl,
} from "./services/llm-models.js";
import { resolveServerPort } from "./server-config.js";
import {
  createLogger,
  createRequestId,
  logError,
  resolveExistingProjectLogRoot,
} from "../logger.js";

const SERVER_SESSION_STARTED_AT = Date.now();

let currentProject: string | null = null;

function getProject(): string {
  if (!currentProject) throw new Error("No project selected. Open a project first.");
  return currentProject;
}

export async function startServer(initialProject?: string, port?: number): Promise<HttpServer> {
  const runtimePort = resolveServerPort(port);

  if (initialProject) {
    currentProject = initialProject;
    await addToRegistry(initialProject);
  }

  const app = express();
  app.use(cors());
  app.use(express.json());

  app.use((req: Request, res: Response, next: NextFunction) => {
    if (!req.path.startsWith("/api/")) {
      next();
      return;
    }

    const requestId = createRequestId();
    const startedAt = Date.now();
    const logger = createLogger("api", resolveExistingProjectLogRoot(currentProject));

    res.setHeader("x-bender-request-id", requestId);
    res.locals.requestId = requestId;

    logger.info("API request started", {
      requestId,
      method: req.method,
      path: req.path,
      hasProject: !!currentProject,
    });

    res.on("finish", () => {
      const elapsedMs = Date.now() - startedAt;
      const payload = {
        requestId,
        method: req.method,
        path: req.path,
        statusCode: res.statusCode,
        elapsedMs,
      };
      if (res.statusCode >= 500) {
        logger.error("API request failed", payload);
      } else if (res.statusCode >= 400) {
        logger.warn("API request completed with client error", payload);
      } else {
        logger.info("API request completed", payload);
      }
    });

    res.on("close", () => {
      if (res.writableEnded) return;
      logger.warn("API request closed before response completed", {
        requestId,
        method: req.method,
        path: req.path,
        elapsedMs: Date.now() - startedAt,
      });
    });

    next();
  });

  const webDistDir = join(import.meta.dirname, "..", "web");
  if (existsSync(webDistDir)) app.use(express.static(webDistDir));

  const sse = createSseOperationRunner({
    getCurrentProject: () => resolveExistingProjectLogRoot(currentProject),
  });
  const connectorHealth = createConnectorHealthManager();

  registerProjectRoutes(app, {
    getCurrentProject: () => currentProject,
    setCurrentProject: (path) => { currentProject = path; },
    normalizeUserPath,
  });

  registerGitHubRoutes(app, {
    getCurrentProject: () => currentProject,
    setCurrentProject: (path) => { currentProject = path; },
    normalizeUserPath,
    addToRegistry,
    readStoredGitHubAuthConfig,
    writeStoredGitHubAuthConfig,
    getGithubAuthConfig: () => getGithubAuthConfig(runtimePort),
    readGitHubSession,
    writeGitHubSession,
    clearGitHubSession,
    startGitHubDeviceFlow: () => startGitHubDeviceFlow(runtimePort),
    pollGitHubDeviceFlow: (sessionId) => pollGitHubDeviceFlow(sessionId, runtimePort),
    githubApi,
    authCloneUrl,
    createAuthState: createGitHubAuthState,
    consumeAuthState: consumeGitHubAuthState,
  });
  registerGitHubWorkItemRoutes(app, {
    getCurrentProject: () => currentProject,
    readGitHubSession,
    githubApi,
  });

  registerFilesystemRoutes(app, {
    normalizeUserPath,
    getCurrentProject: () => currentProject,
  });

  registerLlmRoutes(app, {
    getCurrentProject: () => currentProject,
    normalizeUserPath,
    resolveProviderApiKey,
    resolveProviderBaseUrl,
    fetchLiveModels,
    detectOpenAiCompatibleCapabilities,
  });

  registerStateRoutes(app, {
    getCurrentProject: () => currentProject,
    getProject,
  });

  registerChatRoutes(app, {
    getProject,
    getCurrentProject: () => currentProject,
  });

  registerConfigRoutes(app, {
    getCurrentProject: () => currentProject,
  });

  registerConnectorRoutes(app, {
    getCurrentProject: () => currentProject,
    curatedConnectors: CURATED_MCP_CONNECTORS,
    getConnectorHealthStatus: connectorHealth.getConnectorHealthStatus,
    clearConnectorHealthCache: connectorHealth.clearConnectorHealthCache,
  });

  registerGitRoutes(app, { getProject });

  registerLogRoutes(app, {
    getCurrentProject: () => currentProject,
    getProject,
    sessionStartedAtMs: SERVER_SESSION_STARTED_AT,
  });

  registerTerminalRoutes(app, { getProject });

  registerTaskRoutes(app, {
    getCurrentProject: () => currentProject,
    getProject,
  });
  registerTaskGitHubRoutes(app, {
    getCurrentProject: () => currentProject,
    readGitHubSession,
    githubApi,
  });

  registerRunRoutes(app, {
    getProject,
    getCurrentProject: () => currentProject,
    setCurrentProject: (path) => { currentProject = path; },
    normalizeUserPath,
    resolvePendingAnswer: sse.resolvePendingAnswer,
    runOperation: sse.runOperation,
  });

  registerAuditRoutes(app, { getProject, runOperation: sse.runOperation });
  registerEvalRoutes(app, { getProject, runOperation: sse.runOperation });

  registerSkillRoutes(app, {
    getCurrentProject: () => currentProject,
  });

  registerAgentRoutes(app);

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/{*path}", (_req, res) => {
    const indexPath = join(webDistDir, "index.html");
    if (existsSync(indexPath)) res.sendFile(indexPath);
    else res.status(404).send("Web UI not built. Run: npm run build:web");
  });

  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    const requestId = typeof res.locals.requestId === "string"
      ? res.locals.requestId
      : createRequestId();
    const logger = createLogger("api", resolveExistingProjectLogRoot(currentProject));
    logError(logger, "Unhandled API error", err, {
      requestId,
      method: req.method,
      path: req.path,
    });
    if (res.headersSent) return;
    res.status(500).json({
      error: "Internal server error",
      requestId,
    });
  });

  return await new Promise<HttpServer>((resolvePromise, rejectPromise) => {
    const server = app.listen(runtimePort, "127.0.0.1", () => resolvePromise(server));
    server.once("error", rejectPromise);
  });
}
