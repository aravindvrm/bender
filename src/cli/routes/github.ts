import { basename, dirname } from "node:path";
import { existsSync } from "node:fs";
import { mkdir, readdir, stat } from "node:fs/promises";
import type { Express } from "express";
import { simpleGit } from "simple-git";

interface StoredGitHubAuthConfig {
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
}

interface GitHubSession {
  accessToken: string;
  tokenType?: string;
  scope?: string;
}

interface GitHubAuthConfig {
  clientId?: string;
  clientSecret?: string;
  redirectUri: string;
}

interface GitHubDeviceStart {
  sessionId: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  intervalSec: number;
  expiresAt: number;
}

type GitHubDevicePoll =
  | { status: "pending"; intervalSec: number }
  | { status: "connected"; login?: string }
  | { status: "denied" | "expired" };

interface GitHubRouteDeps {
  getCurrentProject: () => string | null;
  setCurrentProject: (path: string) => void;
  normalizeUserPath: (input?: string) => string;
  addToRegistry: (path: string) => Promise<void>;
  readStoredGitHubAuthConfig: () => Promise<StoredGitHubAuthConfig>;
  writeStoredGitHubAuthConfig: (config: StoredGitHubAuthConfig) => Promise<void>;
  getGithubAuthConfig: () => Promise<GitHubAuthConfig>;
  readGitHubSession: () => Promise<GitHubSession | null>;
  writeGitHubSession: (session: GitHubSession) => Promise<void>;
  clearGitHubSession: () => Promise<void>;
  startGitHubDeviceFlow: () => Promise<GitHubDeviceStart>;
  pollGitHubDeviceFlow: (sessionId: string) => Promise<GitHubDevicePoll>;
  githubApi: <T>(path: string, token: string, init?: RequestInit) => Promise<T>;
  authCloneUrl: (cloneUrl: string, token: string) => string;
  createAuthState: () => string;
  consumeAuthState: (state: string) => boolean;
}

