import { useState, useEffect, useRef } from "react";
import { fetchProjects, selectProject, openProject, removeProject, type ProjectEntry } from "../hooks/useApi";

interface ProjectSelectorProps {
  currentPath: string | null;
  onProjectChange: () => void;
  /** Render as a compact icon-only trigger (for sidebar icon rail) */
  compact?: boolean;
}

interface BrowseResult {
  path: string;
  parent: string | null;
  dirs: { name: string; path: string; hasBender: boolean }[];
  hasBender: boolean;
}

async function browseDir(path: string): Promise<BrowseResult> {
  const res = await fetch(`/api/fs/browse?path=${encodeURIComponent(path)}`);
  if (!res.ok) throw new Error((await res.json()).error);
  return res.json();
}

export function ProjectSelector({ currentPath, onProjectChange, compact }: ProjectSelectorProps) {
  const [open, setOpen] = useState(false);
  const [projects, setProjects] = useState<ProjectEntry[]>([]);
  const [inputPath, setInputPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showBrowser, setShowBrowser] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      fetchProjects().then(setProjects).catch(() => {});
      setInputPath("");
      setError(null);
    }
  }, [open]);

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
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function handleRemove(e: React.MouseEvent, path: string) {
    e.stopPropagation();
    await removeProject(path);
    setProjects((prev) => prev.filter((p) => p.path !== path));
  }

  const displayName = currentPath
    ? currentPath.split("/").filter(Boolean).pop() ?? currentPath
    : "No project";

  return (
    <>
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
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
            </svg>
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

        {open && !showBrowser && (
          <div className={`absolute top-0 w-80 bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl z-50 overflow-hidden ${compact ? "left-full ml-2" : "top-full mt-1 left-0"}`}>
            {/* Path input row */}
            <div className="p-3 border-b border-zinc-800 space-y-2">
              <div className="flex gap-2">
                <input
                  autoFocus
                  type="text"
                  value={inputPath}
                  onChange={(e) => setInputPath(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleOpen();
                    if (e.key === "Escape") setOpen(false);
                  }}
                  placeholder="/path/to/project"
                  className="flex-1 bg-zinc-800 border border-zinc-700 rounded-md px-3 py-1.5 text-sm text-zinc-200 font-mono placeholder:text-zinc-600 focus:outline-none focus:border-zinc-500"
                />
                <button
                  onClick={handleOpen}
                  disabled={!inputPath.trim() || loading}
                  className="px-3 py-1.5 text-xs font-medium bg-zinc-700 text-zinc-200 rounded-md hover:bg-zinc-600 disabled:opacity-40 transition-colors"
                >
                  Open
                </button>
              </div>
              <button
                onClick={() => setShowBrowser(true)}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 rounded-md transition-colors"
              >
                <span>📁</span>
                <span>Browse filesystem...</span>
              </button>
              {error && <p className="text-xs text-red-400">{error}</p>}
            </div>

            {/* Recent projects */}
            {projects.length > 0 && (
              <div className="max-h-64 overflow-y-auto">
                <p className="px-3 pt-2 pb-1 text-xs text-zinc-600 font-medium uppercase tracking-wide">Recent</p>
                {projects.map((p) => (
                  <button
                    key={p.path}
                    onClick={() => handleSelect(p.path)}
                    className={`w-full flex items-center gap-3 px-3 py-2.5 hover:bg-zinc-800 transition-colors group text-left ${p.path === currentPath ? "bg-zinc-800/60" : ""}`}
                  >
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-zinc-200 truncate">{p.name}</p>
                      <p className="text-xs text-zinc-500 font-mono truncate">{p.path}</p>
                    </div>
                    {p.path === currentPath && (
                      <span className="text-xs text-emerald-500 shrink-0">active</span>
                    )}
                    <button
                      onClick={(e) => handleRemove(e, p.path)}
                      className="text-zinc-700 hover:text-zinc-400 text-xs opacity-0 group-hover:opacity-100 transition-opacity shrink-0 px-1"
                      title="Remove from recents"
                    >
                      ✕
                    </button>
                  </button>
                ))}
              </div>
            )}
            {projects.length === 0 && (
              <p className="px-3 py-4 text-sm text-zinc-600 text-center">No recent projects</p>
            )}
          </div>
        )}
      </div>

      {/* Full-screen browser modal — outside the dropdown so it doesn't get clipped */}
      {open && showBrowser && (
        <DirectoryBrowser
          initialPath={currentPath ?? undefined}
          onSelect={(path) => {
            handleSelect(path);
          }}
          onCancel={() => setShowBrowser(false)}
        />
      )}
    </>
  );
}

