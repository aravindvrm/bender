import { useState, useEffect, useRef } from "react";
import { ChevronDown, ChevronRight, Folder, FolderOpen } from "lucide-react";
import { fetchProjects, selectProject, openProject, removeProject, type ProjectEntry } from "../hooks/useApi";
import { LoadingDots } from "./LoadingDots";
import { SecretInput } from "./SecretInput";

interface ProjectSelectorProps {
  currentPath: string | null;
  onProjectChange: () => void;
  compact?: boolean;
}

interface DirEntry {
  name: string;
  path: string;
  hasBender: boolean;
}

interface BrowseResult {
  path: string;
  parent: string | null;
  dirs: DirEntry[];
  hasBender: boolean;
}

interface GitHubAuthStatus {
  configured: boolean;
  connected: boolean;
  login?: string;
  message?: string;
  authMode?: string;
}

interface GitHubAuthConfig {
  clientId: string;
  clientSecretSet: boolean;
  redirectUri: string;
  usingEnvClientId: boolean;
  usingEnvClientSecret: boolean;
  storedClientId: string;
}

interface GitHubDeviceFlowStart {
  sessionId: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  intervalSec: number;
  expiresAt: number;
}

interface GitHubDeviceFlowPoll {
  status: "pending" | "connected" | "expired" | "denied";
  intervalSec?: number;
  login?: string;
}

interface GitHubInstallation {
  id: number;
  account: string;
  appSlug: string;
}

interface GitHubRepository {
  id: number;
  name: string;
  fullName: string;
  private: boolean;
  cloneUrl: string;
  htmlUrl: string;
  defaultBranch: string;
  owner: string;
  installationId: number;
}

async function browseDir(path?: string): Promise<BrowseResult> {
  const query = path && path.trim().length > 0 ? `?path=${encodeURIComponent(path)}` : "";
  const res = await fetch(`/api/fs/browse${query}`);
  if (!res.ok) throw new Error((await res.json()).error);
  return res.json();
}

async function fetchGitHubStatus(): Promise<GitHubAuthStatus> {
  const res = await fetch("/api/github/auth/status");
  if (!res.ok) throw new Error((await res.json()).error ?? "Failed to read GitHub auth status");
  return res.json();
}

async function fetchGitHubAuthConfig(): Promise<GitHubAuthConfig> {
  const res = await fetch("/api/github/auth/config");
  if (!res.ok) throw new Error((await res.json()).error ?? "Failed to read GitHub auth config");
  return res.json();
}

async function saveGitHubAuthConfig(config: { clientId?: string; clientSecret?: string; redirectUri?: string }): Promise<void> {
  const res = await fetch("/api/github/auth/config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(config),
  });
  if (!res.ok) throw new Error((await res.json()).error ?? "Failed to save GitHub auth config");
}

async function startGitHubDeviceFlow(): Promise<GitHubDeviceFlowStart> {
  const res = await fetch("/api/github/device/start", { method: "POST" });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? "Failed to start GitHub device flow");
  return body as GitHubDeviceFlowStart;
}

async function pollGitHubDeviceFlow(sessionId: string): Promise<GitHubDeviceFlowPoll> {
  const res = await fetch("/api/github/device/poll", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? "Failed to poll GitHub device flow");
  return body as GitHubDeviceFlowPoll;
}

async function disconnectGitHub(): Promise<void> {
  const res = await fetch("/api/github/auth/disconnect", { method: "POST" });
  if (!res.ok) throw new Error((await res.json()).error ?? "Failed to disconnect GitHub");
}

async function fetchGitHubInstallations(): Promise<GitHubInstallation[]> {
  const res = await fetch("/api/github/installations");
  if (!res.ok) throw new Error((await res.json()).error ?? "Failed to fetch installations");
  const body = await res.json();
  return body.installations ?? [];
}

async function fetchGitHubRepos(installationId?: number): Promise<GitHubRepository[]> {
  const query = installationId ? `?installationId=${installationId}` : "";
  const res = await fetch(`/api/github/repos${query}`);
  if (!res.ok) throw new Error((await res.json()).error ?? "Failed to fetch repositories");
  const body = await res.json();
  return body.repositories ?? [];
}

async function cloneGitHubRepo(cloneUrl: string, targetPath: string): Promise<void> {
  const res = await fetch("/api/github/clone", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cloneUrl, targetPath }),
  });
  if (!res.ok) throw new Error((await res.json()).error ?? "Failed to clone repository");
}

