import { useEffect, useRef, useState, useCallback } from "react";
import { LoadingDots } from "./LoadingDots";

// ---------------------------------------------------------------------------
// Types (mirror src/cli/services/run-history.ts)
// ---------------------------------------------------------------------------

type RunStatus = "running" | "done" | "error" | "aborted";

type RunEventKind =
  | "header" | "subheader"
  | "info" | "success" | "warn" | "error"
  | "stream"
  | "spinner-start" | "spinner-update" | "spinner-end"
  | "files" | "confirm" | "prompt" | "done";

interface RunEvent {
  ts: number;
  kind: RunEventKind;
  payload: Record<string, unknown>;
}

interface RunSummary {
  id: string;
  label: string;
  operationType: string;
  projectRoot: string;
  startedAt: number;
  durationMs: number | null;
  status: RunStatus;
  eventCount: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatRelativeTime(ts: number): string {
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  return `${hr}h ago`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
}

// ---------------------------------------------------------------------------
// Individual event line renderer
// ---------------------------------------------------------------------------

function RunEventLine({ event }: { event: RunEvent }) {
  const { kind, payload } = event;
  const text = typeof payload.text === "string" ? payload.text : "";

  switch (kind) {
    case "header":
      return (
        <div className="text-zinc-100 font-bold pt-2 pb-0.5 border-b border-zinc-700 mb-1 text-[11px]">
          === {text} ===
        </div>
      );

    case "subheader":
      return <div className="text-zinc-300 font-semibold pt-2 text-[11px]">--- {text} ---</div>;

    case "info":
      return <div className="text-zinc-400 text-[11px]">{text}</div>;

    case "success":
      return <div className="text-emerald-400 text-[11px]">{text}</div>;

    case "warn":
      return <div className="text-amber-400 text-[11px]">{text}</div>;

    case "error":
      return <div className="text-red-400 text-[11px]">{text}</div>;

    case "stream":
      return <div className="text-zinc-300 whitespace-pre-wrap text-[11px]">{text}</div>;

    case "spinner-start":
      return (
        <div className="flex items-center gap-1.5 text-zinc-500 text-[11px]">
          <span className="w-3">⟳</span>
          <span>{text}</span>
        </div>
      );

    case "spinner-update":
      return null; // Intermediate updates hidden in history view

    case "spinner-end": {
      const success = payload.success;
      return (
        <div className="flex items-center gap-1.5 text-[11px]">
          {success === true ? (
            <span className="text-emerald-400 w-3">✓</span>
          ) : success === false ? (
            <span className="text-red-400 w-3">✗</span>
          ) : (
            <span className="text-zinc-500 w-3">·</span>
          )}
          <span className={success === true ? "text-zinc-300" : success === false ? "text-red-300/70" : "text-zinc-500"}>
            {text}
          </span>
        </div>
      );
    }

    case "files": {
      const ops = Array.isArray(payload.ops)
        ? payload.ops as Array<{ path: string; action: string }>
        : [];
      return (
        <div className="pt-0.5 pb-0.5 space-y-0.5">
          {ops.map((op, i) => (
            <div key={i} className="flex items-center gap-1.5 text-[11px]">
              <span className={op.action === "create" ? "text-emerald-400 w-7" : "text-amber-400 w-7"}>
                {op.action.slice(0, 3).toUpperCase()}
              </span>
              <span className="text-zinc-300 font-mono">{op.path}</span>
            </div>
          ))}
        </div>
      );
    }

    case "confirm": {
      const question = typeof payload.question === "string" ? payload.question : "";
      return (
        <div className="my-1 px-2 py-1.5 bg-zinc-800/40 rounded border border-zinc-700/50 text-[11px]">
          <span className="text-zinc-400">? </span>
          <span className="text-zinc-300">{question}</span>
          <span className="text-zinc-600 ml-2">→ handled in chat</span>
        </div>
      );
    }

    case "prompt": {
      const question = typeof payload.question === "string" ? payload.question : "";
      return (
        <div className="my-1 px-2 py-1.5 bg-zinc-800/40 rounded border border-zinc-700/50 text-[11px]">
          <span className="text-zinc-400">? </span>
          <span className="text-zinc-300">{question}</span>
          <span className="text-zinc-600 ml-2">→ handled in chat</span>
        </div>
      );
    }

    case "done": {
      const success = payload.success;
      return (
        <div className={`pt-1.5 font-semibold text-[11px] ${success ? "text-emerald-400" : "text-red-400"}`}>
          {success ? "✓ Completed." : "✗ Finished with errors."}
        </div>
      );
    }

    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Run list item
// ---------------------------------------------------------------------------

function RunListItem({
  run,
  selected,
  onClick,
}: {
  run: RunSummary;
  selected: boolean;
  onClick: () => void;
}) {
  const statusDot = {
    running: "bg-blue-400 animate-pulse",
    done: "bg-emerald-400",
    error: "bg-red-400",
    aborted: "bg-zinc-500",
  }[run.status];

  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-3 py-2 border-b border-zinc-800/60 transition-colors ${
        selected ? "bg-zinc-800" : "hover:bg-zinc-900"
      }`}
    >
      <div className="flex items-center gap-2 min-w-0">
        <span className={`shrink-0 w-1.5 h-1.5 rounded-full ${statusDot}`} />
        <span className="text-[11px] text-zinc-200 truncate flex-1">{run.label}</span>
        {run.durationMs != null && (
          <span className="text-[10px] text-zinc-600 shrink-0">{formatDuration(run.durationMs)}</span>
        )}
      </div>
      <div className="text-[10px] text-zinc-600 mt-0.5 pl-3.5">
        {formatRelativeTime(run.startedAt)}
      </div>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

interface RunHistoryPanelProps {
  projectPath: string | null;
  /** Pass the current operation status so the panel knows when to refresh. */
  operationStatus: "idle" | "running" | "done" | "error";
}

export function RunHistoryPanel({ projectPath, operationStatus }: RunHistoryPanelProps) {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [loadingEvents, setLoadingEvents] = useState(false);
  const [loadingList, setLoadingList] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isRunning = operationStatus === "running";

  // ------------------------------------------------------------------
  // Fetch run list
  // ------------------------------------------------------------------

  const fetchRuns = useCallback(async () => {
    if (!projectPath) { setRuns([]); return; }
    setLoadingList(true);
    try {
      const res = await fetch("/api/runs");
      if (!res.ok) return;
      const data = await res.json() as { runs: RunSummary[] };
      setRuns(data.runs ?? []);
    } catch {
      // Network error — silently fail
    } finally {
      setLoadingList(false);
    }
  }, [projectPath]);

  // ------------------------------------------------------------------
  // Fetch events for selected run
  // ------------------------------------------------------------------

  const fetchEvents = useCallback(async (id: string) => {
    if (!projectPath) return;
    setLoadingEvents(true);
    try {
      const res = await fetch(`/api/runs/${id}`);
      if (!res.ok) return;
      const data = await res.json() as { events: RunEvent[] };
      setEvents(data.events ?? []);
    } catch {
      // ignore
    } finally {
      setLoadingEvents(false);
    }
  }, [projectPath]);

  // ------------------------------------------------------------------
  // On project change: reset + reload
  // ------------------------------------------------------------------

  useEffect(() => {
    setRuns([]);
    setSelectedId(null);
    setEvents([]);
    void fetchRuns();
  }, [projectPath, fetchRuns]);

  // ------------------------------------------------------------------
  // Refresh run list + events when an operation finishes/starts
  // ------------------------------------------------------------------

  useEffect(() => {
    void fetchRuns();
  }, [operationStatus, fetchRuns]);

  // ------------------------------------------------------------------
  // Auto-select most recent run (or the running one)
  // ------------------------------------------------------------------

  useEffect(() => {
    if (runs.length === 0) { setSelectedId(null); return; }
    const runningRun = runs.find((r) => r.status === "running");
    const target = runningRun ?? runs[0];
    if (target && (selectedId === null || (runningRun && selectedId !== runningRun.id))) {
      setSelectedId(target.id);
    }
  }, [runs]); // eslint-disable-line react-hooks/exhaustive-deps

  // ------------------------------------------------------------------
  // Fetch events when selection changes
  // ------------------------------------------------------------------

  useEffect(() => {
    if (!selectedId) { setEvents([]); return; }
    void fetchEvents(selectedId);
  }, [selectedId, fetchEvents]);

  // ------------------------------------------------------------------
  // Poll events for the running run
  // ------------------------------------------------------------------

  useEffect(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    if (!isRunning || !selectedId) return;

    pollRef.current = setInterval(async () => {
      await fetchRuns();
      if (selectedId) await fetchEvents(selectedId);
    }, 2000);

    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [isRunning, selectedId, fetchRuns, fetchEvents]);

  // ------------------------------------------------------------------
  // Auto-scroll when live-tailing a running run
  // ------------------------------------------------------------------

  useEffect(() => {
    if (isRunning) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [events, isRunning]);

  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------

  if (!projectPath) {
    return (
      <div className="flex items-center justify-center h-full text-xs text-zinc-600">
        No project open
      </div>
    );
  }

  const selectedRun = runs.find((r) => r.id === selectedId) ?? null;

  return (
    <div className="flex h-full min-h-0 font-mono text-xs">
      {/* Left rail — run list */}
      <div className="w-44 shrink-0 border-r border-zinc-800 overflow-y-auto flex flex-col">
        <div className="px-3 py-2 border-b border-zinc-800/60 flex items-center justify-between">
          <span className="text-[10px] text-zinc-500 uppercase tracking-wider">Runs</span>
          {loadingList && <LoadingDots size={8} />}
        </div>
        {runs.length === 0 ? (
          <div className="p-3 text-[10px] text-zinc-700 italic">No runs yet</div>
        ) : (
          runs.map((run) => (
            <RunListItem
              key={run.id}
              run={run}
              selected={run.id === selectedId}
              onClick={() => setSelectedId(run.id)}
            />
          ))
        )}
      </div>

      {/* Right — event stream */}
      <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
        {/* Run header */}
        {selectedRun && (
          <div className="px-3 py-1.5 border-b border-zinc-800/60 flex items-center gap-2 shrink-0">
            <span className="text-zinc-200 text-[11px] font-sans">{selectedRun.label}</span>
            {selectedRun.status === "running" && (
              <LoadingDots size={10} className="ml-1" />
            )}
            {selectedRun.durationMs != null && (
              <span className="text-zinc-600 text-[10px] font-sans ml-auto">
                {formatDuration(selectedRun.durationMs)}
              </span>
            )}
          </div>
        )}

        {/* Events */}
        <div className="flex-1 overflow-y-auto p-3 space-y-0.5">
          {!selectedId && (
            <p className="text-zinc-700 italic text-[11px]">Select a run to view its log.</p>
          )}
          {selectedId && loadingEvents && events.length === 0 && (
            <div className="flex items-center gap-2 text-zinc-600 text-[11px]">
              <LoadingDots size={10} />
              <span>Loading…</span>
            </div>
          )}
          {events.map((event, i) => (
            <RunEventLine key={i} event={event} />
          ))}
          {selectedRun?.status === "running" && events.length === 0 && !loadingEvents && (
            <div className="flex items-center gap-1.5 text-zinc-600 text-[11px]">
              <LoadingDots size={10} />
              <span>Waiting for output…</span>
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      </div>
    </div>
  );
}