// ── Directory browser modal ───────────────────────────────────────────────────

interface DirectoryBrowserProps {
  initialPath?: string;
  onSelect: (path: string) => void;
  onCancel: () => void;
}

function DirectoryBrowser({ initialPath, onSelect, onCancel }: DirectoryBrowserProps) {
  const [result, setResult] = useState<BrowseResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  async function navigate(path: string) {
    setLoading(true);
    setError(null);
    try {
      const data = await browseDir(path);
      setResult(data);
      setSelected(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    navigate(initialPath ?? "~");
  }, []);

  const activePath = selected ?? result?.path ?? null;

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-6">
      <div className="bg-zinc-900 border border-zinc-700 rounded-xl w-full max-w-lg shadow-2xl flex flex-col max-h-[80vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-800 shrink-0">
          <h3 className="text-sm font-semibold text-zinc-100">Browse</h3>
          <button onClick={onCancel} className="text-zinc-500 hover:text-zinc-300 text-lg leading-none">✕</button>
        </div>

        {/* Current path breadcrumb */}
        <div className="px-4 py-2 border-b border-zinc-800 shrink-0">
          <div className="flex items-center gap-1 flex-wrap">
            {result?.parent !== null && (
              <button
                onClick={() => result?.parent && navigate(result.parent)}
                className="text-xs text-zinc-500 hover:text-zinc-300 px-1 py-0.5 rounded hover:bg-zinc-800 transition-colors"
              >
                ←
              </button>
            )}
            <span className="text-xs text-zinc-400 font-mono truncate">{result?.path ?? "…"}</span>
          </div>
        </div>

        {/* Directory listing */}
        <div className="flex-1 overflow-y-auto min-h-0">
          {loading && (
            <div className="flex items-center justify-center py-12">
              <div className="w-5 h-5 border-2 border-zinc-700 border-t-zinc-400 rounded-full animate-spin" />
            </div>
          )}
          {error && <p className="text-sm text-red-400 px-4 py-4">{error}</p>}
          {!loading && result && (
            <>
              {/* Current directory as selectable option */}
              <button
                onClick={() => setSelected(result.path)}
                className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors border-b border-zinc-800/50 ${
                  selected === result.path ? "bg-zinc-700/60" : "hover:bg-zinc-800/40"
                }`}
              >
                <span className="text-base">📂</span>
                <div className="flex-1 min-w-0">
                  <span className="text-sm text-zinc-300">. (this directory)</span>
                </div>
                {result.hasBender && (
                  <span className="text-xs text-emerald-500 shrink-0">bender</span>
                )}
              </button>

              {result.dirs.length === 0 && (
                <p className="text-sm text-zinc-600 px-4 py-4 italic">No subdirectories</p>
              )}
              {result.dirs.map((dir) => (
                <button
                  key={dir.path}
                  onClick={() => setSelected(dir.path)}
                  onDoubleClick={() => navigate(dir.path)}
                  className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors group ${
                    selected === dir.path ? "bg-zinc-700/60" : "hover:bg-zinc-800/40"
                  }`}
                >
                  <span className="text-base">{dir.hasBender ? "📁" : "📁"}</span>
                  <div className="flex-1 min-w-0">
                    <span className="text-sm text-zinc-200">{dir.name}</span>
                  </div>
                  {dir.hasBender && (
                    <span className="text-xs text-emerald-500 shrink-0">bender</span>
                  )}
                  <button
                    onClick={(e) => { e.stopPropagation(); navigate(dir.path); }}
                    className="text-xs text-zinc-600 hover:text-zinc-300 opacity-0 group-hover:opacity-100 px-1.5 py-0.5 rounded hover:bg-zinc-700 transition-all"
                    title="Open directory"
                  >
                    →
                  </button>
                </button>
              ))}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-zinc-800 flex items-center gap-3 shrink-0">
          <span className="text-xs text-zinc-500 font-mono truncate flex-1">
            {activePath ?? "—"}
          </span>
          <button onClick={onCancel} className="px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 transition-colors">
            Cancel
          </button>
          <button
            onClick={() => activePath && onSelect(activePath)}
            disabled={!activePath}
            className="px-4 py-1.5 text-xs font-medium bg-zinc-100 text-zinc-900 rounded-md hover:bg-white disabled:opacity-40 transition-colors"
          >
            Select
          </button>
        </div>
      </div>
    </div>
  );
}
