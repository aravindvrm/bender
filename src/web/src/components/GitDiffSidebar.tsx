import { useEffect, useMemo, useState } from "react";
import { RefreshCw, X } from "lucide-react";
import type { OperationStatus } from "../hooks/useOperation";
import { GitDiffViewer } from "./GitDiffViewer";
import { LoadingDots } from "./LoadingDots";

interface GitDiffSidebarProps {
  open: boolean;
  projectPath: string | null;
  operationStatus: OperationStatus;
  onClose: () => void;
}

export function GitDiffSidebar({ open, projectPath, operationStatus, onClose }: GitDiffSidebarProps) {
  const [diffCommits, setDiffCommits] = useState(1);
  const [diffRaw, setDiffRaw] = useState<string | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  const canLoad = useMemo(() => open && !!projectPath, [open, projectPath]);

  useEffect(() => {
    if (!canLoad) return;
    let cancelled = false;
    setDiffLoading(true);
    setDiffError(null);
    fetch(`/api/git/diff?commits=${diffCommits}`)
      .then(async (r) => {
        const data = await r.json();
        if (!r.ok) throw new Error(data.error ?? "Failed to load diff");
        if (cancelled) return;
        setDiffRaw(data.diff ?? null);
        setDiffLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setDiffError((err as Error).message);
        setDiffLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [canLoad, diffCommits, refreshTick]);

  useEffect(() => {
    if (!open) return;
    if (operationStatus === "done" || operationStatus === "error") {
      setRefreshTick((v) => v + 1);
    }
  }, [open, operationStatus]);

  if (!open) return null;

  return (
    <aside className="w-[430px] max-w-[48vw] min-w-[360px] shrink-0 border-l border-zinc-800 bg-zinc-950 flex flex-col">
      <div className="h-10 px-3 border-b border-zinc-800/60 flex items-center gap-2">
        <h3 className="text-xs font-medium text-zinc-300">Git Diff</h3>
        <div className="flex-1" />
        <button
          onClick={() => setRefreshTick((v) => v + 1)}
          className="text-zinc-600 hover:text-zinc-300 transition-colors p-1 rounded hover:bg-zinc-900"
          title="Refresh diff"
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={onClose}
          className="text-zinc-600 hover:text-zinc-300 transition-colors p-1 rounded hover:bg-zinc-900"
          title="Close diff panel"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="px-3 py-2 border-b border-zinc-800/60 flex items-center gap-2 flex-wrap">
        <span className="text-[11px] text-zinc-500">Latest</span>
        {[1, 2, 3, 5].map((n) => (
          <button
            key={n}
            onClick={() => setDiffCommits(n)}
            className={`px-2 py-1 rounded text-[11px] border transition-colors ${
              diffCommits === n
                ? "bg-zinc-700 border-zinc-500 text-zinc-100"
                : "bg-transparent border-zinc-700 text-zinc-500 hover:border-zinc-500 hover:text-zinc-300"
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
        {projectPath && diffError && <p className="text-xs text-red-400/80">{diffError}</p>}
        {projectPath && !diffLoading && !diffError && !diffRaw && (
          <p className="text-xs text-zinc-500">No diff available.</p>
        )}
        {projectPath && !diffLoading && diffRaw && <GitDiffViewer raw={diffRaw} />}
      </div>
    </aside>
  );
}

