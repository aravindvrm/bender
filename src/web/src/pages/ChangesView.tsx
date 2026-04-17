import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import type { ProjectState } from "../hooks/useApi";
import { LoadingDots } from "../components/LoadingDots";
import { SecretInput } from "../components/SecretInput";

interface GitViewProps {
  state: ProjectState;
  onStateChange: () => void;
}

interface GitRepoState {
  isRepo: boolean;
  branch: string | null;
  clean: boolean;
  ahead: number;
  behind: number;
  staged: string[];
  modified: string[];
  deleted: string[];
  untracked: string[];
  remotes: { name: string; fetch: string; push: string }[];
  error?: string;
}

interface BranchState {
  current: string;
  all: string[];
}

interface GitHubAuthStatus {
  configured: boolean;
  connected: boolean;
  login?: string;
  message?: string;
  authMode?: string;
}

interface GitHubDeviceStart {
  sessionId: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  intervalSec: number;
  expiresAt: number;
}

interface GitIdentityState {
  name: string;
  email: string;
  nameScope: "local" | "global" | "unset";
  emailScope: "local" | "global" | "unset";
  credentialHelper: string;
  credentialHelperScope: "local" | "global" | "unset";
  platform: string;
}

export function GitView({ state, onStateChange }: GitViewProps) {
  const [repo, setRepo] = useState<GitRepoState | null>(null);
  const [branches, setBranches] = useState<BranchState | null>(null);
  const [repoLoading, setRepoLoading] = useState(true);
  const [repoError, setRepoError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const [remoteUrl, setRemoteUrl] = useState("");
  const [newBranch, setNewBranch] = useState("");
  const [commitMessage, setCommitMessage] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);


  const [githubStatus, setGitHubStatus] = useState<GitHubAuthStatus | null>(null);
  const [githubLoading, setGitHubLoading] = useState(false);
  const [githubError, setGitHubError] = useState<string | null>(null);
  const [deviceFlow, setDeviceFlow] = useState<GitHubDeviceStart | null>(null);
  const [deviceFlowNotice, setDeviceFlowNotice] = useState<string | null>(null);

  const [identity, setIdentity] = useState<GitIdentityState | null>(null);
  const [identityLoading, setIdentityLoading] = useState(false);
  const [identityError, setIdentityError] = useState<string | null>(null);
  const [identityName, setIdentityName] = useState("");
  const [identityEmail, setIdentityEmail] = useState("");
  const [identityScope, setIdentityScope] = useState<"local" | "global">("local");
  const [credentialHelperInput, setCredentialHelperInput] = useState("");
  const [githubUsername, setGithubUsername] = useState("");
  const [githubToken, setGithubToken] = useState("");

  const pollTimeoutRef = useRef<number | null>(null);


  async function postJson<T>(url: string, body: Record<string, unknown> = {}): Promise<T> {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? `Request failed: ${url}`);
    return data as T;
  }

  async function getJson<T>(url: string): Promise<T> {
    const res = await fetch(url);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? `Request failed: ${url}`);
    return data as T;
  }

  function clearDevicePoll() {
    if (pollTimeoutRef.current !== null) {
      window.clearTimeout(pollTimeoutRef.current);
      pollTimeoutRef.current = null;
    }
  }

  const loadRepo = useCallback(async () => {
    setRepoLoading(true);
    setRepoError(null);
    try {
      const res = await fetch("/api/git/repo");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load repository status");
      const repoData = data as GitRepoState;
      setRepo(repoData);
      if (repoData.error) {
        setRepoError(repoData.error);
      }

      const origin = repoData.remotes.find((r) => r.name === "origin");
      if (origin?.fetch) setRemoteUrl(origin.fetch);

      if (repoData.isRepo) {
        try {
          const branchesRes = await fetch("/api/git/branches");
          const branchesData = await branchesRes.json();
          if (!branchesRes.ok) throw new Error(branchesData.error ?? "Failed to load branches");
          setBranches(branchesData as BranchState);
        } catch (err) {
          setBranches(null);
          const message = (err as Error).message;
          setRepoError((prev) => (prev ? `${prev} • Branches unavailable: ${message}` : `Branches unavailable: ${message}`));
        }
      } else {
        setBranches(null);
      }
    } catch (err) {
      setRepoError((err as Error).message);
      setRepo({
        isRepo: false,
        branch: null,
        clean: true,
        ahead: 0,
        behind: 0,
        staged: [],
        modified: [],
        deleted: [],
        untracked: [],
        remotes: [],
      });
      setBranches(null);
    } finally {
      setRepoLoading(false);
    }
  }, []);

  const loadGitHubStatus = useCallback(async () => {
    setGitHubLoading(true);
    setGitHubError(null);
    try {
      const status = await getJson<GitHubAuthStatus>("/api/github/auth/status");
      setGitHubStatus(status);
    } catch (err) {
      setGitHubError((err as Error).message);
    } finally {
      setGitHubLoading(false);
    }
  }, []);

  const loadIdentity = useCallback(async () => {
    setIdentityLoading(true);
    setIdentityError(null);
    try {
      const data = await getJson<GitIdentityState>("/api/git/identity");
      setIdentity(data);
      setIdentityName(data.name ?? "");
      setIdentityEmail(data.email ?? "");
      setIdentityScope(data.nameScope === "global" || data.emailScope === "global" ? "global" : "local");
      setCredentialHelperInput(data.credentialHelper ?? "");
    } catch (err) {
      setIdentityError((err as Error).message);
      setIdentity(null);
    } finally {
      setIdentityLoading(false);
    }
  }, []);

  const pollDeviceLogin = useCallback(async (sessionId: string, delayMs: number) => {
    clearDevicePoll();
    pollTimeoutRef.current = window.setTimeout(async () => {
      try {
        const result = await postJson<{ status: "pending" | "connected" | "expired" | "denied"; intervalSec?: number; login?: string }>(
          "/api/github/device/poll",
          { sessionId },
        );
        if (result.status === "connected") {
          setDeviceFlowNotice(result.login ? `Connected as @${result.login}` : "GitHub connected.");
          setDeviceFlow(null);
          clearDevicePoll();
          await loadGitHubStatus();
          return;
        }
        if (result.status === "pending") {
          pollDeviceLogin(sessionId, Math.max(2, result.intervalSec ?? 5) * 1000);
          return;
        }
        if (result.status === "denied") {
          setDeviceFlowNotice("GitHub authorization was denied.");
          setDeviceFlow(null);
          clearDevicePoll();
          await loadGitHubStatus();
          return;
        }
        setDeviceFlowNotice("GitHub device code expired. Start login again.");
        setDeviceFlow(null);
        clearDevicePoll();
      } catch (err) {
        setGitHubError((err as Error).message);
        clearDevicePoll();
      }
    }, delayMs);
  }, [loadGitHubStatus]);

  async function startDeviceLogin() {
    setGitHubError(null);
    setDeviceFlowNotice(null);
    try {
      const flow = await postJson<GitHubDeviceStart>("/api/github/device/start");
      setDeviceFlow(flow);
      const authorizeUrl = flow.verificationUriComplete || flow.verificationUri;
      window.open(authorizeUrl, "_blank", "noopener,noreferrer");
      setDeviceFlowNotice("Approve access in GitHub. We are waiting for confirmation...");
      pollDeviceLogin(flow.sessionId, Math.max(2, flow.intervalSec) * 1000);
    } catch (err) {
      setGitHubError((err as Error).message);
    }
  }

  async function disconnectGitHub() {
    setGitHubError(null);
    setDeviceFlowNotice(null);
    try {
      await postJson("/api/github/auth/disconnect");
      clearDevicePoll();
      setDeviceFlow(null);
      await loadGitHubStatus();
      setDeviceFlowNotice("Disconnected GitHub session.");
    } catch (err) {
      setGitHubError((err as Error).message);
    }
  }

  async function saveIdentity() {
    setIdentityError(null);
    try {
      await postJson("/api/git/identity", {
        name: identityName.trim(),
        email: identityEmail.trim(),
        scope: identityScope,
      });
      setActionNotice("Saved Git identity.");
      await loadIdentity();
    } catch (err) {
      setIdentityError((err as Error).message);
    }
  }

  async function saveCredentialHelper(useRecommended = false) {
    setIdentityError(null);
    try {
      await postJson("/api/git/credential-helper", {
        helper: useRecommended ? "" : credentialHelperInput.trim(),
        scope: identityScope,
      });
      setActionNotice("Saved credential helper.");
      await loadIdentity();
    } catch (err) {
      setIdentityError((err as Error).message);
    }
  }

  async function saveGitHubToken() {
    setIdentityError(null);
    try {
      await postJson("/api/git/github-credential", {
        username: githubUsername.trim(),
        token: githubToken.trim(),
      });
      setGithubToken("");
      setActionNotice("Stored GitHub credential in git credential helper.");
    } catch (err) {
      setIdentityError((err as Error).message);
    }
  }

  useEffect(() => {
    void loadRepo();
    void loadGitHubStatus();
    void loadIdentity();
    return () => {
      clearDevicePoll();
    };
  }, [loadRepo, loadGitHubStatus, loadIdentity, state.projectRoot]);

  const hasChanges = useMemo(() => {
    if (!repo) return false;
    return repo.staged.length + repo.modified.length + repo.deleted.length + repo.untracked.length > 0;
  }, [repo]);

  async function runAction(name: string, fn: () => Promise<void>) {
    setActionLoading(name);
    setActionError(null);
    setActionNotice(null);
    try {
      await fn();
      await loadRepo();
      onStateChange();
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setActionLoading(null);
    }
  }

  async function initGit() {
    await runAction("init", async () => {
      await postJson("/api/git/init", { force: true });
      setActionNotice(repo?.isRepo ? "Reinitialized git repository." : "Initialized git repository.");
    });
  }

  async function saveRemote() {
    if (!remoteUrl.trim()) return;
    await runAction("remote", async () => {
      await postJson("/api/git/remote", { name: "origin", url: remoteUrl.trim() });
      setActionNotice("Origin updated.");
    });
  }

  async function checkoutBranch(branch: string) {
    await runAction(`checkout-${branch}`, async () => {
      await postJson("/api/git/checkout", { branch });
      setActionNotice(`Checked out ${branch}.`);
    });
  }

  async function createBranch() {
    if (!newBranch.trim()) return;
    await runAction("create-branch", async () => {
      await postJson("/api/git/checkout", { branch: newBranch.trim(), create: true });
      setActionNotice(`Created and checked out ${newBranch.trim()}.`);
      setNewBranch("");
    });
  }

  async function stageFile(path: string) {
    await runAction(`stage-${path}`, async () => {
      await postJson("/api/git/stage", { path });
    });
  }

  async function stageAll() {
    await runAction("stage-all", async () => {
      await postJson("/api/git/stage", { all: true });
      setActionNotice("Staged all changes.");
    });
  }

  async function unstageFile(path: string) {
    await runAction(`unstage-${path}`, async () => {
      await postJson("/api/git/unstage", { path });
    });
  }

  async function discardFile(path: string) {
    const confirmed = window.confirm(`Discard local changes in ${path}?`);
    if (!confirmed) return;
    await runAction(`discard-${path}`, async () => {
      await postJson("/api/git/discard", { path });
      setActionNotice(`Discarded ${path}.`);
    });
  }

  async function commit() {
    if (!commitMessage.trim()) return;
    await runAction("commit", async () => {
      await postJson("/api/git/commit", { message: commitMessage.trim() });
      setActionNotice("Commit created.");
      setCommitMessage("");
    });
  }

  async function fetchRemote() {
    await runAction("fetch", async () => {
      await postJson("/api/git/fetch");
      setActionNotice("Fetched from remote.");
    });
  }

  async function pullRemote() {
    await runAction("pull", async () => {
      await postJson("/api/git/pull");
      setActionNotice("Pulled from remote.");
    });
  }

  async function pushRemote() {
    await runAction("push", async () => {
      await postJson("/api/git/push");
      setActionNotice("Pushed to remote.");
    });
  }

  return (
    <div className="space-y-6">
      <section className="border border-zinc-800 rounded-lg p-4 bg-zinc-900/40 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-zinc-200">Connect GitHub</h3>
          <button
            onClick={() => void loadGitHubStatus()}
            className="px-2.5 py-1 text-xs rounded border border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:border-zinc-600 transition-colors"
          >
            Refresh
          </button>
        </div>

        {githubLoading && <LoadingDots size={20} label="Checking GitHub status…" textClassName="text-sm text-zinc-500" />}
        {githubError && <p className="text-sm text-red-400/80">{githubError}</p>}
        {deviceFlowNotice && <p className="text-xs text-zinc-100">{deviceFlowNotice}</p>}

        {githubStatus && !githubStatus.configured && (
          <p className="text-sm text-amber-400">{githubStatus.message ?? "GitHub auth is not configured on this machine."}</p>
        )}

        {githubStatus?.configured && githubStatus.connected && (
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <p className="text-sm text-zinc-300">
              Connected as <span className="text-zinc-100">@{githubStatus.login}</span>
            </p>
            <button
              onClick={() => void disconnectGitHub()}
              className="px-2.5 py-1.5 text-xs rounded border border-zinc-700 text-zinc-300 hover:text-zinc-100 hover:border-zinc-500"
            >
              Disconnect
            </button>
          </div>
        )}

        {githubStatus?.configured && !githubStatus.connected && (
          <div className="space-y-3">
            <p className="text-xs text-zinc-500">
              Use device login to connect this local Bender session to GitHub without storing browser callback secrets.
            </p>
            <button
              onClick={() => void startDeviceLogin()}
              className="px-3 py-1.5 text-xs font-medium bg-zinc-100 text-zinc-900 rounded-md hover:bg-white transition-colors"
            >
              Start Device Login
            </button>

            {deviceFlow && (
              <div className="rounded-md border border-zinc-800 bg-zinc-950/60 p-3 space-y-2">
                <p className="text-[11px] text-zinc-500 uppercase tracking-wide">Verification Code</p>
                <p className="text-base font-mono text-zinc-100">{deviceFlow.userCode}</p>
                <div className="flex flex-wrap items-center gap-2">
                  <a
                    href={deviceFlow.verificationUriComplete || deviceFlow.verificationUri}
                    target="_blank"
                    rel="noreferrer"
                    className="px-2.5 py-1 text-xs rounded border border-zinc-700 text-zinc-300 hover:text-zinc-100 hover:border-zinc-500"
                  >
                    Open GitHub Authorization
                  </a>
                  <span className="text-[11px] text-zinc-600">
                    Expires at {new Date(deviceFlow.expiresAt).toLocaleTimeString()}
                  </span>
                </div>
              </div>
            )}
          </div>
        )}
      </section>

      <section className="border border-zinc-800 rounded-lg p-4 bg-zinc-900/40 space-y-4">
        <h3 className="text-sm font-medium text-zinc-200">Identity & Credentials</h3>
        {identityLoading && <LoadingDots size={20} label="Loading git identity…" textClassName="text-sm text-zinc-500" />}
        {identityError && <p className="text-sm text-red-400/80">{identityError}</p>}

        <div className="grid sm:grid-cols-[1fr_1fr_auto_auto] gap-2">
          <input
            value={identityName}
            onChange={(e) => setIdentityName(e.target.value)}
            placeholder="Git author name"
            className="bg-zinc-900 border border-zinc-700 rounded-md px-3 py-2 text-xs text-zinc-300"
          />
          <input
            value={identityEmail}
            onChange={(e) => setIdentityEmail(e.target.value)}
            placeholder="Git author email"
            className="bg-zinc-900 border border-zinc-700 rounded-md px-3 py-2 text-xs text-zinc-300"
          />
          <div className="relative">
            <select
              value={identityScope}
              onChange={(e) => setIdentityScope(e.target.value === "global" ? "global" : "local")}
              className="select-flat w-full pl-2 pr-7 py-2 text-xs"
            >
              <option value="local">Local Repo</option>
              <option value="global">Global</option>
            </select>
            <ChevronDown className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 h-3 w-3 text-zinc-500" />
          </div>
          <button
            onClick={() => void saveIdentity()}
            className="px-3 py-2 text-xs rounded border border-zinc-700 text-zinc-300 hover:text-zinc-100 hover:border-zinc-500"
          >
            Save
          </button>
        </div>

        <div className="space-y-2">
          <p className="text-[11px] text-zinc-600">
            Credential helper{identity?.credentialHelper ? ` (${identity.credentialHelperScope})` : ""}: {identity?.credentialHelper || "not set"}
          </p>
          <div className="grid sm:grid-cols-[1fr_auto_auto] gap-2">
            <input
              value={credentialHelperInput}
              onChange={(e) => setCredentialHelperInput(e.target.value)}
              placeholder={identity?.platform === "darwin" ? "osxkeychain" : "credential helper"}
              className="bg-zinc-900 border border-zinc-700 rounded-md px-3 py-2 text-xs text-zinc-300 font-mono"
            />
            <button
              onClick={() => void saveCredentialHelper(false)}
              className="px-3 py-2 text-xs rounded border border-zinc-700 text-zinc-300 hover:text-zinc-100 hover:border-zinc-500"
            >
              Save Helper
            </button>
            <button
              onClick={() => void saveCredentialHelper(true)}
              className="px-3 py-2 text-xs rounded border border-zinc-700 text-zinc-300 hover:text-zinc-100 hover:border-zinc-500"
            >
              Use Recommended
            </button>
          </div>
        </div>

        <div className="space-y-2">
          <p className="text-[11px] text-zinc-600">
            Optional fallback for HTTPS remotes: store GitHub username + PAT in credential helper.
          </p>
          <div className="grid sm:grid-cols-[1fr_1fr_auto] gap-2">
            <input
              value={githubUsername}
              onChange={(e) => setGithubUsername(e.target.value)}
              placeholder="GitHub username"
              className="bg-zinc-900 border border-zinc-700 rounded-md px-3 py-2 text-xs text-zinc-300"
            />
            <SecretInput
              value={githubToken}
              onChange={setGithubToken}
              placeholder="GitHub personal access token"
              inputClassName="bg-zinc-900 border border-zinc-700 rounded-md px-3 py-2 pr-9 text-xs text-zinc-300 w-full"
            />
            <button
              onClick={() => void saveGitHubToken()}
              disabled={!githubUsername.trim() || !githubToken.trim()}
              className="px-3 py-2 text-xs rounded border border-zinc-700 text-zinc-300 hover:text-zinc-100 hover:border-zinc-500 disabled:opacity-40"
            >
              Save Token
            </button>
          </div>
        </div>
      </section>

      <section className="border border-zinc-800 rounded-lg p-4 bg-zinc-900/40 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-zinc-200">Repository</h3>
          <button
            onClick={() => void loadRepo()}
            className="px-2.5 py-1 text-xs rounded border border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:border-zinc-600 transition-colors"
          >
            Refresh
          </button>
        </div>

        {repoLoading && <LoadingDots size={20} label="Loading git status…" textClassName="text-sm text-zinc-500" />}
        {repoError && <p className="text-sm text-red-400/80">{repoError}</p>}

        {!repoLoading && repo && !repo.isRepo && (
          <div className="space-y-3">
            <p className="text-sm text-zinc-400">This project is not a git repository yet.</p>
            <button
              onClick={() => void initGit()}
              disabled={actionLoading === "init"}
              className="px-3 py-1.5 text-xs font-medium bg-zinc-100 text-zinc-900 rounded-md hover:bg-white disabled:opacity-40 transition-colors"
            >
              {actionLoading === "init" ? "Initializing..." : "Initialize Git"}
            </button>
          </div>
        )}

        {!repoLoading && repo?.isRepo && (
          <div className="space-y-4">
            {repo.error && (
              <div className="space-y-2">
                <p className="text-xs text-amber-400">
                  Git metadata warning: {repo.error}
                </p>
                <button
                  onClick={() => void initGit()}
                  disabled={actionLoading === "init"}
                  className="px-2.5 py-1.5 text-xs rounded border border-amber-600/50 text-amber-300 hover:border-amber-400 hover:text-amber-200 disabled:opacity-40"
                >
                  {actionLoading === "init" ? "Repairing..." : "Reinitialize Git"}
                </button>
              </div>
            )}

            <div className="grid sm:grid-cols-4 gap-2">
              <Metric label="Branch" value={repo.branch ?? "unknown"} mono />
              <Metric label="Status" value={repo.clean ? "clean" : "dirty"} tone={repo.clean ? "ok" : "warn"} />
              <Metric label="Ahead" value={String(repo.ahead)} />
              <Metric label="Behind" value={String(repo.behind)} />
            </div>

            <div className="grid sm:grid-cols-[1fr_auto] gap-2">
              <div className="relative">
                <select
                  value={repo.branch ?? ""}
                  onChange={(e) => void checkoutBranch(e.target.value)}
                  className="select-flat w-full pl-2 pr-7 py-2 text-xs"
                >
                  {!branches && <option value="">No branches</option>}
                  {branches?.all.map((b) => <option key={b} value={b}>{b}</option>)}
                </select>
                <ChevronDown className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 h-3 w-3 text-zinc-500" />
              </div>
              <div className="flex gap-2">
                <input
                  value={newBranch}
                  onChange={(e) => setNewBranch(e.target.value)}
                  placeholder="new-branch"
                  className="w-40 bg-zinc-900 border border-zinc-700 rounded-md px-2 py-2 text-xs text-zinc-300 font-mono"
                />
                <button
                  onClick={() => void createBranch()}
                  disabled={!newBranch.trim() || actionLoading === "create-branch"}
                  className="px-2.5 py-2 text-xs rounded border border-zinc-700 text-zinc-300 hover:text-zinc-100 hover:border-zinc-500 disabled:opacity-40"
                >
                  Create
                </button>
              </div>
            </div>

            <div className="space-y-2">
              <label className="text-xs text-zinc-500">Origin remote URL</label>
              <div className="flex gap-2">
                <input
                  value={remoteUrl}
                  onChange={(e) => setRemoteUrl(e.target.value)}
                  placeholder="git@github.com:owner/repo.git"
                  className="flex-1 bg-zinc-900 border border-zinc-700 rounded-md px-3 py-2 text-xs text-zinc-300 font-mono focus:outline-none focus:border-zinc-500"
                />
                <button
                  onClick={() => void saveRemote()}
                  disabled={actionLoading === "remote" || !remoteUrl.trim()}
                  className="px-3 py-2 text-xs border border-zinc-700 rounded-md text-zinc-300 hover:text-zinc-100 hover:border-zinc-500 disabled:opacity-40 transition-colors"
                >
                  {actionLoading === "remote" ? "Saving..." : "Set Origin"}
                </button>
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => void fetchRemote()}
                disabled={actionLoading === "fetch"}
                className="px-2.5 py-1.5 text-xs rounded border border-zinc-700 text-zinc-300 hover:border-zinc-500 disabled:opacity-40"
              >
                Fetch
              </button>
              <button
                onClick={() => void pullRemote()}
                disabled={actionLoading === "pull"}
                className="px-2.5 py-1.5 text-xs rounded border border-zinc-700 text-zinc-300 hover:border-zinc-500 disabled:opacity-40"
              >
                Pull
              </button>
              <button
                onClick={() => void pushRemote()}
                disabled={actionLoading === "push"}
                className="px-2.5 py-1.5 text-xs rounded border border-zinc-700 text-zinc-300 hover:border-zinc-500 disabled:opacity-40"
              >
                Push
              </button>
              <button
                onClick={() => void stageAll()}
                disabled={actionLoading === "stage-all" || !hasChanges}
                className="px-2.5 py-1.5 text-xs rounded border border-zinc-700 text-zinc-300 hover:border-zinc-500 disabled:opacity-40"
              >
                Stage All
              </button>
            </div>

            <div className="space-y-2">
              <label className="text-xs text-zinc-500">Commit message</label>
              <div className="flex gap-2">
                <input
                  value={commitMessage}
                  onChange={(e) => setCommitMessage(e.target.value)}
                  placeholder="feat: summarize change"
                  className="flex-1 bg-zinc-900 border border-zinc-700 rounded-md px-3 py-2 text-xs text-zinc-300 font-mono focus:outline-none focus:border-zinc-500"
                />
                <button
                  onClick={() => void commit()}
                  disabled={actionLoading === "commit" || !commitMessage.trim()}
                  className="px-3 py-2 text-xs font-medium bg-zinc-100 text-zinc-900 rounded-md hover:bg-white disabled:opacity-40"
                >
                  Commit
                </button>
              </div>
            </div>

            <div className="grid sm:grid-cols-2 gap-3">
              <FileList title="Staged" files={repo.staged} actionLabel="Unstage" onAction={(p) => void unstageFile(p)} />
              <FileList title="Modified" files={repo.modified} actionLabel="Stage" onAction={(p) => void stageFile(p)} secondaryActionLabel="Discard" onSecondaryAction={(p) => void discardFile(p)} />
              <FileList title="Deleted" files={repo.deleted} actionLabel="Stage" onAction={(p) => void stageFile(p)} />
              <FileList title="Untracked" files={repo.untracked} actionLabel="Stage" onAction={(p) => void stageFile(p)} />
            </div>
          </div>
        )}

        {actionError && <p className="text-xs text-red-400">{actionError}</p>}
        {actionNotice && <p className="text-xs text-zinc-100">{actionNotice}</p>}
      </section>

    </div>
  );
}

