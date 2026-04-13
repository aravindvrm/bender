import { useState, useEffect, useRef } from "react";
import { ChevronDown, ChevronRight, Folder, FolderOpen, Loader2 } from "lucide-react";
import { fetchProjects, selectProject, openProject, removeProject, type ProjectEntry } from "../hooks/useApi";

interface ProjectSelectorProps {
  currentPath: string | null;
  onProjectChange: () => void;
  /** Render as a compact icon-only trigger (for sidebar icon rail) */
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

async function browseDir(path?: string): Promise<BrowseResult> {
  const query = path && path.trim().length > 0 ? `?path=${encodeURIComponent(path)}` : "";
  const res = await fetch(`/api/fs/browse${query}`);
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
  const [browserRoot, setBrowserRoot] = useState<BrowseResult | null>(null);
  const [browserLoading, setBrowserLoading] = useState(false);
  const [browserError, setBrowserError] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      fetchProjects().then(setProjects).catch(() => {});
      setInputPath("");
      setError(null);
      setShowBrowser(false);
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
        <div className={`absolute w-80 bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl z-50 overflow-hidden ${compact ? "top-0 left-full ml-2" : "top-full mt-1 left-0"}`}>
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
                <span className="text-[11px] text-zinc-500 font-mono truncate">{browserRoot?.path ?? "Loading..."}</span>
              </div>

              <div className="max-h-72 overflow-y-auto px-2 py-2">
                {browserLoading && (
                  <div className="flex items-center gap-2 text-xs text-zinc-500 px-2 py-2">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    <span>Loading directories...</span>
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
          <Folder className="h-3.5 w-3.5 text-zinc-400 shrink-0" />
        )}
        <span className="truncate">{entry.name}</span>
        {entry.hasBender && <span className="ml-auto text-[10px] text-emerald-500 shrink-0">bender</span>}
      </button>

      {expanded && (
        <div>
          {loading && (
            <div className="flex items-center gap-2 text-xs text-zinc-500 pl-8 py-1">
              <Loader2 className="h-3 w-3 animate-spin" />
              <span>Loading…</span>
            </div>
          )}
          {error && <p className="text-xs text-red-400 pl-8 py-1">{error}</p>}
          {!loading && !error && children?.length === 0 && (
            <p className="text-xs text-zinc-600 pl-8 py-1 italic">No subdirectories</p>
          )}
          {!loading && !error && children?.map((child) => (
            <DirectoryTreeNode
              key={child.path}
              entry={child}
              depth={depth + 1}
              selectedPath={selectedPath}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  );
}
