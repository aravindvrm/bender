import express from "express";
import cors from "cors";
import { join } from "node:path";
import { existsSync } from "node:fs";
import type { Server as HttpServer } from "node:http";
import { addToRegistry } from "../state/registry.js";
import { registerAgentRoutes } from "./routes/agents.js";
import { registerAuditRoutes } from "./routes/audits.js";
import { registerConfigRoutes } from "./routes/config.js";
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
import { fetchLiveModels, resolveProviderApiKey } from "./services/llm-models.js";

const API_PORT = 3142;
const SERVER_SESSION_STARTED_AT = Date.now();

let currentProject: string | null = null;

function getProject(): string {
  if (!currentProject) throw new Error("No project selected. Open a project first.");
  return currentProject;
}

export async function startServer(initialProject?: string, port = API_PORT): Promise<HttpServer> {
  if (initialProject) {
    currentProject = initialProject;
    await addToRegistry(initialProject);
  }

  const app = express();
  app.use(cors());
  app.use(express.json());

  const webDistDir = join(import.meta.dirname, "..", "web");
  if (existsSync(webDistDir)) app.use(express.static(webDistDir));

  const sse = createSseOperationRunner();
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
    getGithubAuthConfig: () => getGithubAuthConfig(API_PORT),
    readGitHubSession,
    writeGitHubSession,
    clearGitHubSession,
    startGitHubDeviceFlow: () => startGitHubDeviceFlow(API_PORT),
    pollGitHubDeviceFlow: (sessionId) => pollGitHubDeviceFlow(sessionId, API_PORT),
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

  registerFilesystemRoutes(app, { normalizeUserPath });

  registerLlmRoutes(app, {
    getCurrentProject: () => currentProject,
    normalizeUserPath,
    resolveProviderApiKey,
    fetchLiveModels,
  });

  registerStateRoutes(app, {
    getCurrentProject: () => currentProject,
    getProject,
  });

  registerConfigRoutes(app, {
    getCurrentProject: () => currentProject,
  });

  registerConnectorRoutes(app, {
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

  app.get("/{*path}", (_req, res) => {
    const indexPath = join(webDistDir, "index.html");
    if (existsSync(indexPath)) res.sendFile(indexPath);
    else res.status(404).send("Web UI not built. Run: npm run build:web");
  });

  return await new Promise<HttpServer>((resolvePromise, rejectPromise) => {
    const server = app.listen(port, "127.0.0.1", () => resolvePromise(server));
    server.once("error", rejectPromise);
  });
}
