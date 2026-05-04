import { useState } from "react";
import { ChevronDown, ChevronRight, AlertCircle, CheckCircle2, Loader2, XCircle } from "lucide-react";
import type { OutputLine } from "../hooks/useOperation";
import { OutputLineView } from "./drawer/OutputLineView";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type OperationStatus = "running" | "done" | "error" | "aborted";

export interface OperationSummary {
  /** Human-readable label like "Re-analyze codebase" or "/audit security" */
  label: string;
  /** Backend route the op was running */
  url?: string;
  status: OperationStatus;
  startedAt: number;
  finishedAt?: number;
  events: OutputLine[];
  /** Pre-computed counts for the collapsed summary line */
  counts?: {
    spinners?: number;
    filesChanged?: number;
    streams?: number;
    confirms?: number;
    prompts?: number;
    errors?: number;
  };
}

interface OperationBlockProps {
  op: OperationSummary;
  /** When true (live op), defaults expanded; persisted ops default collapsed */
  defaultExpanded?: boolean;
  /** Whether approval buttons should be active (false for replays of historical ops) */
  interactiveApprovals?: boolean;
  onConfirm?: (id: string, idx: number, answer: boolean) => void;
  onPromptSubmit?: (id: string, idx: number, text: string) => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function computeCounts(events: OutputLine[]): OperationSummary["counts"] {
  let spinners = 0, filesChanged = 0, streams = 0, confirms = 0, prompts = 0, errors = 0;
  for (const ev of events) {
    if (ev.kind === "spinner" && ev.done) spinners++;
    else if (ev.kind === "files") filesChanged += ev.ops.length;
    else if (ev.kind === "stream") streams++;
    else if (ev.kind === "confirm") confirms++;
    else if (ev.kind === "prompt") prompts++;
    else if (ev.kind === "error" || (ev.kind === "output" && ev.level === "error")) errors++;
  }
  return { spinners, filesChanged, streams, confirms, prompts, errors };
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return s ? `${m}m ${s}s` : `${m}m`;
}

function describeCounts(counts: OperationSummary["counts"]): string {
  if (!counts) return "";
  const parts: string[] = [];
  if (counts.spinners) parts.push(`${counts.spinners} step${counts.spinners === 1 ? "" : "s"}`);
  if (counts.filesChanged) parts.push(`${counts.filesChanged} file${counts.filesChanged === 1 ? "" : "s"}`);
  if (counts.confirms) parts.push(`${counts.confirms} approval${counts.confirms === 1 ? "" : "s"}`);
  if (counts.prompts) parts.push(`${counts.prompts} prompt${counts.prompts === 1 ? "" : "s"}`);
  if (counts.errors) parts.push(`${counts.errors} error${counts.errors === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function OperationBlock({
  op,
  defaultExpanded,
  interactiveApprovals = true,
  onConfirm,
  onPromptSubmit,
}: OperationBlockProps) {
  const isRunning = op.status === "running";
  const [expanded, setExpanded] = useState(defaultExpanded ?? isRunning);

  const counts = op.counts ?? computeCounts(op.events);
  const hasPendingApproval = op.events.some(
    (e) => (e.kind === "confirm" || e.kind === "prompt") && !e.answered,
  );

  // Force-expand when there's a pending approval — never let the user miss it
  const effectivelyExpanded = expanded || hasPendingApproval;

  // Status icon
  const StatusIcon = isRunning
    ? Loader2
    : op.status === "done"
      ? CheckCircle2
      : op.status === "error"
        ? XCircle
        : AlertCircle;
  const statusColor = isRunning
    ? "text-zinc-400"
    : op.status === "done"
      ? "text-bender-success"
      : "text-bender-danger";

  const duration = op.finishedAt
    ? formatDuration(op.finishedAt - op.startedAt)
    : isRunning
      ? formatDuration(Date.now() - op.startedAt)
      : "";

  const countSummary = describeCounts(counts);

  return (
    <div
      className="my-2 rounded-lg overflow-hidden"
      style={{
        background: "var(--bender-surface-overlay)",
        border: hasPendingApproval
          ? "1px solid var(--bender-warning)"
          : "1px solid var(--bender-overlay-border)",
      }}
    >
      {/* Header — always visible, click to toggle */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left transition-colors hover:bg-bender-overlay-hover"
      >
        <span className="shrink-0">
          {effectivelyExpanded ? <ChevronDown className="h-3 w-3 text-zinc-500" /> : <ChevronRight className="h-3 w-3 text-zinc-500" />}
        </span>
        <StatusIcon className={`h-3.5 w-3.5 shrink-0 ${statusColor} ${isRunning ? "animate-spin" : ""}`} />
        <span className="text-[11px] font-medium text-zinc-200 truncate">{op.label}</span>
        {countSummary && (
          <span className="text-[10px] text-zinc-500 truncate">· {countSummary}</span>
        )}
        <div className="flex-1" />
        {hasPendingApproval && (
          <span className="text-[9px] uppercase tracking-wide font-semibold text-bender-warning shrink-0">
            needs approval
          </span>
        )}
        {duration && (
          <span className="text-[10px] text-zinc-500 font-mono shrink-0">{duration}</span>
        )}
      </button>

      {/* Body — collapsible */}
      {effectivelyExpanded && (
        <div
          className="px-3 py-2 text-[11px] font-mono space-y-0.5 overflow-x-auto"
          style={{ borderTop: "1px solid var(--bender-overlay-border)" }}
        >
          {op.events.length === 0 && isRunning && (
            <div className="text-zinc-500 italic">Starting…</div>
          )}
          {op.events.map((line, idx) => (
            <OutputLineView
              key={idx}
              line={line}
              lineIdx={idx}
              onConfirm={(id, i, answer) => onConfirm?.(id, i, answer)}
              onPromptSubmit={(id, i, text) => onPromptSubmit?.(id, i, text)}
              interactivePrompts={interactiveApprovals}
            />
          ))}
        </div>
      )}
    </div>
  );
}