function Metric({
  label,
  value,
  tone,
  mono,
}: {
  label: string;
  value: string;
  tone?: "ok" | "warn";
  mono?: boolean;
}) {
  const toneClass = tone === "ok" ? "text-zinc-100" : tone === "warn" ? "text-amber-400" : "text-zinc-200";
  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-950/40 px-3 py-2">
      <p className="text-[11px] text-zinc-600">{label}</p>
      <p className={`text-xs ${toneClass} ${mono ? "font-mono" : ""}`}>{value}</p>
    </div>
  );
}

function FileList({
  title,
  files,
  actionLabel,
  onAction,
  secondaryActionLabel,
  onSecondaryAction,
}: {
  title: string;
  files: string[];
  actionLabel: string;
  onAction: (path: string) => void;
  secondaryActionLabel?: string;
  onSecondaryAction?: (path: string) => void;
}) {
  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-950/40 p-3">
      <p className="text-[11px] text-zinc-500 mb-2">{title} ({files.length})</p>
      {files.length === 0 ? (
        <p className="text-xs text-zinc-600">None</p>
      ) : (
        <div className="space-y-1 max-h-44 overflow-y-auto">
          {files.map((file) => (
            <div key={file} className="flex items-center gap-2">
              <p className="text-xs text-zinc-300 font-mono truncate flex-1">{file}</p>
              {onSecondaryAction && secondaryActionLabel && (
                <button
                  onClick={() => onSecondaryAction(file)}
                  className="px-2 py-0.5 text-[10px] rounded border border-zinc-800 text-zinc-500 hover:text-red-300 hover:border-red-900/70"
                >
                  {secondaryActionLabel}
                </button>
              )}
              <button
                onClick={() => onAction(file)}
                className="px-2 py-0.5 text-[10px] rounded border border-zinc-700 text-zinc-300 hover:text-zinc-100 hover:border-zinc-500"
              >
                {actionLabel}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
