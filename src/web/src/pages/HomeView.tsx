import { useEffect, useState } from "react";
import { FolderOpen, Plus, GitBranch } from "lucide-react";

interface RecentProject {
  name: string;
  path: string;
  lastOpened?: number;
}

function relativeTime(ts: number): string {
  const diffMs = Date.now() - ts;
  const secs = Math.floor(diffMs / 1000);
  if (secs < 60) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Shorten an absolute path for display: show last 2–3 segments */
function shortenPath(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 3) return path;
  return "…/" + parts.slice(-2).join("/");
}

export function HomeView({ onProjectOpened }: { onProjectOpened?: () => void }) {
  const [projects, setProjects] = useState<RecentProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [opening, setOpening] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch("/api/projects")
      .then(async (res) => {
        const data = await res.json().catch(() => []) as RecentProject[];
        if (cancelled) return;
        const sorted = [...(Array.isArray(data) ? data : [])]
          .sort((a, b) => (b.lastOpened ?? 0) - (a.lastOpened ?? 0));
        setProjects(sorted);
      })
      .catch(() => { if (!cancelled) setProjects([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  async function openProject(path: string) {
    if (opening) return;
    setOpening(path);
    setError(null);
    try {
      const res = await fetch("/api/project/select", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path }),
      });
      const data = await res.json().catch(() => ({})) as { ok?: boolean; error?: string };
      if (!res.ok) {
        setError(data.error ?? `Failed to open project (${res.status})`);
        return;
      }
      onProjectOpened?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to open project");
    } finally {
      setOpening(null);
    }
  }

  const isOpening = !!opening;

  return (
    <div className="min-h-full flex flex-col items-center px-8 pt-10 pb-6">
      <div className="w-full max-w-2xl space-y-4">

        {/* Project tiles */}
        <div>
          <p className="text-[10px] uppercase tracking-widest text-zinc-600 mb-3">Projects</p>

          {loading ? (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
              {Array.from({ length: 6 }).map((_, i) => (
                <div
                  key={i}
                  className="h-[88px] rounded-xl bg-zinc-900/50 border border-zinc-800/40 animate-pulse"
                />
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
              {/* Recent project tiles */}
              {projects.slice(0, 8).map((project) => {
                const isThisOpening = opening === project.path;
                return (
                  <button
                    key={project.path}
                    type="button"
                    onClick={() => void openProject(project.path)}
                    disabled={isOpening}
                    className={`
                      group relative flex flex-col items-start gap-1.5 p-3.5
                      rounded-xl border text-left
                      transition-all duration-150
                      ${isThisOpening
                        ? "border-zinc-700 bg-zinc-800/60 cursor-wait opacity-70"
                        : "border-zinc-800/60 bg-zinc-900/40 hover:bg-zinc-800/50 hover:border-zinc-700/80 hover:shadow-lg hover:shadow-black/20 cursor-pointer active:scale-[0.98]"
                      }
                    `}
                  >
                    {/* Last opened badge — top right */}
                    {project.lastOpened && (
                      <span className="absolute top-2.5 right-2.5 text-[9px] text-zinc-700 group-hover:text-zinc-600 transition-colors select-none">
                        {relativeTime(project.lastOpened)}
                      </span>
                    )}

                    {/* Icon */}
                    <div className={`w-7 h-7 rounded-lg flex items-center justify-center transition-colors ${
                      isThisOpening ? "bg-zinc-700" : "bg-zinc-800 group-hover:bg-zinc-700"
                    }`}>
                      {isThisOpening
                        ? <div className="w-3 h-3 rounded-full border border-zinc-500 border-t-transparent animate-spin" />
                        : <FolderOpen className="h-3.5 w-3.5 text-zinc-500 group-hover:text-zinc-300 transition-colors" />
                      }
                    </div>

                    {/* Name + path */}
                    <div className="w-full min-w-0 pr-4">
                      <p className="text-[12px] font-medium text-zinc-300 group-hover:text-zinc-100 transition-colors truncate leading-snug">
                        {project.name}
                      </p>
                      <p className="text-[10px] text-zinc-700 group-hover:text-zinc-600 font-mono truncate mt-0.5 transition-colors">
                        {shortenPath(project.path)}
                      </p>
                    </div>
                  </button>
                );
              })}

              {/* New Project tile */}
              <button
                type="button"
                onClick={() => {
                  // Dispatch a synthetic event that App.tsx can pick up to open the new-project modal
                  window.dispatchEvent(new CustomEvent("bender:new-project"));
                }}
                className="
                  group flex flex-col items-start gap-1.5 p-3.5
                  rounded-xl border text-left
                  border-dashed border-zinc-800/80 bg-transparent
                  hover:border-zinc-700 hover:bg-zinc-900/30
                  transition-all duration-150 cursor-pointer active:scale-[0.98]
                "
              >
                <div className="w-7 h-7 rounded-lg flex items-center justify-center bg-zinc-900 group-hover:bg-zinc-800 border border-dashed border-zinc-700/60 group-hover:border-zinc-600 transition-colors">
                  <Plus className="h-3.5 w-3.5 text-zinc-600 group-hover:text-zinc-400 transition-colors" />
                </div>
                <div className="w-full min-w-0">
                  <p className="text-[12px] font-medium text-zinc-600 group-hover:text-zinc-400 transition-colors">
                    New project
                  </p>
                  <p className="text-[10px] text-zinc-700 group-hover:text-zinc-600 transition-colors mt-0.5">
                    Initialize from directory
                  </p>
                </div>
              </button>

              {/* Clone tile */}
              <button
                type="button"
                onClick={() => {
                  window.dispatchEvent(new CustomEvent("bender:focus-chat", { detail: "Clone a GitHub repo: " }));
                }}
                className="
                  group flex flex-col items-start gap-1.5 p-3.5
                  rounded-xl border text-left
                  border-dashed border-zinc-800/80 bg-transparent
                  hover:border-zinc-700 hover:bg-zinc-900/30
                  transition-all duration-150 cursor-pointer active:scale-[0.98]
                "
              >
                <div className="w-7 h-7 rounded-lg flex items-center justify-center bg-zinc-900 group-hover:bg-zinc-800 border border-dashed border-zinc-700/60 group-hover:border-zinc-600 transition-colors">
                  <GitBranch className="h-3.5 w-3.5 text-zinc-600 group-hover:text-zinc-400 transition-colors" />
                </div>
                <div className="w-full min-w-0">
                  <p className="text-[12px] font-medium text-zinc-600 group-hover:text-zinc-400 transition-colors">
                    Clone repo
                  </p>
                  <p className="text-[10px] text-zinc-700 group-hover:text-zinc-600 transition-colors mt-0.5">
                    GitHub or any Git URL
                  </p>
                </div>
              </button>
            </div>
          )}

          {error && (
            <p className="text-xs text-red-400/80 mt-3">{error}</p>
          )}
        </div>
      </div>
    </div>
  );
}
