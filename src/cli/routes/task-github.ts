import type { Express } from "express";
import {
  commentTaskPr,
  createTaskBranch,
  createTaskIssue,
  createTaskPr,
  TaskGitHubServiceError,
} from "../services/task-github.js";

interface GitHubSession {
  accessToken: string;
}

interface TaskGitHubRouteDeps {
  getCurrentProject: () => string | null;
  readGitHubSession: () => Promise<GitHubSession | null>;
  githubApi: <T>(path: string, token: string, init?: RequestInit) => Promise<T>;
}

function toHttpError(err: unknown): { status: number; message: string } {
  if (err instanceof TaskGitHubServiceError) {
    return { status: err.status, message: err.message };
  }
  return { status: 500, message: (err as Error).message };
}

function requireProject(projectRoot: string | null): string {
  if (!projectRoot) {
    throw new TaskGitHubServiceError(400, "No project selected");
  }
  return projectRoot;
}

export function registerTaskGitHubRoutes(app: Express, deps: TaskGitHubRouteDeps): void {
  app.post("/api/tasks/:taskId/github/issue", async (req, res) => {
    try {
      const projectRoot = requireProject(deps.getCurrentProject());
      const result = await createTaskIssue(
        projectRoot,
        req.params.taskId,
        (req.body ?? {}) as { repoFullName?: string },
        {
          readGitHubSession: deps.readGitHubSession,
          githubApi: deps.githubApi,
        },
      );
      res.json({ ok: true, issueNumber: result.issueNumber, issueUrl: result.issueUrl, link: result.link });
    } catch (err) {
      const mapped = toHttpError(err);
      res.status(mapped.status).json({ error: mapped.message });
    }
  });

  app.post("/api/tasks/:taskId/github/branch", async (req, res) => {
    try {
      const projectRoot = requireProject(deps.getCurrentProject());
      const result = await createTaskBranch(
        projectRoot,
        req.params.taskId,
        (req.body ?? {}) as { branchName?: string },
      );
      res.json({ ok: true, branchName: result.branchName, created: result.created, link: result.link });
    } catch (err) {
      const mapped = toHttpError(err);
      res.status(mapped.status).json({ error: mapped.message });
    }
  });

  app.post("/api/tasks/:taskId/github/pr", async (req, res) => {
    try {
      const projectRoot = requireProject(deps.getCurrentProject());
      const result = await createTaskPr(
        projectRoot,
        req.params.taskId,
        (req.body ?? {}) as {
          repoFullName?: string;
          head?: string;
          title?: string;
          base?: string;
          body?: string;
        },
        {
          readGitHubSession: deps.readGitHubSession,
          githubApi: deps.githubApi,
        },
      );
      res.json({ ok: true, prNumber: result.prNumber, prUrl: result.prUrl, link: result.link });
    } catch (err) {
      const mapped = toHttpError(err);
      res.status(mapped.status).json({ error: mapped.message });
    }
  });

  app.post("/api/tasks/:taskId/github/pr/comment", async (req, res) => {
    try {
      const projectRoot = requireProject(deps.getCurrentProject());
      const result = await commentTaskPr(
        projectRoot,
        req.params.taskId,
        (req.body ?? {}) as { body?: string; repoFullName?: string; prNumber?: number },
        {
          readGitHubSession: deps.readGitHubSession,
          githubApi: deps.githubApi,
        },
      );
      res.json({ ok: true, commentUrl: result.commentUrl, link: result.link });
    } catch (err) {
      const mapped = toHttpError(err);
      res.status(mapped.status).json({ error: mapped.message });
    }
  });
}