export function registerGitHubRoutes(app: Express, deps: GitHubRouteDeps): void {
  app.get("/api/github/auth/config", async (_req, res) => {
    try {
      const stored = await deps.readStoredGitHubAuthConfig();
      const cfg = await deps.getGithubAuthConfig();
      res.json({
        clientId: cfg.clientId ?? "",
        clientSecretSet: !!cfg.clientSecret,
        redirectUri: cfg.redirectUri,
        usingEnvClientId: !!(process.env.GITHUB_APP_CLIENT_ID ?? process.env.GITHUB_CLIENT_ID),
        usingEnvClientSecret: !!(process.env.GITHUB_APP_CLIENT_SECRET ?? process.env.GITHUB_CLIENT_SECRET),
        storedClientId: stored.clientId ?? "",
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.put("/api/github/auth/config", async (req, res) => {
    try {
      const body = req.body as { clientId?: string; clientSecret?: string; redirectUri?: string };
      const existing = await deps.readStoredGitHubAuthConfig();
      const hasClientId = Object.prototype.hasOwnProperty.call(body, "clientId");
      const hasClientSecret = Object.prototype.hasOwnProperty.call(body, "clientSecret");
      const hasRedirectUri = Object.prototype.hasOwnProperty.call(body, "redirectUri");

      const nextConfig: StoredGitHubAuthConfig = {
        clientId: hasClientId ? (body.clientId?.trim() || undefined) : existing.clientId,
        clientSecret: hasClientSecret ? (body.clientSecret?.trim() || undefined) : existing.clientSecret,
        redirectUri: hasRedirectUri ? (body.redirectUri?.trim() || undefined) : existing.redirectUri,
      };
      await deps.writeStoredGitHubAuthConfig(nextConfig);
      const cfg = await deps.getGithubAuthConfig();
      res.json({
        ok: true,
        clientId: cfg.clientId ?? "",
        clientSecretSet: !!cfg.clientSecret,
        redirectUri: cfg.redirectUri,
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get("/api/github/auth/status", async (_req, res) => {
    try {
      const cfg = await deps.getGithubAuthConfig();
      if (!cfg.clientId) {
        res.json({
          configured: false,
          connected: false,
          message: "Set GITHUB_APP_CLIENT_ID to enable GitHub device login",
        });
        return;
      }

      const session = await deps.readGitHubSession();
      if (!session?.accessToken) {
        res.json({
          configured: true,
          connected: false,
          authMode: cfg.clientSecret ? "oauth-or-device" : "device-only",
        });
        return;
      }

      try {
        const user = await deps.githubApi<{ login: string; avatar_url?: string }>("/user", session.accessToken);
        res.json({
          configured: true,
          connected: true,
          login: user.login,
          avatarUrl: user.avatar_url,
          authMode: cfg.clientSecret ? "oauth-or-device" : "device-only",
        });
      } catch {
        await deps.clearGitHubSession();
        res.json({
          configured: true,
          connected: false,
          authMode: cfg.clientSecret ? "oauth-or-device" : "device-only",
        });
      }
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get("/api/github/auth/start", (_req, res) => {
    const run = async () => {
      const cfg = await deps.getGithubAuthConfig();
      if (!cfg.clientId || !cfg.clientSecret) {
        res.status(400).json({ error: "OAuth callback flow is not configured. Use GitHub device login instead." });
        return;
      }

      const state = deps.createAuthState();
      const params = new URLSearchParams({
        client_id: cfg.clientId,
        redirect_uri: cfg.redirectUri,
        scope: "repo read:org",
        state,
        allow_signup: "true",
      });
      res.json({ url: `https://github.com/login/oauth/authorize?${params.toString()}` });
    };
    void run().catch((err) => {
      res.status(500).json({ error: (err as Error).message });
    });
  });

  app.post("/api/github/device/start", async (_req, res) => {
    try {
      const flow = await deps.startGitHubDeviceFlow();
      res.json(flow);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post("/api/github/device/poll", async (req, res) => {
    try {
      const { sessionId } = req.body as { sessionId?: string };
      const id = (sessionId ?? "").trim();
      if (!id) {
        res.status(400).json({ error: "sessionId is required" });
        return;
      }
      const result = await deps.pollGitHubDeviceFlow(id);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get("/api/github/auth/callback", async (req, res) => {
    const cfg = await deps.getGithubAuthConfig();
    const state = typeof req.query.state === "string" ? req.query.state : "";
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const authError = typeof req.query.error === "string" ? req.query.error : "";

    if (authError) {
      res.status(400).send(`<html><body><h2>GitHub auth failed</h2><p>${authError}</p></body></html>`);
      return;
    }
    if (!deps.consumeAuthState(state)) {
      res.status(400).send("<html><body><h2>GitHub auth failed</h2><p>Invalid or expired state.</p></body></html>");
      return;
    }
    if (!cfg.clientId || !cfg.clientSecret || !code) {
      res.status(400).send("<html><body><h2>GitHub auth failed</h2><p>Missing configuration or code.</p></body></html>");
      return;
    }

    try {
      const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: cfg.clientId,
          client_secret: cfg.clientSecret,
          code,
          redirect_uri: cfg.redirectUri,
        }),
      });
      const tokenBody = await tokenRes.json() as {
        access_token?: string;
        token_type?: string;
        scope?: string;
        error?: string;
        error_description?: string;
      };
      if (!tokenRes.ok || !tokenBody.access_token) {
        const message = tokenBody.error_description ?? tokenBody.error ?? "No access token returned";
        throw new Error(message);
      }
      await deps.writeGitHubSession({
        accessToken: tokenBody.access_token,
        tokenType: tokenBody.token_type,
        scope: tokenBody.scope,
      });
      res.send("<html><body><h2>GitHub connected</h2><p>You can close this window and return to Bender.</p></body></html>");
    } catch (err) {
      res.status(500).send(`<html><body><h2>GitHub auth failed</h2><p>${(err as Error).message}</p></body></html>`);
    }
  });

  app.post("/api/github/auth/disconnect", async (_req, res) => {
    await deps.clearGitHubSession();
    res.json({ ok: true });
  });

  app.get("/api/github/installations", async (_req, res) => {
    try {
      const session = await deps.readGitHubSession();
      if (!session?.accessToken) {
        res.status(401).json({ error: "Not connected to GitHub" });
        return;
      }
      const data = await deps.githubApi<{ installations: Array<{ id: number; account?: { login?: string }; app_slug?: string }> }>(
        "/user/installations",
        session.accessToken,
      );
      res.json({
        installations: (data.installations ?? []).map((i) => ({
          id: i.id,
          account: i.account?.login ?? "",
          appSlug: i.app_slug ?? "",
        })),
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get("/api/github/repos", async (req, res) => {
    try {
      const installationId = typeof req.query.installationId === "string"
        ? parseInt(req.query.installationId, 10)
        : null;
      const session = await deps.readGitHubSession();
      if (!session?.accessToken) {
        res.status(401).json({ error: "Not connected to GitHub" });
        return;
      }

      const fetchInstallationRepos = async (id: number) => {
        const repos = await deps.githubApi<{
          repositories: Array<{
            id: number;
            name: string;
            full_name: string;
            private: boolean;
            clone_url: string;
            html_url: string;
            default_branch: string;
            owner?: { login?: string };
          }>;
        }>(`/user/installations/${id}/repositories?per_page=100`, session.accessToken);
        return (repos.repositories ?? []).map((r) => ({
          id: r.id,
          name: r.name,
          fullName: r.full_name,
          private: r.private,
          cloneUrl: r.clone_url,
          htmlUrl: r.html_url,
          defaultBranch: r.default_branch,
          owner: r.owner?.login ?? "",
          installationId: id,
        }));
      };

      if (installationId) {
        res.json({ repositories: await fetchInstallationRepos(installationId) });
        return;
      }

      const installs = await deps.githubApi<{ installations: Array<{ id: number }> }>("/user/installations", session.accessToken);
      const all = (
        await Promise.all((installs.installations ?? []).map((inst) => fetchInstallationRepos(inst.id)))
      ).flat();
      res.json({ repositories: all });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post("/api/github/clone", async (req, res) => {
    try {
      const { cloneUrl, targetPath } = req.body as { cloneUrl?: string; targetPath?: string };
      const rawCloneUrl = (cloneUrl ?? "").trim();
      const rawTarget = (targetPath ?? "").trim();
      if (!rawCloneUrl) { res.status(400).json({ error: "cloneUrl is required" }); return; }
      if (!rawTarget) { res.status(400).json({ error: "targetPath is required" }); return; }

      const normalizedTarget = deps.normalizeUserPath(rawTarget);
      if (existsSync(normalizedTarget)) {
        const targetStat = await stat(normalizedTarget);
        if (!targetStat.isDirectory()) {
          res.status(400).json({ error: "targetPath is not a directory" });
          return;
        }
        const entries = await readdir(normalizedTarget);
        if (entries.length > 0) {
          res.status(400).json({ error: "targetPath must be empty for clone" });
          return;
        }
      } else {
        await mkdir(normalizedTarget, { recursive: true });
      }

      const session = await deps.readGitHubSession();
      const cloneWithAuth = session?.accessToken ? deps.authCloneUrl(rawCloneUrl, session.accessToken) : rawCloneUrl;
      const git = simpleGit();
      await git.clone(cloneWithAuth, normalizedTarget);

      deps.setCurrentProject(normalizedTarget);
      await deps.addToRegistry(normalizedTarget);
      res.json({ ok: true, path: normalizedTarget, name: basename(normalizedTarget) });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });
}
