import { useState } from "react";
import type { OutputLine } from "../../hooks/useOperation";

interface LineProps {
  line: OutputLine;
  lineIdx: number;
  onConfirm: (id: string, idx: number, answer: boolean) => void;
  onPromptSubmit: (id: string, idx: number, text: string) => void;
  interactivePrompts?: boolean;
}

export function OutputLineView({ line, lineIdx, onConfirm, onPromptSubmit, interactivePrompts = true }: LineProps) {
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
      if (!line.done) return null;
      return (
        <div className="flex items-center gap-2 text-zinc-400">
          <span className={line.success ? "text-emerald-400" : "text-red-400"}>{line.success ? "✓" : "✗"}</span>
          <span>{line.text}</span>
        </div>
      );

    case "files":
      return (
        <div className="pt-1 pb-1 space-y-0.5">
          {line.ops.map((op, i) => (
            <div key={i} className="flex items-center gap-2">
              <span className={op.action === "create" ? "text-emerald-400 w-8" : "text-amber-400 w-8"}>
                {op.action.toUpperCase()}
              </span>
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
          ) : !interactivePrompts ? (
            <p className="text-xs text-zinc-500 font-sans">Answer this prompt in the active modal.</p>
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
            <p className="text-xs text-zinc-400 italic font-sans">
              → {line.answer?.slice(0, 80)}{(line.answer?.length ?? 0) > 80 ? "…" : ""}
            </p>
          ) : !interactivePrompts ? (
            <p className="text-xs text-zinc-500 font-sans">Answer this prompt in the active modal.</p>
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