function joinPath(base: string, segment: string): string {
  const trimmed = base.trim();
  if (!trimmed) return segment;
  if (trimmed.endsWith("/") || trimmed.endsWith("\\")) return `${trimmed}${segment}`;
  return `${trimmed}/${segment}`;
}

function parentPath(path: string | null): string {
  if (!path) return "~";
  const cleaned = path.replace(/[\\/]+$/, "");
  const idx = Math.max(cleaned.lastIndexOf("/"), cleaned.lastIndexOf("\\"));
  if (idx <= 0) return cleaned;
  return cleaned.slice(0, idx);
}

export function ProjectSelector({ currentPath, onProjectChange, compact }: ProjectSelectorProps) {
  const [open, setOpen] = useState(false);
  const [sourceTab, setSourceTab] = useState<"local" | "github">("local");

  const [projects, setProjects] = useState<ProjectEntry[]>([]);
  const [inputPath, setInputPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showBrowser, setShowBrowser] = useState(false);
  const [browserRoot, setBrowserRoot] = useState<BrowseResult | null>(null);
  const [browserLoading, setBrowserLoading] = useState(false);
  const [browserError, setBrowserError] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  const [githubStatus, setGithubStatus] = useState<GitHubAuthStatus | null>(null);
  const [githubConfig, setGithubConfig] = useState<GitHubAuthConfig | null>(null);
  const [githubDeviceFlow, setGithubDeviceFlow] = useState<GitHubDeviceFlowStart | null>(null);
  const [githubClientIdInput, setGithubClientIdInput] = useState("");
  const [githubClientSecretInput, setGithubClientSecretInput] = useState("");
  const [githubRedirectUriInput, setGithubRedirectUriInput] = useState("http://localhost:3142/api/github/auth/callback");
  const [githubInstallations, setGithubInstallations] = useState<GitHubInstallation[]>([]);
  const [githubRepos, setGithubRepos] = useState<GitHubRepository[]>([]);
  const [githubInstallationId, setGithubInstallationId] = useState<number | null>(null);
  const [githubLoading, setGithubLoading] = useState(false);
  const [githubError, setGithubError] = useState<string | null>(null);
  const [githubNotice, setGithubNotice] = useState<string | null>(null);
  const [cloningRepoId, setCloningRepoId] = useState<number | null>(null);
  const [clonePickerRepo, setClonePickerRepo] = useState<GitHubRepository | null>(null);
  const [cloneBrowserRoot, setCloneBrowserRoot] = useState<BrowseResult | null>(null);
  const [cloneBrowserLoading, setCloneBrowserLoading] = useState(false);
  const [cloneBrowserError, setCloneBrowserError] = useState<string | null>(null);
  const [cloneDestinationPath, setCloneDestinationPath] = useState<string | null>(null);

  const dropdownRef = useRef<HTMLDivElement>(null);
  const githubPollTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (open) {
      fetchProjects().then(setProjects).catch(() => {});
      setInputPath("");
      setError(null);
      setShowBrowser(false);
      setGithubError(null);
      setGithubNotice(null);
      setGithubDeviceFlow(null);
      setClonePickerRepo(null);
      setCloneBrowserRoot(null);
      setCloneDestinationPath(null);
      void refreshGitHub();
    }
  }, [open, currentPath]);

  useEffect(() => {
    if (!open) return;
    function handler(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false);
        setShowBrowser(false);
      }
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  useEffect(() => {
    return () => {
      if (githubPollTimerRef.current !== null) {
        window.clearTimeout(githubPollTimerRef.current);
        githubPollTimerRef.current = null;
      }
    };
  }, []);

  async function loadBrowserRoot(path?: string) {
    setBrowserLoading(true);
    setBrowserError(null);
    try {
      const data = await browseDir(path);
      setBrowserRoot(data);
      setSelectedPath((prev) => prev ?? data.path);
      return data;
    } catch (err) {
      setBrowserError((err as Error).message);
      return null;
    } finally {
      setBrowserLoading(false);
    }
  }

  async function openBrowser() {
    setShowBrowser(true);
    if (browserRoot) return;
    const preferredPath = currentPath ?? (inputPath.trim() || undefined);
    await loadBrowserRoot(preferredPath);
  }

  async function goToParent() {
    if (!browserRoot?.parent) return;
    await loadBrowserRoot(browserRoot.parent);
  }

  async function handleSelect(path: string) {
    setLoading(true);
    setError(null);
    try {
      await selectProject(path);
      onProjectChange();
      setOpen(false);
      setShowBrowser(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function handleOpen() {
    const path = inputPath.trim();
    if (!path) return;
    setLoading(true);
    setError(null);
    try {
      await openProject(path);
      onProjectChange();
      setOpen(false);
      setShowBrowser(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function handleRemove(path: string) {
    await removeProject(path);
    setProjects((prev) => prev.filter((p) => p.path !== path));
  }

  async function refreshGitHub() {
    setGithubLoading(true);
    setGithubError(null);
    try {
      const cfg = await fetchGitHubAuthConfig();
      setGithubConfig(cfg);
      setGithubClientIdInput(cfg.clientId ?? "");
      setGithubRedirectUriInput(cfg.redirectUri ?? "http://localhost:3142/api/github/auth/callback");

      const status = await fetchGitHubStatus();
      setGithubStatus(status);
      if (!status.connected) {
        setGithubInstallations([]);
        setGithubRepos([]);
        setGithubInstallationId(null);
        return;
      }

      const installs = await fetchGitHubInstallations();
      setGithubInstallations(installs);
      const selected = githubInstallationId ?? installs[0]?.id ?? null;
      setGithubInstallationId(selected);
      const repos = await fetchGitHubRepos(selected ?? undefined);
      setGithubRepos(repos);
    } catch (err) {
      setGithubError((err as Error).message);
    } finally {
      setGithubLoading(false);
    }
  }

  function clearGitHubAuthPolling() {
    if (githubPollTimerRef.current !== null) {
      window.clearTimeout(githubPollTimerRef.current);
      githubPollTimerRef.current = null;
    }
  }

  function startGitHubDevicePolling(sessionId: string, intervalSec: number) {
    clearGitHubAuthPolling();

    const tick = async () => {
      try {
        const poll = await pollGitHubDeviceFlow(sessionId);
        if (poll.status === "connected") {
          setGithubNotice(`Connected as @${poll.login ?? "user"}`);
          setGithubDeviceFlow(null);
          clearGitHubAuthPolling();
          await refreshGitHub();
          return;
        }
        if (poll.status === "pending") {
          githubPollTimerRef.current = window.setTimeout(() => {
            void tick();
          }, Math.max(2, poll.intervalSec ?? intervalSec) * 1000);
          return;
        }
        if (poll.status === "denied") {
          setGithubNotice("Authorization denied.");
          setGithubDeviceFlow(null);
          clearGitHubAuthPolling();
          return;
        }
        setGithubNotice("Device code expired. Start connection again.");
        setGithubDeviceFlow(null);
        clearGitHubAuthPolling();
      } catch {
        githubPollTimerRef.current = window.setTimeout(() => {
          void tick();
        }, 2000);
      }
    };

    void tick();
  }

  async function handleSaveGitHubConfig() {
    setGithubError(null);
    setGithubNotice(null);
    setGithubLoading(true);
    try {
      await saveGitHubAuthConfig({
        clientId: githubClientIdInput.trim(),
        clientSecret: githubClientSecretInput.trim() || undefined,
        redirectUri: githubRedirectUriInput.trim() || undefined,
      });
      setGithubClientSecretInput("");
      await refreshGitHub();
    } catch (err) {
      setGithubError((err as Error).message);
      setGithubLoading(false);
    }
  }

  async function refreshGitHubRepos(installationId: number | null) {
    setGithubLoading(true);
    setGithubError(null);
    setGithubNotice(null);
    try {
      const repos = await fetchGitHubRepos(installationId ?? undefined);
      setGithubRepos(repos);
    } catch (err) {
      setGithubError((err as Error).message);
    } finally {
      setGithubLoading(false);
    }
  }

  async function handleConnectGitHub() {
    setGithubError(null);
    setGithubNotice("Waiting for GitHub authorization...");
    try {
      const flow = await startGitHubDeviceFlow();
      setGithubDeviceFlow(flow);
      const url = flow.verificationUriComplete || flow.verificationUri;
      window.open(url, "_blank", "noopener,noreferrer");
      startGitHubDevicePolling(flow.sessionId, flow.intervalSec);
    } catch (err) {
      setGithubError((err as Error).message);
      setGithubNotice(null);
    }
  }

  async function handleDisconnectGitHub() {
    setGithubNotice(null);
    try {
      await disconnectGitHub();
      clearGitHubAuthPolling();
      setGithubDeviceFlow(null);
      await refreshGitHub();
      setGithubNotice("Disconnected GitHub.");
    } catch (err) {
      setGithubError((err as Error).message);
    }
  }

  async function loadCloneBrowser(path?: string) {
    setCloneBrowserLoading(true);
    setCloneBrowserError(null);
    try {
      const preferred = path?.trim() || parentPath(currentPath);
      const data = await browseDir(preferred);
      setCloneBrowserRoot(data);
      setCloneDestinationPath((prev) => prev ?? data.path);
    } catch (err) {
      setCloneBrowserError((err as Error).message);
    } finally {
      setCloneBrowserLoading(false);
    }
  }

  async function handlePrepareCloneRepo(repo: GitHubRepository) {
    setClonePickerRepo(repo);
    setCloneBrowserRoot(null);
    setCloneDestinationPath(null);
    await loadCloneBrowser();
  }

  async function goCloneParent() {
    if (!cloneBrowserRoot?.parent) return;
    await loadCloneBrowser(cloneBrowserRoot.parent);
  }

  async function handleConfirmCloneRepo() {
    if (!clonePickerRepo || !cloneDestinationPath) return;
    const targetPath = joinPath(cloneDestinationPath, clonePickerRepo.name);
    setCloningRepoId(clonePickerRepo.id);
    setGithubError(null);
    try {
      await cloneGitHubRepo(clonePickerRepo.cloneUrl, targetPath);
      onProjectChange();
      setOpen(false);
      setGithubNotice(`Cloned ${clonePickerRepo.fullName}`);
    } catch (err) {
      setGithubError((err as Error).message);
    } finally {
      setCloningRepoId(null);
      setClonePickerRepo(null);
    }
  }

  const displayName = currentPath
    ? currentPath.split("/").filter(Boolean).pop() ?? currentPath
    : "No project";

  return (
    <div className="relative" ref={dropdownRef}>
      {compact ? (
        <button
          onClick={() => setOpen((v) => !v)}
          title={`Project: ${displayName}`}
          className={`w-9 h-9 rounded-lg flex items-center justify-center transition-colors ${
            open
              ? "bg-zinc-800 text-zinc-100"
              : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/60"
          }`}
        >
          <Folder className="h-4 w-4" />
        </button>
      ) : (
        <button
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 transition-colors text-sm text-zinc-200 max-w-64"
        >
          <span className="text-zinc-500 text-xs">◈</span>
          <span className="truncate">{displayName}</span>
          <span className="text-zinc-600 text-xs ml-1 shrink-0">▾</span>
        </button>
      )}

      {open && (
        <div className={`absolute w-96 bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl z-50 overflow-hidden ${compact ? "top-0 left-full ml-2" : "top-full mt-1 left-0"}`}>
          <div className="p-2 border-b border-zinc-800 flex gap-1">
            {(["local", "github"] as const).map((tab) => (
              <button
                key={tab}
                onClick={() => setSourceTab(tab)}
                className={`px-2.5 py-1 text-xs rounded-md transition-colors ${
                  sourceTab === tab
                    ? "bg-zinc-700 text-zinc-100"
                    : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/70"
                }`}
              >
                {tab === "local" ? "Local" : "GitHub"}
              </button>
            ))}
          </div>

          {sourceTab === "local" && (
            <>
              <div className="p-3 border-b border-zinc-800 space-y-2">
                <div className="flex gap-2">
                  <input
                    autoFocus
                    type="text"
                    value={inputPath}
                    onChange={(e) => setInputPath(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void handleOpen();
                      if (e.key === "Escape") setOpen(false);
                    }}
                    placeholder="/path/to/project"
                    className="flex-1 bg-zinc-800 border border-zinc-700 rounded-md px-3 py-1.5 text-sm text-zinc-200 font-mono placeholder:text-zinc-600 focus:outline-none focus:border-zinc-500"
                  />
                  <button
                    onClick={() => void handleOpen()}
                    disabled={!inputPath.trim() || loading}
                    className="px-3 py-1.5 text-xs font-medium bg-zinc-700 text-zinc-200 rounded-md hover:bg-zinc-600 disabled:opacity-40 transition-colors"
                  >
                    Open
                  </button>
                </div>
                <button
                  onClick={() => void openBrowser()}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 rounded-md transition-colors"
                >
                  <span>{showBrowser ? "▾" : "▸"}</span>
                  <span>Explorer</span>
                </button>
                {error && <p className="text-xs text-red-400">{error}</p>}
              </div>

              {showBrowser && (
                <div className="border-b border-zinc-800">
                  <div className="px-3 py-2 border-b border-zinc-800 flex items-center gap-2">
                    <button
                      onClick={() => void goToParent()}
                      disabled={!browserRoot?.parent || browserLoading}
                      className="px-2 py-1 text-xs rounded bg-zinc-800 text-zinc-300 hover:bg-zinc-700 disabled:opacity-40"
                    >
                      Up
                    </button>
                    <button
                      onClick={() => void loadBrowserRoot(browserRoot?.path)}
                      disabled={!browserRoot || browserLoading}
                      className="px-2 py-1 text-xs rounded bg-zinc-800 text-zinc-300 hover:bg-zinc-700 disabled:opacity-40"
                    >
                      Refresh
                    </button>
                    <span className="text-[11px] text-zinc-500 font-mono truncate">{browserRoot?.path ?? "Loading…"}</span>
                  </div>

                  <div className="max-h-72 overflow-y-auto px-2 py-2">
                    {browserLoading && (
                      <div className="flex items-center gap-2 text-xs text-zinc-500 px-2 py-2">
                        <LoadingDots size={18} label="Loading directories…" />
                      </div>
                    )}
                    {browserError && (
                      <p className="text-xs text-red-400 px-2 py-2">{browserError}</p>
                    )}
                    {!browserLoading && browserRoot && (
                      <>
                        <button
                          onClick={() => setSelectedPath(browserRoot.path)}
                          className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-left text-xs transition-colors ${
                            selectedPath === browserRoot.path
                              ? "bg-zinc-700/70 text-zinc-100"
                              : "text-zinc-300 hover:bg-zinc-800/70"
                          }`}
                        >
                          <FolderOpen className="h-3.5 w-3.5 text-zinc-400 shrink-0" />
                          <span className="truncate">. (this directory)</span>
                          {browserRoot.hasBender && <span className="ml-auto text-[10px] text-emerald-500">bender</span>}
                        </button>

                        {browserRoot.dirs.length === 0 ? (
                          <p className="text-xs text-zinc-600 px-2 py-2 italic">No subdirectories</p>
                        ) : (
                          browserRoot.dirs.map((entry) => (
                            <DirectoryTreeNode
                              key={entry.path}
                              entry={entry}
                              depth={0}
                              selectedPath={selectedPath}
                              onSelect={setSelectedPath}
                            />
                          ))
                        )}
                      </>
                    )}
                  </div>

                  <div className="px-3 py-2 border-t border-zinc-800 flex items-center gap-2">
                    <span className="text-[11px] text-zinc-500 font-mono truncate flex-1">
                      {selectedPath ?? "No directory selected"}
                    </span>
                    <button
                      onClick={() => selectedPath && void handleSelect(selectedPath)}
                      disabled={!selectedPath || loading}
                      className="px-3 py-1.5 text-xs font-medium bg-zinc-100 text-zinc-900 rounded-md hover:bg-white disabled:opacity-40 transition-colors"
                    >
                      Select
                    </button>
                  </div>
                </div>
              )}
            </>
          )}

          {sourceTab === "github" && (
            <div className="p-3 space-y-3 border-b border-zinc-800">
              <div className="flex items-center gap-2">
                <button
                  onClick={() => void refreshGitHub()}
                  className="px-2 py-1 text-xs rounded border border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:border-zinc-600 transition-colors"
                >
                  Refresh
                </button>
                {githubLoading && <LoadingDots size={18} label="Loading…" />}
              </div>

              {githubConfig && (
                <p className="text-[11px] text-zinc-600">
                  Config source: {githubConfig.usingEnvClientId ? "env var" : "local file"} • redirect: {githubConfig.redirectUri}
                </p>
              )}

              {githubNotice && (
                <p className="text-xs text-emerald-400">{githubNotice}</p>
              )}

              {githubStatus && !githubStatus.configured && (
                <div className="space-y-2">
                  <p className="text-xs text-amber-400">
                    {githubStatus.message ?? "GitHub auth is not configured on this machine."}
                  </p>
                  <div className="space-y-2">
                    <input
                      type="text"
                      value={githubClientIdInput}
                      onChange={(e) => setGithubClientIdInput(e.target.value)}
                      placeholder="GitHub App Client ID"
                      className="w-full bg-zinc-800 border border-zinc-700 rounded-md px-3 py-1.5 text-xs text-zinc-200 font-mono placeholder:text-zinc-600 focus:outline-none focus:border-zinc-500"
                    />
                    <SecretInput
                      value={githubClientSecretInput}
                      onChange={setGithubClientSecretInput}
                      placeholder="Client Secret (optional for device flow)"
                      inputClassName="w-full bg-zinc-800 border border-zinc-700 rounded-md px-3 py-1.5 pr-9 text-xs text-zinc-200 font-mono placeholder:text-zinc-600 focus:outline-none focus:border-zinc-500"
                    />
                    <input
                      type="text"
                      value={githubRedirectUriInput}
                      onChange={(e) => setGithubRedirectUriInput(e.target.value)}
                      placeholder="Callback URL"
                      className="w-full bg-zinc-800 border border-zinc-700 rounded-md px-3 py-1.5 text-xs text-zinc-200 font-mono placeholder:text-zinc-600 focus:outline-none focus:border-zinc-500"
                    />
                    <button
                      onClick={() => void handleSaveGitHubConfig()}
                      disabled={!githubClientIdInput.trim() || githubLoading}
                      className="px-3 py-1.5 text-xs font-medium bg-zinc-100 text-zinc-900 rounded-md hover:bg-white disabled:opacity-40 transition-colors"
                    >
                      Save GitHub Auth Config
                    </button>
                    <p className="text-[11px] text-zinc-600">
                      Saved locally to `~/.bender/github-auth.json` for this machine.
                    </p>
                  </div>
                </div>
              )}

              {githubStatus?.configured && !githubStatus.connected && (
                <div className="space-y-2">
                  <p className="text-xs text-zinc-500">Connect GitHub to browse and clone repositories.</p>
                  <button
                    onClick={() => void handleConnectGitHub()}
                    className="px-3 py-1.5 text-xs font-medium bg-zinc-100 text-zinc-900 rounded-md hover:bg-white transition-colors"
                  >
                    Connect GitHub
                  </button>
                  {githubDeviceFlow && (
                    <div className="rounded-md border border-zinc-800 bg-zinc-950/60 p-2.5 space-y-1.5">
                      <p className="text-[11px] text-zinc-500 uppercase tracking-wide">Device Code</p>
                      <p className="text-sm font-mono text-zinc-100">{githubDeviceFlow.userCode}</p>
                      <p className="text-[11px] text-zinc-600">
                        Expires at {new Date(githubDeviceFlow.expiresAt).toLocaleTimeString()}
                      </p>
                    </div>
                  )}
                </div>
              )}

              {githubStatus?.connected && (
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <p className="text-xs text-zinc-400 flex items-center gap-1.5">
                      <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400" />
                      Connected as <span className="text-zinc-200">@{githubStatus.login}</span>
                    </p>
                    <button
                      onClick={() => void handleDisconnectGitHub()}
                      className="text-xs text-zinc-500 hover:text-red-300 transition-colors"
                    >
                      Disconnect
                    </button>
                  </div>

                  <div className="space-y-1">
                    <label className="text-[11px] text-zinc-500">Installation (account/org)</label>
                    <div className="relative">
                      <select
                        value={githubInstallationId ?? ""}
                        onChange={(e) => {
                          const next = e.target.value ? Number(e.target.value) : null;
                          setGithubInstallationId(next);
                          void refreshGitHubRepos(next);
                        }}
                        className="select-flat w-full pl-2 pr-7 py-1.5 text-xs"
                      >
                        {githubInstallations.length === 0 && <option value="">No installations</option>}
                        {githubInstallations.map((inst) => (
                          <option key={inst.id} value={inst.id}>{inst.account} ({inst.appSlug || "app"})</option>
                        ))}
                      </select>
                      <ChevronDown className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 h-3 w-3 text-zinc-500" />
                    </div>
                  </div>

                  <div className="max-h-64 overflow-y-auto space-y-1">
                    {githubRepos.map((repo) => (
                      <div key={repo.id} className="flex items-center gap-2 px-2 py-2 rounded-md hover:bg-zinc-800/70">
                        <div className="flex-1 min-w-0">
                          <p className="text-xs text-zinc-200 truncate">{repo.fullName}</p>
                          <p className="text-[11px] text-zinc-500 truncate">{repo.private ? "private" : "public"} • {repo.defaultBranch}</p>
                        </div>
                        <button
                          onClick={() => void handlePrepareCloneRepo(repo)}
                          disabled={cloningRepoId === repo.id}
                          className="px-2.5 py-1 text-[11px] rounded border border-zinc-700 text-zinc-300 hover:text-zinc-100 hover:border-zinc-500 disabled:opacity-40"
                        >
                          {cloningRepoId === repo.id ? "Cloning..." : "Clone + Load"}
                        </button>
                      </div>
                    ))}
                    {githubRepos.length === 0 && !githubLoading && (
                      <p className="text-xs text-zinc-600 italic px-1">No repositories found</p>
                    )}
                  </div>

                  {clonePickerRepo && (
                    <div className="space-y-2 rounded-md border border-zinc-800 bg-zinc-950/50 p-2.5">
                      <p className="text-xs text-zinc-300">
                        Choose clone destination for <span className="font-mono">{clonePickerRepo.fullName}</span>
                      </p>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => void goCloneParent()}
                          disabled={!cloneBrowserRoot?.parent || cloneBrowserLoading}
                          className="px-2 py-1 text-xs rounded bg-zinc-800 text-zinc-300 hover:bg-zinc-700 disabled:opacity-40"
                        >
                          Up
                        </button>
                        <button
                          onClick={() => void loadCloneBrowser(cloneBrowserRoot?.path)}
                          disabled={cloneBrowserLoading}
                          className="px-2 py-1 text-xs rounded bg-zinc-800 text-zinc-300 hover:bg-zinc-700 disabled:opacity-40"
                        >
                          Refresh
                        </button>
                        <span className="text-[11px] text-zinc-500 font-mono truncate">
                          {cloneBrowserRoot?.path ?? "Loading…"}
                        </span>
                      </div>

                      <div className="max-h-40 overflow-y-auto px-1 py-1 space-y-0.5 border border-zinc-800 rounded-md">
                        {cloneBrowserLoading && (
                          <div className="px-2 py-2">
                            <LoadingDots size={18} label="Loading directories…" />
                          </div>
                        )}
                        {cloneBrowserError && (
                          <p className="text-xs text-red-400 px-2 py-2">{cloneBrowserError}</p>
                        )}
                        {!cloneBrowserLoading && cloneBrowserRoot && (
                          <>
                            <button
                              onClick={() => setCloneDestinationPath(cloneBrowserRoot.path)}
                              className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-left text-xs ${
                                cloneDestinationPath === cloneBrowserRoot.path
                                  ? "bg-zinc-700/70 text-zinc-100"
                                  : "text-zinc-300 hover:bg-zinc-800/70"
                              }`}
                            >
                              <FolderOpen className="h-3.5 w-3.5 text-zinc-400 shrink-0" />
                              <span className="truncate">. (this directory)</span>
                            </button>
                            {cloneBrowserRoot.dirs.map((entry) => (
                              <DirectoryTreeNode
                                key={`clone-${entry.path}`}
                                entry={entry}
                                depth={0}
                                selectedPath={cloneDestinationPath}
                                onSelect={setCloneDestinationPath}
                              />
                            ))}
                          </>
                        )}
                      </div>

                      <div className="flex items-center gap-2">
                        <span className="text-[11px] text-zinc-500 font-mono truncate flex-1">
                          {(cloneDestinationPath ?? "~")}/{clonePickerRepo.name}
                        </span>
                        <button
                          onClick={() => setClonePickerRepo(null)}
                          className="px-2.5 py-1 text-[11px] rounded border border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:border-zinc-600"
                        >
                          Cancel
                        </button>
                        <button
                          onClick={() => void handleConfirmCloneRepo()}
                          disabled={!cloneDestinationPath || cloningRepoId === clonePickerRepo.id}
                          className="px-2.5 py-1 text-[11px] rounded border border-zinc-700 text-zinc-300 hover:text-zinc-100 hover:border-zinc-500 disabled:opacity-40"
                        >
                          {cloningRepoId === clonePickerRepo.id ? "Cloning..." : "Clone + Load"}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {githubError && <p className="text-xs text-red-400">{githubError}</p>}
            </div>
          )}

          {projects.length > 0 && (
            <div className="max-h-52 overflow-y-auto">
              <p className="px-3 pt-2 pb-1 text-xs text-zinc-600 font-medium uppercase tracking-wide">Recent</p>
              {projects.map((p) => (
                <div key={p.path} className={`flex items-center gap-2 px-3 py-2 hover:bg-zinc-800 transition-colors ${p.path === currentPath ? "bg-zinc-800/60" : ""}`}>
                  <button
                    onClick={() => void handleSelect(p.path)}
                    className="flex-1 min-w-0 text-left"
                  >
                    <p className="text-sm text-zinc-200 truncate">{p.name}</p>
                    <p className="text-xs text-zinc-500 font-mono truncate">{p.path}</p>
                  </button>
                  {p.path === currentPath && <span className="text-xs text-emerald-500 shrink-0">active</span>}
                  <button
                    onClick={() => void handleRemove(p.path)}
                    className="text-zinc-600 hover:text-zinc-300 text-xs shrink-0 px-1"
                    title="Remove from recents"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
          {projects.length === 0 && (
            <p className="px-3 py-4 text-sm text-zinc-600 text-center">No recent projects</p>
          )}
        </div>
      )}
    </div>
  );
}

interface DirectoryTreeNodeProps {
  entry: DirEntry;
  depth: number;
  selectedPath: string | null;
  onSelect: (path: string) => void;
}

function DirectoryTreeNode({ entry, depth, selectedPath, onSelect }: DirectoryTreeNodeProps) {
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [children, setChildren] = useState<DirEntry[] | null>(null);

  async function toggleExpand(e: React.MouseEvent) {
    e.stopPropagation();
    if (expanded) {
      setExpanded(false);
      return;
    }

    setExpanded(true);
    if (children !== null) return;

    setLoading(true);
    setError(null);
    try {
      const data = await browseDir(entry.path);
      setChildren(data.dirs);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  const rowSelected = selectedPath === entry.path;

  return (
    <div>
      <button
        onClick={() => onSelect(entry.path)}
        onDoubleClick={(e) => void toggleExpand(e)}
        className={`w-full flex items-center gap-1.5 py-1.5 rounded text-left text-xs transition-colors ${
          rowSelected
            ? "bg-zinc-700/70 text-zinc-100"
            : "text-zinc-300 hover:bg-zinc-800/70"
        }`}
        style={{ paddingLeft: `${8 + depth * 14}px`, paddingRight: "8px" }}
      >
        <span
          onClick={(e) => void toggleExpand(e)}
          className="h-4 w-4 flex items-center justify-center text-zinc-500 hover:text-zinc-300 shrink-0"
        >
          {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        </span>
        {expanded ? (
          <FolderOpen className="h-3.5 w-3.5 text-zinc-400 shrink-0" />
        ) : (
          <Folder className="h-3.5 w-3.5 text-zinc-500 shrink-0" />
        )}
        <span className="truncate">{entry.name}</span>
        {entry.hasBender && <span className="ml-auto text-[10px] text-emerald-500">bender</span>}
      </button>

      {expanded && (
        <div>
          {loading && (
            <div
              className="flex items-center gap-1.5 text-[11px] text-zinc-500 py-1"
              style={{ paddingLeft: `${8 + (depth + 1) * 14}px` }}
            >
              <LoadingDots size={16} label="Loading…" />
            </div>
          )}

          {error && (
            <p
              className="text-[11px] text-red-400 py-1"
              style={{ paddingLeft: `${8 + (depth + 1) * 14}px` }}
            >
              {error}
            </p>
          )}

          {children && children.length > 0 && children.map((child) => (
            <DirectoryTreeNode
              key={child.path}
              entry={child}
              depth={depth + 1}
              selectedPath={selectedPath}
              onSelect={onSelect}
            />
          ))}

          {children && children.length === 0 && !loading && !error && (
            <p
              className="text-[11px] text-zinc-600 py-1 italic"
              style={{ paddingLeft: `${8 + (depth + 1) * 14}px` }}
            >
              Empty
            </p>
          )}
        </div>
      )}
    </div>
  );
}
