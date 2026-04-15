import type { Express } from "express";
import {
  extractGitHubWorkItems,
  GitHubWorkItemsServiceError,
  importGitHubWorkItems,
  listGitHubWorkItems,
  type GitHubWorkItem,
  type ListGitHubWorkItemsInput,
} from "../services/github-work-items.js";

interface GitHubSession {
  accessToken: string;
}

interface GitHubWorkItemRouteDeps {
  getCurrentProject: () => string | null;
  readGitHubSession: () => Promise<GitHubSession | null>;
  githubApi: <T>(path: string, token: string, init?: RequestInit) => Promise<T>;
}

function toHttpError(err: unknown): { status: number; message: string } {
  if (err instanceof GitHubWorkItemsServiceError) {
    return { status: err.status, message: err.message };
  }
  return { status: 500, message: (err as Error).message };
}

function requireProject(projectRoot: string | null): string {
  if (!projectRoot) {
    throw new GitHubWorkItemsServiceError(400, "No project selected");
  }
  return projectRoot;
}

function parseListInput(query: Record<string, unknown>): ListGitHubWorkItemsInput {
  const labels = typeof query.labels === "string"
    ? query.labels.split(",").map((value) => value.trim()).filter(Boolean)
    : [];

  const limit = typeof query.limit === "string" ? Number.parseInt(query.limit, 10) : undefined;
  const unlinkedOnly = typeof query.unlinkedOnly === "string"
    ? ["1", "true", "yes"].includes(query.unlinkedOnly.toLowerCase())
    : false;

  const state = typeof query.state === "string" && ["open", "closed", "all"].includes(query.state)
    ? (query.state as "open" | "closed" | "all")
    : undefined;

  return {
    state,
    labels,
    assignee: typeof query.assignee === "string" ? query.assignee : undefined,
    milestone: typeof query.milestone === "string" ? query.milestone : undefined,
    q: typeof query.q === "string" ? query.q : undefined,
    unlinkedOnly,
    limit,
  };
}

function parseExtractionBody(body: Record<string, unknown>): { workItems?: Array<Partial<GitHubWorkItem>> } {
  return {
    workItems: Array.isArray(body.workItems) ? body.workItems as Array<Partial<GitHubWorkItem>> : undefined,
  };
}

export function registerGitHubWorkItemRoutes(app: Express, deps: GitHubWorkItemRouteDeps): void {
  app.get("/api/github/work-items", async (req, res) => {
    try {
      const projectRoot = requireProject(deps.getCurrentProject());
      const result = await listGitHubWorkItems(projectRoot, parseListInput(req.query as Record<string, unknown>), {
        readGitHubSession: deps.readGitHubSession,
        githubApi: deps.githubApi,
      });
      res.json(result);
    } catch (err) {
      const mapped = toHttpError(err);
      res.status(mapped.status).json({ error: mapped.message });
    }
  });

  app.post("/api/github/work-items/extract", async (req, res) => {
    try {
      const projectRoot = requireProject(deps.getCurrentProject());
      const result = await extractGitHubWorkItems(
        projectRoot,
        parseExtractionBody((req.body ?? {}) as Record<string, unknown>),
        {
          readGitHubSession: deps.readGitHubSession,
          githubApi: deps.githubApi,
        },
      );
      res.json(result);
    } catch (err) {
      const mapped = toHttpError(err);
      res.status(mapped.status).json({ error: mapped.message });
    }
  });

  app.post("/api/github/work-items/import", async (req, res) => {
    try {
      const projectRoot = requireProject(deps.getCurrentProject());
      const body = (req.body ?? {}) as { candidates?: unknown[] };
      const result = await importGitHubWorkItems(projectRoot, {
        candidates: Array.isArray(body.candidates) ? [...body.candidates] : undefined,
      });
      res.json(result);
    } catch (err) {
      const mapped = toHttpError(err);
      res.status(mapped.status).json({ error: mapped.message });
    }
  });
}
