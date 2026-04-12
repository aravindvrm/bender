import { useState, useRef, useEffect, useCallback } from "react";
import type { ProjectState } from "../hooks/useApi";

interface ConsoleViewProps {
  state: ProjectState | null;
  onStateChange?: () => void;
}

// ── SSE event types (mirrors server.ts) ──────────────────────────────────────

type SSEEvent =
  | { type: "header"; text: string }
  | { type: "subheader"; text: string }
  | { type: "output"; text: string; level: "info" | "success" | "warn" | "error" }
  | { type: "stream"; chunk: string }
  | { type: "spinner"; text: string; state: "start" | "succeed" | "fail" | "stop" }
  | { type: "files"; ops: { path: string; action: string }[] }
  | { type: "confirm"; id: string; question: string; default: boolean }
  | { type: "prompt"; id: string; question: string }
  | { type: "done"; success: boolean }
  | { type: "error"; message: string };

// ── Output line types ─────────────────────────────────────────────────────────

type OutputLine =
  | { kind: "header"; text: string }
  | { kind: "subheader"; text: string }
  | { kind: "output"; text: string; level: "info" | "success" | "warn" | "error" }
  | { kind: "stream"; text: string }
  | { kind: "spinner"; text: string; done: boolean; success?: boolean }
  | { kind: "files"; ops: { path: string; action: string }[] }
  | { kind: "confirm"; id: string; question: string; default: boolean; answered?: boolean; answer?: boolean }
  | { kind: "prompt"; id: string; question: string; answered?: boolean; answer?: string }
  | { kind: "done"; success: boolean }
  | { kind: "error"; message: string };

// ── SSE streaming hook ────────────────────────────────────────────────────────

function parseSSEChunk(chunk: string, onEvent: (e: SSEEvent) => void) {
  for (const line of chunk.split("\n")) {
    if (line.startsWith("data: ")) {
      try {
        onEvent(JSON.parse(line.slice(6)));
      } catch {}
    }
  }
}

async function streamOperation(
  url: string,
  body: Record<string, unknown>,
  onEvent: (e: SSEEvent) => void,
  signal: AbortSignal,
) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok || !res.body) {
    const err = await res.text();
    onEvent({ type: "error", message: err || "Request failed" });
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    parseSSEChunk(decoder.decode(value, { stream: true }), onEvent);
  }
}

async function sendAnswer(id: string, answer: string) {
  await fetch("/api/run/answer", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, answer }),
  });
}

// ── Main component ────────────────────────────────────────────────────────────

type Status = "idle" | "running" | "done" | "error";
type Modal = { kind: "init" } | { kind: "plan" } | null;

