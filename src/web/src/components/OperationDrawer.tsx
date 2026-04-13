import { useState, useRef, useEffect } from "react";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import type { OutputLine, OperationStatus, OperationModal } from "../hooks/useOperation";

interface OperationDrawerProps {
  lines: OutputLine[];
  status: OperationStatus;
  drawerOpen: boolean;
  modal: OperationModal;
  inputText: string;
  onSetDrawerOpen: (open: boolean) => void;
  onSetModal: (modal: OperationModal) => void;
  onSetInputText: (text: string) => void;
  onConfirm: (id: string, lineIdx: number, answer: boolean) => void;
  onPromptSubmit: (id: string, lineIdx: number, text: string) => void;
  onClear: () => void;
  onAbort: () => void;
  onSubmitModal: (kind: "init" | "plan", text: string) => void;
}

export function OperationDrawer({
  lines,
  status,
  drawerOpen,
  modal,
  inputText,
  onSetDrawerOpen,
  onSetModal,
  onSetInputText,
  onConfirm,
  onPromptSubmit,
  onClear,
  onAbort,
  onSubmitModal,
}: OperationDrawerProps) {
  const [collapsed, setCollapsed] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const isRunning = status === "running";

  // Auto-scroll to bottom on new output
  useEffect(() => {
    if (!collapsed) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [lines, collapsed]);

  // Auto-expand when operation starts
  useEffect(() => {
    if (status === "running") setCollapsed(false);
  }, [status]);

  const statusLabel =
    status === "running" ? "Running…" :
    status === "done" ? "Done" :
    status === "error" ? "Error" : "Output";

  const statusColor =
    status === "running" ? "text-zinc-400" :
    status === "done" ? "text-emerald-400" :
    status === "error" ? "text-red-400" : "text-zinc-500";

  if (!drawerOpen) return null;

  return (
    <>
      {/* Input modal — overlays everything */}
      {modal && (
        <InputModal
          title={modal.kind === "init" ? "New Project" : "New Task"}
          placeholder={
            modal.kind === "init"
              ? "Describe what you want to build…"
              : "Describe the feature, fix, or change…"
          }
          value={inputText}
          onChange={onSetInputText}
          onSubmit={() => {
            const text = inputText.trim();
            if (!text) return;
            const kind = modal.kind;
            onSetInputText("");
            onSetModal(null);
            onSubmitModal(kind, text);
          }}
          onCancel={() => { onSetModal(null); onSetInputText(""); }}
        />
      )}

      {/* Drawer */}
      <div className={`shrink-0 border-t border-zinc-800 bg-zinc-950 flex flex-col transition-all duration-200 ${collapsed ? "h-10" : "h-72"}`}>

        {/* Drawer header */}
        <div className="flex items-center gap-2 px-4 h-10 shrink-0 border-b border-zinc-800/60">
          {isRunning && (
            <span className="w-1.5 h-1.5 rounded-full bg-zinc-500 animate-pulse shrink-0" />
          )}
          <span className={`text-xs font-medium ${statusColor} flex-1`}>{statusLabel}</span>

          {isRunning && (
            <button
              onClick={onAbort}
              className="text-xs text-red-400/70 hover:text-red-400 transition-colors px-2 py-0.5 rounded border border-red-900/50 hover:border-red-700"
            >
              Stop
            </button>
          )}
          {(status === "done" || status === "error") && (
            <button
              onClick={onClear}
              className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors px-2 py-0.5 rounded border border-zinc-800 hover:border-zinc-600"
            >
              Clear
            </button>
          )}

          <button
            onClick={() => setCollapsed((v) => !v)}
            className="text-zinc-600 hover:text-zinc-400 transition-colors ml-1"
            title={collapsed ? "Expand" : "Collapse"}
          >
            {collapsed ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          </button>
          <button
            onClick={() => onSetDrawerOpen(false)}
            className="text-zinc-600 hover:text-zinc-400 transition-colors"
            title="Close"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* Output */}
        {!collapsed && (
          <div className="flex-1 overflow-y-auto p-4 font-mono text-xs space-y-0.5">
            {lines.length === 0 && (
              <p className="text-zinc-600 italic">Starting…</p>
            )}
            {lines.map((line, i) => (
              <OutputLineView
                key={i}
                line={line}
                lineIdx={i}
                onConfirm={onConfirm}
                onPromptSubmit={onPromptSubmit}
              />
            ))}
            {isRunning && (
              <div className="flex items-center gap-1.5 text-zinc-500 pt-1">
                <span className="w-1.5 h-1.5 bg-zinc-500 rounded-full animate-pulse" />
                <span>running</span>
              </div>
            )}
            <div ref={bottomRef} />
          </div>
        )}
      </div>
    </>
  );
}

// ── Output line renderer ──────────────────────────────────────────────────────

interface LineProps {
  line: OutputLine;
  lineIdx: number;
  onConfirm: (id: string, idx: number, answer: boolean) => void;
  onPromptSubmit: (id: string, idx: number, text: string) => void;
}

function OutputLineView({ line, lineIdx, onConfirm, onPromptSubmit }: LineProps) {
  const [promptInput, setPromptInput] = useState("");

  switch (line.kind) {
    case "header":
      return <div className="text-zinc-100 font-bold pt-2 pb-0.5 border-b border-zinc-700 mb-1">=== {line.text} ===</div>;

    case "subheader":
      return <div className="text-zinc-300 font-semibold pt-2">--- {line.text} ---</div>;

    case "output": {
      const colors: Record<string, string> = {
        info: "text-zinc-400",
        success: "text-emerald-400",
        warn: "text-amber-400",
        error: "text-red-400",
      };
      return <div className={colors[line.level] ?? "text-zinc-400"}>{line.text}</div>;
    }

    case "stream":
      return <div className="text-zinc-300 whitespace-pre-wrap">{line.text}</div>;

    case "spinner":
      return (
        <div className="flex items-center gap-2 text-zinc-400">
          {line.done ? (
            <span className={line.success ? "text-emerald-400" : "text-red-400"}>{line.success ? "✓" : "✗"}</span>
          ) : (
            <span className="animate-spin inline-block">⟳</span>
          )}
          <span>{line.text}</span>
        </div>
      );

    case "files":
      return (
        <div className="pt-1 pb-1 space-y-0.5">
          {line.ops.map((op, i) => (
            <div key={i} className="flex items-center gap-2">
              <span className={op.action === "create" ? "text-emerald-400 w-8" : "text-amber-400 w-8"}>{op.action.toUpperCase()}</span>
              <span className="text-zinc-300">{op.path}</span>
            </div>
          ))}
        </div>
      );

    case "confirm":
      return (
        <div className="my-2 p-3 bg-zinc-800/60 rounded-lg border border-zinc-700 space-y-2">
          <p className="text-zinc-200 font-sans">{line.question}</p>
          {line.answered ? (
            <p className={`text-xs font-sans ${line.answer ? "text-emerald-400" : "text-red-400"}`}>
              → {line.answer ? "Approved" : "Declined"}
            </p>
          ) : (
            <div className="flex gap-2">
              <button
                onClick={() => onConfirm(line.id, lineIdx, true)}
                className="px-3 py-1 text-xs rounded bg-emerald-900/50 border border-emerald-700 text-emerald-300 hover:bg-emerald-900 transition-colors font-sans"
              >
                Approve
              </button>
              <button
                onClick={() => onConfirm(line.id, lineIdx, false)}
                className="px-3 py-1 text-xs rounded bg-zinc-900 border border-zinc-600 text-zinc-400 hover:bg-zinc-800 transition-colors font-sans"
              >
                Decline
              </button>
            </div>
          )}
        </div>
      );

    case "prompt":
      return (
        <div className="my-2 p-3 bg-zinc-800/60 rounded-lg border border-zinc-700 space-y-2">
          <p className="text-zinc-200 font-sans">{line.question}</p>
          {line.answered ? (
            <p className="text-xs text-zinc-400 italic font-sans">→ {line.answer?.slice(0, 80)}{(line.answer?.length ?? 0) > 80 ? "…" : ""}</p>
          ) : (
            <div className="space-y-2">
              <textarea
                value={promptInput}
                onChange={(e) => setPromptInput(e.target.value)}
                placeholder="Type your answer…"
                rows={3}
                className="w-full bg-zinc-900 border border-zinc-600 rounded px-3 py-2 text-sm text-zinc-200 font-sans focus:outline-none focus:border-zinc-400 resize-none"
              />
              <button
                onClick={() => onPromptSubmit(line.id, lineIdx, promptInput)}
                className="px-3 py-1 text-xs rounded bg-zinc-700 border border-zinc-600 text-zinc-200 hover:bg-zinc-600 transition-colors font-sans"
              >
                Submit
              </button>
            </div>
          )}
        </div>
      );

    case "done":
      return (
        <div className={`pt-2 font-semibold font-sans ${line.success ? "text-emerald-400" : "text-red-400"}`}>
          {line.success ? "✓ Operation completed successfully." : "✗ Operation finished with errors."}
        </div>
      );

    case "error":
      return <div className="text-red-400 pt-1 font-sans">Error: {line.message}</div>;

    default:
      return null;
  }
}

// ── Input modal ───────────────────────────────────────────────────────────────

interface InputModalProps {
  title: string;
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}

function InputModal({ title, placeholder, value, onChange, onSubmit, onCancel }: InputModalProps) {
  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-zinc-900 border border-zinc-700 rounded-xl w-full max-w-lg shadow-2xl">
        <div className="px-5 py-4 border-b border-zinc-800">
          <h3 className="text-sm font-semibold text-zinc-100">{title}</h3>
        </div>
        <div className="p-5 space-y-4">
          <textarea
            autoFocus
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
            rows={5}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) onSubmit();
              if (e.key === "Escape") onCancel();
            }}
            className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-4 py-3 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-500 resize-none"
          />
          <p className="text-xs text-zinc-600">⌘ Enter to start</p>
        </div>
        <div className="px-5 py-3 border-t border-zinc-800 flex justify-end gap-2">
          <button onClick={onCancel} className="px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 transition-colors">
            Cancel
          </button>
          <button
            onClick={onSubmit}
            disabled={!value.trim()}
            className="px-4 py-1.5 text-xs font-medium bg-zinc-100 text-zinc-900 rounded-md hover:bg-white disabled:opacity-40 transition-colors"
          >
            Start
          </button>
        </div>
      </div>
    </div>
  );
}
