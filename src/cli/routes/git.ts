import type { Express } from "express";
import {
  checkoutGitBranch,
  commitGit,
  discardGit,
  fetchGit,
  getGitDiff,
  getGitIdentity,
  getGitRepoState,
  GitServiceError,
  initGitRepo,
  listGitBranches,
  pullGit,
  pushGit,
  setGitCredentialHelper,
  setGitIdentity,
  setGitRemote,
  stageGit,
  storeGitHubCredential,
  unstageGit,
} from "../services/git.js";

interface GitRouteDeps {
  getProject: () => string;
}

function toHttpError(err: unknown): { status: number; message: string } {
  if (err instanceof GitServiceError) {
    return { status: err.status, message: err.message };
  }
  return { status: 500, message: (err as Error).message };
}

export function registerGitRoutes(app: Express, deps: GitRouteDeps): void {
  app.get("/api/git/repo", async (_req, res) => {
    try {
      const repo = await getGitRepoState(deps.getProject());
      res.json(repo);
    } catch (err) {
      const mapped = toHttpError(err);
      res.status(mapped.status).json({ error: mapped.message });
    }
  });

  app.post("/api/git/init", async (req, res) => {
    try {
      const { force } = (req.body ?? {}) as { force?: boolean };
      const repo = await initGitRepo(deps.getProject(), !!force);
      res.json(repo);
    } catch (err) {
      const mapped = toHttpError(err);
      res.status(mapped.status).json({ error: mapped.message });
    }
  });

  app.post("/api/git/remote", async (req, res) => {
    try {
      const repo = await setGitRemote(deps.getProject(), req.body ?? {});
      res.json(repo);
    } catch (err) {
      const mapped = toHttpError(err);
      res.status(mapped.status).json({ error: mapped.message });
    }
  });

  app.get("/api/git/identity", async (_req, res) => {
    try {
      const identity = await getGitIdentity(deps.getProject());
      res.json(identity);
    } catch (err) {
      const mapped = toHttpError(err);
      res.status(mapped.status).json({ error: mapped.message });
    }
  });

  app.post("/api/git/identity", async (req, res) => {
    try {
      const result = await setGitIdentity(deps.getProject(), req.body ?? {});
      res.json(result);
    } catch (err) {
      const mapped = toHttpError(err);
      res.status(mapped.status).json({ error: mapped.message });
    }
  });

  app.post("/api/git/credential-helper", async (req, res) => {
    try {
      const result = await setGitCredentialHelper(deps.getProject(), req.body ?? {});
      res.json(result);
    } catch (err) {
      const mapped = toHttpError(err);
      res.status(mapped.status).json({ error: mapped.message });
    }
  });

  app.post("/api/git/github-credential", async (req, res) => {
    try {
      const result = await storeGitHubCredential(deps.getProject(), req.body ?? {});
      res.json(result);
    } catch (err) {
      const mapped = toHttpError(err);
      res.status(mapped.status).json({ error: mapped.message });
    }
  });

  app.get("/api/git/branches", async (_req, res) => {
    try {
      const branches = await listGitBranches(deps.getProject());
      res.json(branches);
    } catch (err) {
      const mapped = toHttpError(err);
      res.status(mapped.status).json({ error: mapped.message });
    }
  });

  app.post("/api/git/checkout", async (req, res) => {
    try {
      const repo = await checkoutGitBranch(deps.getProject(), req.body ?? {});
      res.json(repo);
    } catch (err) {
      const mapped = toHttpError(err);
      res.status(mapped.status).json({ error: mapped.message });
    }
  });

  app.post("/api/git/stage", async (req, res) => {
    try {
      const repo = await stageGit(deps.getProject(), req.body ?? {});
      res.json(repo);
    } catch (err) {
      const mapped = toHttpError(err);
      res.status(mapped.status).json({ error: mapped.message });
    }
  });

  app.post("/api/git/unstage", async (req, res) => {
    try {
      const repo = await unstageGit(deps.getProject(), req.body ?? {});
      res.json(repo);
    } catch (err) {
      const mapped = toHttpError(err);
      res.status(mapped.status).json({ error: mapped.message });
    }
  });

  app.post("/api/git/discard", async (req, res) => {
    try {
      const repo = await discardGit(deps.getProject(), req.body ?? {});
      res.json(repo);
    } catch (err) {
      const mapped = toHttpError(err);
      res.status(mapped.status).json({ error: mapped.message });
    }
  });

  app.post("/api/git/commit", async (req, res) => {
    try {
      const repo = await commitGit(deps.getProject(), req.body ?? {});
      res.json(repo);
    } catch (err) {
      const mapped = toHttpError(err);
      res.status(mapped.status).json({ error: mapped.message });
    }
  });

  app.post("/api/git/fetch", async (_req, res) => {
    try {
      const repo = await fetchGit(deps.getProject());
      res.json(repo);
    } catch (err) {
      const mapped = toHttpError(err);
      res.status(mapped.status).json({ error: mapped.message });
    }
  });

  app.post("/api/git/pull", async (req, res) => {
    try {
      const repo = await pullGit(deps.getProject(), req.body ?? {});
      res.json(repo);
    } catch (err) {
      const mapped = toHttpError(err);
      res.status(mapped.status).json({ error: mapped.message });
    }
  });

  app.post("/api/git/push", async (req, res) => {
    try {
      const repo = await pushGit(deps.getProject(), req.body ?? {});
      res.json(repo);
    } catch (err) {
      const mapped = toHttpError(err);
      res.status(mapped.status).json({ error: mapped.message });
    }
  });

  app.get("/api/git/diff", async (req, res) => {
    try {
      const result = await getGitDiff(deps.getProject(), req.query.commits);
      res.json(result);
    } catch (err) {
      const mapped = toHttpError(err);
      res.status(mapped.status).json({ error: mapped.message });
    }
  });
}