export function ConsoleView({ state, onStateChange }: ConsoleViewProps) {
  const [lines, setLines] = useState<OutputLine[]>([]);
  const [status, setStatus] = useState<Status>("idle");
  const [modal, setModal] = useState<Modal>(null);
  const [inputText, setInputText] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const isInitialized = state?.initialized ?? false;

  // Auto-scroll to bottom
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [lines]);

  const addLine = useCallback((line: OutputLine) => {
    setLines((prev) => [...prev, line]);
  }, []);

  const updateLastSpinner = useCallback((text: string, done: boolean, success?: boolean) => {
    setLines((prev) => {
      const idx = [...prev].reverse().findIndex((l) => l.kind === "spinner" && !l.done);
      if (idx === -1) return [...prev, { kind: "spinner", text, done, success }];
      const realIdx = prev.length - 1 - idx;
      const next = [...prev];
      next[realIdx] = { kind: "spinner", text, done, success };
      return next;
    });
  }, []);

  const appendStream = useCallback((chunk: string) => {
    setLines((prev) => {
      const last = prev[prev.length - 1];
      if (last?.kind === "stream") {
        return [...prev.slice(0, -1), { kind: "stream", text: last.text + chunk }];
      }
      return [...prev, { kind: "stream", text: chunk }];
    });
  }, []);

  const handleEvent = useCallback(
    (event: SSEEvent) => {
      switch (event.type) {
        case "header":
          addLine({ kind: "header", text: event.text });
          break;
        case "subheader":
          addLine({ kind: "subheader", text: event.text });
          break;
        case "output":
          addLine({ kind: "output", text: event.text, level: event.level });
          break;
        case "stream":
          appendStream(event.chunk);
          break;
        case "spinner":
          if (event.state === "start") {
            setLines((prev) => {
              const last = prev[prev.length - 1];
              if (last?.kind === "spinner" && !last.done) {
                return [...prev.slice(0, -1), { kind: "spinner", text: event.text, done: false }];
              }
              return [...prev, { kind: "spinner", text: event.text, done: false }];
            });
          } else {
            updateLastSpinner(event.text, true, event.state === "succeed");
          }
          break;
        case "files":
          addLine({ kind: "files", ops: event.ops });
          break;
        case "confirm":
          addLine({ kind: "confirm", id: event.id, question: event.question, default: event.default });
          break;
        case "prompt":
          addLine({ kind: "prompt", id: event.id, question: event.question });
          break;
        case "done":
          addLine({ kind: "done", success: event.success });
          setStatus("done");
          onStateChange?.();
          break;
        case "error":
          addLine({ kind: "error", message: event.message });
          setStatus("error");
          break;
      }
    },
    [addLine, appendStream, updateLastSpinner, onStateChange],
  );

  async function startOperation(url: string, body: Record<string, unknown>) {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLines([]);
    setStatus("running");
    try {
      await streamOperation(url, body, handleEvent, ctrl.signal);
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        addLine({ kind: "error", message: (err as Error).message });
        setStatus("error");
      }
    }
    if (status === "running") setStatus("done");
  }

  async function handleConfirm(id: string, lineIdx: number, answer: boolean) {
    setLines((prev) => {
      const next = [...prev];
      const line = next[lineIdx];
      if (line.kind === "confirm") {
        next[lineIdx] = { ...line, answered: true, answer };
      }
      return next;
    });
    await sendAnswer(id, String(answer));
  }

  async function handlePromptSubmit(id: string, lineIdx: number, text: string) {
    setLines((prev) => {
      const next = [...prev];
      const line = next[lineIdx];
      if (line.kind === "prompt") {
        next[lineIdx] = { ...line, answered: true, answer: text };
      }
      return next;
    });
    await sendAnswer(id, text);
  }

  const canRun = status !== "running";

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <button
          onClick={() => setModal({ kind: "init" })}
          disabled={!canRun}
          className="px-3 py-1.5 text-xs font-medium rounded-md bg-zinc-800 text-zinc-200 hover:bg-zinc-700 disabled:opacity-40 transition-colors border border-zinc-700"
        >
          ◎ New Project
        </button>
        <button
          onClick={() => setModal({ kind: "plan" })}
          disabled={!canRun || !isInitialized}
          className="px-3 py-1.5 text-xs font-medium rounded-md bg-zinc-800 text-zinc-200 hover:bg-zinc-700 disabled:opacity-40 transition-colors border border-zinc-700"
        >
          △ Plan Feature
        </button>
        <button
          onClick={() => startOperation("/api/run/implement", {})}
          disabled={!canRun || !isInitialized}
          className="px-3 py-1.5 text-xs font-medium rounded-md bg-zinc-800 text-zinc-200 hover:bg-zinc-700 disabled:opacity-40 transition-colors border border-zinc-700"
        >
          ▶ Implement Tasks
        </button>

        {status === "running" && (
          <button
            onClick={() => { abortRef.current?.abort(); setStatus("idle"); }}
            className="ml-auto px-3 py-1.5 text-xs rounded-md border border-red-800 text-red-400 hover:bg-red-900/30 transition-colors"
          >
            Stop
          </button>
        )}
        {(status === "done" || status === "error") && (
          <button
            onClick={() => { setLines([]); setStatus("idle"); }}
            className="ml-auto px-3 py-1.5 text-xs rounded-md border border-zinc-700 text-zinc-400 hover:bg-zinc-800 transition-colors"
          >
            Clear
          </button>
        )}
      </div>

      {/* Output area */}
      <div className="flex-1 overflow-y-auto bg-zinc-925 rounded-lg border border-zinc-800 p-4 font-mono text-xs space-y-0.5 min-h-64">
        {lines.length === 0 && (
          <p className="text-zinc-600 italic">
            {status === "idle" ? "Use the buttons above to run an operation." : "Starting..."}
          </p>
        )}
        {lines.map((line, i) => (
          <OutputLineView
            key={i}
            line={line}
            lineIdx={i}
            onConfirm={handleConfirm}
            onPromptSubmit={handlePromptSubmit}
          />
        ))}
        {status === "running" && (
          <div className="flex items-center gap-1.5 text-zinc-500 pt-1">
            <span className="w-1.5 h-1.5 bg-zinc-500 rounded-full animate-pulse" />
            <span>running</span>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input modal */}
      {modal && (
        <InputModal
          title={modal.kind === "init" ? "New Project" : "Plan Feature"}
          placeholder={
            modal.kind === "init"
              ? "Describe what you want to build..."
              : "Describe the feature or change..."
          }
          value={inputText}
          onChange={setInputText}
          onSubmit={() => {
            const text = inputText.trim();
            if (!text) return;
            setInputText("");
            setModal(null);
            if (modal.kind === "init") {
              startOperation("/api/run/init", { description: text });
            } else {
              startOperation("/api/run/plan", { feature: text });
            }
          }}
          onCancel={() => { setModal(null); setInputText(""); }}
        />
      )}
    </div>
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
          <p className="text-zinc-200">{line.question}</p>
          {line.answered ? (
            <p className={`text-xs ${line.answer ? "text-emerald-400" : "text-red-400"}`}>
              → {line.answer ? "Approved" : "Declined"}
            </p>
          ) : (
            <div className="flex gap-2">
              <button
                onClick={() => onConfirm(line.id, lineIdx, true)}
                className="px-3 py-1 text-xs rounded bg-emerald-900/50 border border-emerald-700 text-emerald-300 hover:bg-emerald-900 transition-colors"
              >
                Approve
              </button>
              <button
                onClick={() => onConfirm(line.id, lineIdx, false)}
                className="px-3 py-1 text-xs rounded bg-zinc-900 border border-zinc-600 text-zinc-400 hover:bg-zinc-800 transition-colors"
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
          <p className="text-zinc-200">{line.question}</p>
          {line.answered ? (
            <p className="text-xs text-zinc-400 italic">→ {line.answer?.slice(0, 80)}{(line.answer?.length ?? 0) > 80 ? "…" : ""}</p>
          ) : (
            <div className="space-y-2">
              <textarea
                value={promptInput}
                onChange={(e) => setPromptInput(e.target.value)}
                placeholder="Type your answer..."
                rows={3}
                className="w-full bg-zinc-900 border border-zinc-600 rounded px-3 py-2 text-sm text-zinc-200 font-sans focus:outline-none focus:border-zinc-400 resize-none"
              />
              <button
                onClick={() => onPromptSubmit(line.id, lineIdx, promptInput)}
                className="px-3 py-1 text-xs rounded bg-zinc-700 border border-zinc-600 text-zinc-200 hover:bg-zinc-600 transition-colors"
              >
                Submit
              </button>
            </div>
          )}
        </div>
      );

    case "done":
      return (
        <div className={`pt-2 font-semibold ${line.success ? "text-emerald-400" : "text-red-400"}`}>
          {line.success ? "✓ Operation completed successfully." : "✗ Operation finished with errors."}
        </div>
      );

    case "error":
      return <div className="text-red-400 pt-1">Error: {line.message}</div>;

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
