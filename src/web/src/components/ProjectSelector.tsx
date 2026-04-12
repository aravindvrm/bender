import { useState, useEffect, useRef } from "react";
import { fetchProjects, selectProject, openProject, removeProject, type ProjectEntry } from "../hooks/useApi";

interface ProjectSelectorProps {
  currentPath: string | null;
  onProjectChange: () => void;
}

export function ProjectSelector({ currentPath, onProjectChange }: ProjectSelectorProps) {
  const [open, setOpen] = useState(false);
  const [projects, setProjects] = useState<ProjectEntry[]>([]);
  const [inputPath, setInputPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      fetchProjects().then(setProjects).catch(() => {});
      setInputPath("");
      setError(null);
    }
  }, [open]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function handler(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false);
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
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 transition-colors text-sm text-zinc-200 max-w-64"
      >
        <span className="text-zinc-500 text-xs">◈</span>
        <span className="truncate">{displayName}</span>
        <span className="text-zinc-600 text-xs ml-1 shrink-0">▾</span>
      </button>

      {open && (
        <div className="absolute top-full mt-1 left-0 w-80 bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl z-50 overflow-hidden">
          {/* Path input */}
          <div className="p-3 border-b border-zinc-800">
            <div className="flex gap-2">
              <input
                autoFocus
                type="text"
                value={inputPath}
                onChange={(e) => setInputPath(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") handleOpen(); if (e.key === "Escape") setOpen(false); }}
                placeholder="/path/to/project"
                className="flex-1 bg-zinc-800 border border-zinc-700 rounded-md px-3 py-1.5 text-sm text-zinc-200 font-mono placeholder:text-zinc-600 focus:outline-none focus:border-zinc-500"
              />
              <button
                onClick={handleOpen}
                disabled={!inputPath.trim() || loading}
                className="px-3 py-1.5 text-xs font-medium bg-zinc-700 text-zinc-200 rounded-md hover:bg-zinc-600 disabled:opacity-40 transition-colors whitespace-nowrap"
              >
                Open
              </button>
            </div>
            {error && <p className="text-xs text-red-400 mt-2">{error}</p>}
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
  );
}
