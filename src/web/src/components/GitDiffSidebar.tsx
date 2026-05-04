import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import {
  ChevronDown,
  GitBranch,
  RefreshCw,
  X,
} from "lucide-react";
import type { OperationStatus } from "../hooks/useOperation";
import { GitDiffViewer } from "./GitDiffViewer";
import { LoadingDots } from "./LoadingDots";
import { SecretInput } from "./SecretInput";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface GitDiffSidebarProps {
  open: boolean;
  projectPath: string | null;
  operationStatus: OperationStatus;
  onClose?: () => void;
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

type GitTab = "diff" | "changes" | "setup";

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

async function postJson<T>(url: string, body: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `Request failed: ${url}`);
  return data as T;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `Request failed: ${url}`);
  return data as T;
}

// ---------------------------------------------------------------------------
// FileList sub-component
// ---------------------------------------------------------------------------

function FileList({
  title,
  tone,
  files,
  actionLabel,
  onAction,
  secondaryActionLabel,
  onSecondaryAction,
}: {
  title: string;
  tone?: "added" | "modified" | "deleted" | "untracked";
  files: string[];
  actionLabel: string;
  onAction: (path: string) => void;
  secondaryActionLabel?: string;
  onSecondaryAction?: (path: string) => void;
}) {
  const dotColor =
    tone === "added" ? "bg-bender-success" :
    tone === "deleted" ? "bg-bender-danger" :
    tone === "modified" ? "bg-bender-warning" :
    "bg-zinc-500";

  if (files.length === 0) return null;

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5">
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotColor}`} />
        <p className="text-[11px] text-zinc-500 uppercase tracking-wide">
          {title} <span className="text-zinc-600 normal-case">({files.length})</span>
        </p>
      </div>
      <div className="space-y-px">
        {files.map((file) => (
          <div key={file} className="flex items-center gap-1 group rounded px-1 py-0.5 hover:bg-zinc-800/60">
            <p className="text-[11px] text-zinc-300 font-mono truncate flex-1">{file}</p>
            {onSecondaryAction && secondaryActionLabel && (
              <button
                onClick={() => onSecondaryAction(file)}
                className="px-1.5 py-0.5 text-[10px] rounded border border-transparent text-zinc-600 hover:text-bender-danger hover:border-bender-danger/30 opacity-0 group-hover:opacity-100 transition-opacity"
              >
                {secondaryActionLabel}
              </button>
            )}
            <button
              onClick={() => onAction(file)}
              className="px-1.5 py-0.5 text-[10px] rounded border border-zinc-700 text-zinc-400 hover:text-zinc-100 hover:border-zinc-500 opacity-0 group-hover:opacity-100 transition-opacity"
            >
              {actionLabel}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function GitDiffSidebar({ open, projectPath, operationStatus, onClose }: GitDiffSidebarProps) {
  // Panel state
  const [tab, setTab] = useState<GitTab>("diff");
  const [width, setWidth] = useState(480);
  const [resizing, setResizing] = useState(false);
  const resizeStartX = useRef(0);
  const resizeStartWidth = useRef(480);

  // Diff tab
  const [diffCommits, setDiffCommits] = useState(1);
  const [diffRaw, setDiffRaw] = useState<string | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  // Changes tab — repo state
  const [repo, setRepo] = useState<GitRepoState | null>(null);
  const [branches, setBranches] = useState<BranchState | null>(null);
  const [repoLoading, setRepoLoading] = useState(false);
  const [repoError, setRepoError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [newBranch, setNewBranch] = useState("");
  const [commitMessage, setCommitMessage] = useState("");
  const [remoteUrl, setRemoteUrl] = useState("");

  // Setup tab
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
  const [showBranchDropdown, setShowBranchDropdown] = useState(false);

  const pollTimeoutRef = useRef<number | null>(null);
  const canLoad = open && !!projectPath;

  // -------------------------------------------------------------------------
  // Resize handle
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (!resizing) return;
    const onMouseMove = (e: MouseEvent) => {
      const delta = resizeStartX.current - e.clientX;
      setWidth(Math.max(360, Math.min(840, resizeStartWidth.current + delta)));
    };
    const onMouseUp = () => {
      setResizing(false);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    return () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };
  }, [resizing]);

  const startResize = (e: ReactMouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    resizeStartX.current = e.clientX;
    resizeStartWidth.current = width;
    setResizing(true);
    document.body.style.cursor = "ew-resize";
    document.body.style.userSelect = "none";
  };

  // -------------------------------------------------------------------------
  // Diff tab loader
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (!canLoad) return;
    let cancelled = false;
    setDiffLoading(true);
    setDiffError(null);
    fetch(`/api/git/diff?commits=${diffCommits}`)
      .then(async (r) => {
        const raw = await r.text();
        let data: { diff?: unknown; error?: string } = {};
        try { data = raw ? JSON.parse(raw) as typeof data : {}; } catch { throw new Error("Failed to parse diff response"); }
        if (!r.ok) throw new Error(data.error ?? "Failed to load diff");
        if (cancelled) return;
        setDiffRaw(typeof data.diff === "string" ? data.diff : null);
        setDiffLoading(false);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setDiffError(err.message);
        setDiffLoading(false);
      });
    return () => { cancelled = true; };
  }, [canLoad, diffCommits, refreshTick]);

  // Auto-refresh diff after operation completes
  useEffect(() => {
    if (!open) return;
    if (operationStatus === "done" || operationStatus === "error") {
      setRefreshTick((v) => v + 1);
    }
  }, [open, operationStatus]);

  // -------------------------------------------------------------------------
  // Repo / branch loader
  // -------------------------------------------------------------------------

  const loadRepo = useCallback(async () => {
    if (!projectPath) return;
    setRepoLoading(true);
    setRepoError(null);
    try {
      const data = await getJson<GitRepoState>("/api/git/repo");
      setRepo(data);
      if (data.error) setRepoError(data.error);
      const origin = data.remotes.find((r) => r.name === "origin");
      if (origin?.fetch) setRemoteUrl(origin.fetch);
      if (data.isRepo) {
        try {
          const bd = await getJson<BranchState>("/api/git/branches");
          setBranches(bd);
        } catch { setBranches(null); }
      } else {
        setBranches(null);
      }
    } catch (err) {
      setRepoError((err as Error).message);
      setRepo({ isRepo: false, branch: null, clean: true, ahead: 0, behind: 0, staged: [], modified: [], deleted: [], untracked: [], remotes: [] });
      setBranches(null);
    } finally {
      setRepoLoading(false);
    }
  }, [projectPath]);

  // Auto-refresh working tree after operation completes (same trigger as diff)
  useEffect(() => {
    if (!open) return;
    if (operationStatus === "done" || operationStatus === "error") {
      void loadRepo();
    }
  }, [open, operationStatus, loadRepo]);

  // Load everything when panel opens
  useEffect(() => {
    if (!canLoad) return;
    void loadRepo();
  }, [canLoad, loadRepo]);

  // -------------------------------------------------------------------------
  // GitHub auth
  // -------------------------------------------------------------------------

  const loadGitHubStatus = useCallback(async () => {
    setGitHubLoading(true);
    setGitHubError(null);
    try {
      setGitHubStatus(await getJson<GitHubAuthStatus>("/api/github/auth/status"));
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

  // Load setup data lazily when Setup tab is first opened
  useEffect(() => {
    if (!canLoad || tab !== "setup") return;
    if (!githubStatus && !githubLoading) void loadGitHubStatus();
    if (!identity && !identityLoading) void loadIdentity();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canLoad, tab]);

  function clearDevicePoll() {
    if (pollTimeoutRef.current !== null) {
      window.clearTimeout(pollTimeoutRef.current);
      pollTimeoutRef.current = null;
    }
  }

  const pollDeviceLogin = useCallback(
    async (sessionId: string, delayMs: number) => {
      clearDevicePoll();
      pollTimeoutRef.current = window.setTimeout(async () => {
        try {
          const result = await postJson<{ status: "pending" | "connected" | "expired" | "denied"; intervalSec?: number; login?: string }>(
            "/api/github/device/poll", { sessionId },
          );
          if (result.status === "connected") {
            setDeviceFlowNotice(result.login ? `Connected as @${result.login}` : "GitHub connected.");
            setDeviceFlow(null);
            clearDevicePoll();
            await loadGitHubStatus();
            return;
          }
          if (result.status === "pending") { pollDeviceLogin(sessionId, Math.max(2, result.intervalSec ?? 5) * 1000); return; }
          if (result.status === "denied") {
            setDeviceFlowNotice("GitHub authorization was denied.");
            setDeviceFlow(null);
            clearDevicePoll();
            await loadGitHubStatus();
            return;
          }
          setDeviceFlowNotice("Device code expired. Start login again.");
          setDeviceFlow(null);
          clearDevicePoll();
        } catch (err) {
          setGitHubError((err as Error).message);
          clearDevicePoll();
        }
      }, delayMs);
    },
    [loadGitHubStatus],
  );

  useEffect(() => () => clearDevicePoll(), []);

  async function startDeviceLogin() {
    setGitHubError(null);
    setDeviceFlowNotice(null);
    try {
      const flow = await postJson<GitHubDeviceStart>("/api/github/device/start");
      setDeviceFlow(flow);
      window.open(flow.verificationUriComplete || flow.verificationUri, "_blank", "noopener,noreferrer");
      setDeviceFlowNotice("Approve access in GitHub. Waiting for confirmation…");
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

  // -------------------------------------------------------------------------
  // Git actions (changes tab)
  // -------------------------------------------------------------------------

  async function runAction(name: string, fn: () => Promise<void>) {
    setActionLoading(name);
    setActionError(null);
    setActionNotice(null);
    try {
      await fn();
      await loadRepo();
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setActionLoading(null);
    }
  }

  const initGit = () => runAction("init", async () => {
    await postJson("/api/git/init", { force: true });
    setActionNotice(repo?.isRepo ? "Reinitialized git repository." : "Initialized git repository.");
  });

  const fetchRemote = () => runAction("fetch", async () => {
    await postJson("/api/git/fetch");
    setActionNotice("Fetched from remote.");
  });

  const pullRemote = () => runAction("pull", async () => {
    await postJson("/api/git/pull");
    setActionNotice("Pulled.");
  });

  const pushRemote = () => runAction("push", async () => {
    await postJson("/api/git/push");
    setActionNotice("Pushed.");
  });

  const checkoutBranch = (branch: string) => runAction(`checkout-${branch}`, async () => {
    await postJson("/api/git/checkout", { branch });
    setActionNotice(`Checked out ${branch}.`);
    setShowBranchDropdown(false);
  });

  const createBranch = () => runAction("create-branch", async () => {
    if (!newBranch.trim()) return;
    await postJson("/api/git/checkout", { branch: newBranch.trim(), create: true });
    setActionNotice(`Created ${newBranch.trim()}.`);
    setNewBranch("");
  });

  const stageFile = (path: string) => runAction(`stage-${path}`, () =>
    postJson("/api/git/stage", { path }));

  const stageAll = () => runAction("stage-all", async () => {
    await postJson("/api/git/stage", { all: true });
    setActionNotice("Staged all.");
  });

  const unstageFile = (path: string) => runAction(`unstage-${path}`, () =>
    postJson("/api/git/unstage", { path }));

  const discardFile = (path: string) => {
    if (!window.confirm(`Discard changes in ${path}?`)) return Promise.resolve();
    return runAction(`discard-${path}`, async () => {
      await postJson("/api/git/discard", { path });
      setActionNotice(`Discarded ${path}.`);
    });
  };

  const doCommit = () => runAction("commit", async () => {
    if (!commitMessage.trim()) return;
    await postJson("/api/git/commit", { message: commitMessage.trim() });
    setActionNotice("Committed.");
    setCommitMessage("");
    // Also refresh diff view
    setRefreshTick((v) => v + 1);
  });

  const saveRemote = () => runAction("remote", async () => {
    await postJson("/api/git/remote", { name: "origin", url: remoteUrl.trim() });
    setActionNotice("Origin updated.");
  });

  // Setup actions
  async function saveIdentity() {
    setIdentityError(null);
    try {
      await postJson("/api/git/identity", { name: identityName.trim(), email: identityEmail.trim(), scope: identityScope });
      setActionNotice("Saved git identity.");
      await loadIdentity();
    } catch (err) { setIdentityError((err as Error).message); }
  }

  async function saveCredentialHelper(useRecommended = false) {
    setIdentityError(null);
    try {
      await postJson("/api/git/credential-helper", { helper: useRecommended ? "" : credentialHelperInput.trim(), scope: identityScope });
      setActionNotice("Saved credential helper.");
      await loadIdentity();
    } catch (err) { setIdentityError((err as Error).message); }
  }

  async function saveGitHubToken() {
    setIdentityError(null);
    try {
      await postJson("/api/git/github-credential", { username: githubUsername.trim(), token: githubToken.trim() });
      setGithubToken("");
      setActionNotice("Stored GitHub credential.");
    } catch (err) { setIdentityError((err as Error).message); }
  }

  // -------------------------------------------------------------------------
  // Derived
  // -------------------------------------------------------------------------

  const hasChanges = !!repo && (repo.staged.length + repo.modified.length + repo.deleted.length + repo.untracked.length > 0);
  const pendingCount = repo ? repo.staged.length + repo.modified.length + repo.deleted.length + repo.untracked.length : 0;

  if (!open) return null;

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <aside
      className="relative min-w-[360px] max-w-[840px] shrink-0 border-l border-zinc-800 bg-zinc-950 flex flex-col"
      style={{ width: `${width}px` }}
    >
      {/* Resize handle */}
      <div
        onMouseDown={startResize}
        className={`absolute left-0 top-0 h-full w-1 -translate-x-1/2 cursor-ew-resize z-10 ${resizing ? "bg-zinc-600/80" : "hover:bg-zinc-700/60"}`}
        title="Drag to resize"
      />

      {/* Header */}
      <div className="h-10 px-3 border-b border-zinc-800/60 flex items-center gap-2 shrink-0">
        <h3 className="text-xs font-medium text-zinc-300">Review</h3>
        <div className="flex-1" />
        <button
          onClick={() => { setRefreshTick((v) => v + 1); void loadRepo(); }}
          className="text-zinc-600 hover:text-zinc-300 transition-colors p-1 rounded hover:bg-zinc-900"
          title="Refresh"
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
        {onClose && (
          <button
            onClick={onClose}
            className="text-zinc-600 hover:text-zinc-300 transition-colors p-1 rounded hover:bg-zinc-900"
            title="Close"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {/* Branch strip */}
      {projectPath && repo && repo.isRepo && (
        <div className="px-3 py-2 border-b border-zinc-800/60 flex items-center gap-2 flex-wrap shrink-0">
          {/* Branch selector */}
          <div className="relative">
            <button
              onClick={() => setShowBranchDropdown((v) => !v)}
              className="flex items-center gap-1.5 text-[11px] text-zinc-300 hover:text-zinc-100 bg-zinc-800/60 hover:bg-zinc-800 border border-zinc-700 rounded-md px-2 py-1 transition-colors"
            >
              <GitBranch className="h-3 w-3 text-zinc-500" />
              <span className="font-mono">{repo.branch ?? "unknown"}</span>
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${repo.clean ? "bg-bender-success" : "bg-bender-warning"}`} />
              <ChevronDown className="h-3 w-3 text-zinc-600" />
            </button>

            {showBranchDropdown && branches && (
              <div className="absolute top-full left-0 mt-1 bg-zinc-900 border border-zinc-700 rounded-lg shadow-lg z-20 min-w-[160px] max-h-52 overflow-y-auto py-1">
                {branches.all.map((b) => (
                  <button
                    key={b}
                    onClick={() => void checkoutBranch(b)}
                    disabled={b === repo.branch}
                    className={`w-full text-left px-3 py-1.5 text-[11px] font-mono transition-colors ${
                      b === repo.branch
                        ? "text-zinc-400 cursor-default"
                        : "text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100"
                    }`}
                  >
                    {b === repo.branch && "✓ "}{b}
                  </button>
                ))}
                {/* New branch input */}
                <div className="border-t border-zinc-800 mt-1 pt-1 px-2 pb-1.5 flex gap-1">
                  <input
                    value={newBranch}
                    onChange={(e) => setNewBranch(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") void createBranch(); }}
                    placeholder="new-branch"
                    className="flex-1 min-w-0 bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-[11px] text-zinc-300 font-mono focus:outline-none focus:border-zinc-500"
                  />
                  <button
                    onClick={() => void createBranch()}
                    disabled={!newBranch.trim() || actionLoading === "create-branch"}
                    className="px-2 py-1 text-[10px] rounded border border-zinc-700 text-zinc-300 hover:text-zinc-100 hover:border-zinc-500 disabled:opacity-40"
                  >
                    Create
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Ahead/behind */}
          {(repo.ahead > 0 || repo.behind > 0) && (
            <span className="text-[11px] text-zinc-600 tabular-nums">
              {repo.ahead > 0 && <span className="text-zinc-400">↑{repo.ahead}</span>}
              {repo.ahead > 0 && repo.behind > 0 && " "}
              {repo.behind > 0 && <span className="text-zinc-500">↓{repo.behind}</span>}
            </span>
          )}

          <div className="flex-1" />

          {/* Sync buttons */}
          <div className="flex items-center gap-1">
            {(["Fetch", "Pull", "Push"] as const).map((label) => {
              const key = label.toLowerCase();
              return (
                <button
                  key={key}
                  onClick={() => key === "fetch" ? void fetchRemote() : key === "pull" ? void pullRemote() : void pushRemote()}
                  disabled={actionLoading === key}
                  className="px-2 py-1 text-[10px] rounded border border-zinc-700/80 text-zinc-500 hover:text-zinc-200 hover:border-zinc-500 disabled:opacity-40 transition-colors"
                >
                  {actionLoading === key ? "…" : label}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Not-a-repo strip */}
      {projectPath && repo && !repo.isRepo && (
        <div className="px-3 py-2 border-b border-zinc-800/60 flex items-center gap-2 shrink-0">
          <span className="text-[11px] text-zinc-600">Not a git repository.</span>
          <button
            onClick={() => void initGit()}
            disabled={actionLoading === "init"}
            className="px-2 py-1 text-[10px] rounded border border-zinc-700 text-zinc-300 hover:border-zinc-500 disabled:opacity-40"
          >
            {actionLoading === "init" ? "…" : "Init Git"}
          </button>
        </div>
      )}

      {/* Tab strip */}
      <div className="px-3 border-b border-zinc-800/60 flex gap-0 shrink-0">
        {(["diff", "changes", "setup"] as GitTab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-3 py-2 text-[11px] capitalize border-b-2 transition-colors -mb-px ${
              tab === t
                ? "border-zinc-300 text-zinc-200"
                : "border-transparent text-zinc-600 hover:text-zinc-400"
            }`}
          >
            {t}
            {t === "changes" && pendingCount > 0 && (
              <span className="ml-1.5 text-[10px] bg-amber-500/20 text-amber-400 rounded-full px-1.5 tabular-nums">
                {pendingCount}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto">

        {/* ── Diff tab ─────────────────────────────────────────────── */}
        {tab === "diff" && (
          <div className="flex flex-col h-full">
            <div className="px-3 py-2 border-b border-zinc-800/40 flex items-center gap-1.5 flex-wrap shrink-0">
              <span className="text-[11px] text-zinc-600">Show</span>
              {[1, 2, 3, 5].map((n) => (
                <button
                  key={n}
                  onClick={() => setDiffCommits(n)}
                  className={`px-2 py-1 rounded text-[11px] border transition-colors ${
                    diffCommits === n
                      ? "bg-zinc-700 border-zinc-500 text-zinc-100"
                      : "bg-transparent border-zinc-700/80 text-zinc-500 hover:border-zinc-500 hover:text-zinc-300"
                  }`}
                >
                  {n} commit{n > 1 ? "s" : ""}
                </button>
              ))}
            </div>
            <div className="flex-1 overflow-y-auto p-3">
              {!projectPath && <p className="text-xs text-zinc-600">No project selected.</p>}
              {projectPath && diffLoading && (
                <LoadingDots size={18} label="Loading diff…" textClassName="text-xs text-zinc-500" />
              )}
              {projectPath && diffError && <p className="text-xs text-bender-danger/80">{diffError}</p>}
              {projectPath && !diffLoading && !diffError && !diffRaw && (
                <p className="text-xs text-zinc-600">No diff available.</p>
              )}
              {projectPath && !diffLoading && diffRaw && <GitDiffViewer raw={diffRaw} />}
            </div>
          </div>
        )}

        {/* ── Changes tab ──────────────────────────────────────────── */}
        {tab === "changes" && (
          <div className="p-3 space-y-4">
            {!projectPath && <p className="text-xs text-zinc-600">No project selected.</p>}
            {projectPath && repoLoading && (
              <LoadingDots size={18} label="Loading…" textClassName="text-xs text-zinc-500" />
            )}
            {projectPath && repoError && <p className="text-xs text-bender-danger/80">{repoError}</p>}

            {projectPath && repo?.isRepo && (
              <>
                {/* File lists */}
                <FileList title="Staged" tone="added" files={repo.staged} actionLabel="Unstage" onAction={(p) => void unstageFile(p)} />
                <FileList title="Modified" tone="modified" files={repo.modified} actionLabel="Stage" onAction={(p) => void stageFile(p)} secondaryActionLabel="Discard" onSecondaryAction={(p) => void discardFile(p)} />
                <FileList title="Deleted" tone="deleted" files={repo.deleted} actionLabel="Stage" onAction={(p) => void stageFile(p)} />
                <FileList title="Untracked" files={repo.untracked} actionLabel="Stage" onAction={(p) => void stageFile(p)} />

                {!hasChanges && !repoLoading && (
                  <p className="text-xs text-zinc-600">Working tree clean.</p>
                )}

                {/* Stage all + commit */}
                {hasChanges && (
                  <div className="pt-1 space-y-2 border-t border-zinc-800/60">
                    {repo.modified.length + repo.untracked.length + repo.deleted.length > 0 && (
                      <button
                        onClick={() => void stageAll()}
                        disabled={actionLoading === "stage-all"}
                        className="text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors disabled:opacity-40"
                      >
                        {actionLoading === "stage-all" ? "Staging…" : "Stage all"}
                      </button>
                    )}
                    <div className="flex gap-2">
                      <input
                        value={commitMessage}
                        onChange={(e) => setCommitMessage(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void doCommit(); }}
                        placeholder="feat: describe this change"
                        className="flex-1 min-w-0 bg-zinc-900 border border-zinc-700 rounded-md px-3 py-2 text-xs text-zinc-300 font-mono focus:outline-none focus:border-zinc-500 transition-colors"
                      />
                      <button
                        onClick={() => void doCommit()}
                        disabled={actionLoading === "commit" || !commitMessage.trim() || repo.staged.length === 0}
                        className="px-3 py-2 text-xs font-medium bg-zinc-100 text-zinc-900 rounded-md hover:bg-white disabled:opacity-40 transition-colors shrink-0"
                      >
                        {actionLoading === "commit" ? "…" : "Commit"}
                      </button>
                    </div>
                    {repo.staged.length === 0 && commitMessage.trim() && (
                      <p className="text-[11px] text-zinc-600">Stage files to commit.</p>
                    )}
                  </div>
                )}
              </>
            )}

            {actionError && <p className="text-xs text-bender-danger">{actionError}</p>}
            {actionNotice && <p className="text-xs text-bender-success">{actionNotice}</p>}
          </div>
        )}

        {/* ── Setup tab ────────────────────────────────────────────── */}
        {tab === "setup" && (
          <div className="p-3 space-y-5">

            {/* GitHub Connect */}
            <section className="space-y-3">
              <div className="flex items-center justify-between">
                <h4 className="text-xs font-medium text-zinc-300">GitHub</h4>
                <button onClick={() => void loadGitHubStatus()} className="text-[11px] text-zinc-600 hover:text-zinc-400 transition-colors">Refresh</button>
              </div>
              {githubLoading && <LoadingDots size={16} label="Checking…" textClassName="text-xs text-zinc-500" />}
              {githubError && <p className="text-xs text-bender-danger/80">{githubError}</p>}
              {deviceFlowNotice && <p className="text-xs text-bender-success">{deviceFlowNotice}</p>}
              {githubStatus && !githubStatus.configured && (
                <p className="text-xs text-amber-400">{githubStatus.message ?? "GitHub auth not configured."}</p>
              )}
              {githubStatus?.configured && githubStatus.connected && (
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <p className="text-xs text-zinc-300">Connected as <span className="text-zinc-100 font-mono">@{githubStatus.login}</span></p>
                  <button onClick={() => void disconnectGitHub()} className="px-2.5 py-1 text-xs rounded border border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:border-zinc-500 transition-colors">Disconnect</button>
                </div>
              )}
              {githubStatus?.configured && !githubStatus.connected && (
                <div className="space-y-2">
                  <p className="text-[11px] text-zinc-600">Connect via device login — no browser callback secrets required.</p>
                  <button onClick={() => void startDeviceLogin()} className="px-3 py-1.5 text-xs font-medium bg-zinc-100 text-zinc-900 rounded-md hover:bg-white transition-colors">
                    Start Device Login
                  </button>
                  {deviceFlow && (
                    <div className="rounded-md border border-zinc-800 bg-zinc-950/60 p-3 space-y-2">
                      <p className="text-[10px] text-zinc-500 uppercase tracking-wide">Verification Code</p>
                      <p className="text-base font-mono text-zinc-100">{deviceFlow.userCode}</p>
                      <div className="flex flex-wrap items-center gap-2">
                        <a href={deviceFlow.verificationUriComplete || deviceFlow.verificationUri} target="_blank" rel="noreferrer"
                          className="px-2.5 py-1 text-xs rounded border border-zinc-700 text-zinc-300 hover:text-zinc-100 hover:border-zinc-500">
                          Open GitHub Authorization
                        </a>
                        <span className="text-[11px] text-zinc-600">Expires {new Date(deviceFlow.expiresAt).toLocaleTimeString()}</span>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </section>

            {/* Identity */}
            <section className="space-y-3 border-t border-zinc-800/60 pt-4">
              <h4 className="text-xs font-medium text-zinc-300">Identity</h4>
              {identityLoading && <LoadingDots size={16} label="Loading…" textClassName="text-xs text-zinc-500" />}
              {identityError && <p className="text-xs text-bender-danger/80">{identityError}</p>}
              <div className="space-y-2">
                <div className="flex gap-2">
                  <input value={identityName} onChange={(e) => setIdentityName(e.target.value)} placeholder="Git author name"
                    className="flex-1 min-w-0 bg-zinc-900 border border-zinc-700 rounded-md px-3 py-2 text-xs text-zinc-300 focus:outline-none focus:border-zinc-500" />
                  <input value={identityEmail} onChange={(e) => setIdentityEmail(e.target.value)} placeholder="Email"
                    className="flex-1 min-w-0 bg-zinc-900 border border-zinc-700 rounded-md px-3 py-2 text-xs text-zinc-300 focus:outline-none focus:border-zinc-500" />
                </div>
                <div className="flex gap-2">
                  <select value={identityScope} onChange={(e) => setIdentityScope(e.target.value === "global" ? "global" : "local")}
                    className="select-flat flex-1 px-2 py-2 text-xs">
                    <option value="local">Local repo</option>
                    <option value="global">Global</option>
                  </select>
                  <button onClick={() => void saveIdentity()} className="px-3 py-2 text-xs rounded border border-zinc-700 text-zinc-300 hover:text-zinc-100 hover:border-zinc-500 transition-colors">
                    Save
                  </button>
                </div>
              </div>

              {/* Credential helper */}
              <div className="space-y-1.5">
                <p className="text-[11px] text-zinc-600">
                  Credential helper{identity?.credentialHelper ? ` (${identity.credentialHelperScope}): ${identity.credentialHelper}` : ": not set"}
                </p>
                <div className="flex gap-2">
                  <input value={credentialHelperInput} onChange={(e) => setCredentialHelperInput(e.target.value)}
                    placeholder={identity?.platform === "darwin" ? "osxkeychain" : "credential helper"}
                    className="flex-1 min-w-0 bg-zinc-900 border border-zinc-700 rounded-md px-3 py-2 text-xs text-zinc-300 font-mono focus:outline-none focus:border-zinc-500" />
                  <button onClick={() => void saveCredentialHelper(false)} className="px-2.5 py-2 text-xs rounded border border-zinc-700 text-zinc-300 hover:text-zinc-100 hover:border-zinc-500 transition-colors whitespace-nowrap">
                    Save
                  </button>
                  <button onClick={() => void saveCredentialHelper(true)} className="px-2.5 py-2 text-xs rounded border border-zinc-700 text-zinc-300 hover:text-zinc-100 hover:border-zinc-500 transition-colors whitespace-nowrap">
                    Use default
                  </button>
                </div>
              </div>

              {/* GitHub PAT */}
              <div className="space-y-1.5">
                <p className="text-[11px] text-zinc-600">Optional: store GitHub username + PAT for HTTPS remotes.</p>
                <div className="flex gap-2">
                  <input value={githubUsername} onChange={(e) => setGithubUsername(e.target.value)} placeholder="GitHub username"
                    className="flex-1 min-w-0 bg-zinc-900 border border-zinc-700 rounded-md px-3 py-2 text-xs text-zinc-300 focus:outline-none focus:border-zinc-500" />
                  <SecretInput value={githubToken} onChange={setGithubToken} placeholder="Personal access token"
                    inputClassName="bg-zinc-900 border border-zinc-700 rounded-md px-3 py-2 pr-9 text-xs text-zinc-300 w-full focus:outline-none focus:border-zinc-500" />
                  <button onClick={() => void saveGitHubToken()} disabled={!githubUsername.trim() || !githubToken.trim()}
                    className="px-2.5 py-2 text-xs rounded border border-zinc-700 text-zinc-300 hover:text-zinc-100 hover:border-zinc-500 disabled:opacity-40 transition-colors whitespace-nowrap">
                    Save
                  </button>
                </div>
              </div>
            </section>

            {/* Remote / Init */}
            <section className="space-y-3 border-t border-zinc-800/60 pt-4">
              <h4 className="text-xs font-medium text-zinc-300">Remote</h4>
              <div className="flex gap-2">
                <input value={remoteUrl} onChange={(e) => setRemoteUrl(e.target.value)} placeholder="git@github.com:owner/repo.git"
                  className="flex-1 min-w-0 bg-zinc-900 border border-zinc-700 rounded-md px-3 py-2 text-xs text-zinc-300 font-mono focus:outline-none focus:border-zinc-500" />
                <button onClick={() => void saveRemote()} disabled={actionLoading === "remote" || !remoteUrl.trim()}
                  className="px-2.5 py-2 text-xs rounded border border-zinc-700 text-zinc-300 hover:text-zinc-100 hover:border-zinc-500 disabled:opacity-40 transition-colors whitespace-nowrap">
                  {actionLoading === "remote" ? "…" : "Set Origin"}
                </button>
              </div>
              {repo && (
                <button onClick={() => void initGit()} disabled={actionLoading === "init"}
                  className="text-[11px] text-zinc-600 hover:text-zinc-400 transition-colors disabled:opacity-40">
                  {actionLoading === "init" ? "…" : repo.isRepo ? "Reinitialize git" : "Initialize git"}
                </button>
              )}
            </section>

            {actionError && <p className="text-xs text-bender-danger">{actionError}</p>}
            {actionNotice && <p className="text-xs text-bender-success">{actionNotice}</p>}
          </div>
        )}

      </div>
    </aside>
  );
}
