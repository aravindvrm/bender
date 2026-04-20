import { useCallback, useEffect, useRef, useState } from "react";

interface TerminalEntry {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface TerminalPanelProps {
  projectPath: string | null;
}

export function TerminalPanel({ projectPath }: TerminalPanelProps) {
  const [input, setInput] = useState("");
  const [history, setHistory] = useState<TerminalEntry[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [commandHistory, setCommandHistory] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [history]);

  useEffect(() => {
    if (!running) {
      inputRef.current?.focus();
    }
  }, [running]);

  const runCommand = useCallback(async (cmd: string) => {
    const trimmed = cmd.trim();
    if (!trimmed) return;

    setRunning(true);
    setCommandHistory((prev) => [trimmed, ...prev.slice(0, 49)]);
    setHistoryIndex(-1);

    try {
      const res = await fetch("/api/terminal/exec", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: trimmed }),
      });
      const data = await res.json() as { stdout?: string; stderr?: string; exitCode?: number; error?: string };
      if (data.error) {
        setHistory((prev) => [...prev, { command: trimmed, stdout: "", stderr: data.error ?? "", exitCode: 1 }]);
      } else {
        setHistory((prev) => [...prev, {
          command: trimmed,
          stdout: data.stdout ?? "",
          stderr: data.stderr ?? "",
          exitCode: data.exitCode ?? 0,
        }]);
      }
    } catch (err) {
      setHistory((prev) => [...prev, { command: trimmed, stdout: "", stderr: (err as Error).message, exitCode: 1 }]);
    } finally {
      setRunning(false);
    }
  }, []);

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      const cmd = input;
      setInput("");
      void runCommand(cmd);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const next = Math.min(historyIndex + 1, commandHistory.length - 1);
      setHistoryIndex(next);
      if (commandHistory[next]) setInput(commandHistory[next]);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      const next = Math.max(historyIndex - 1, -1);
      setHistoryIndex(next);
      setInput(next === -1 ? "" : (commandHistory[next] ?? ""));
    }
  }

  const cwd = projectPath ? projectPath.split("/").pop() ?? projectPath : "~";

  return (
    <div
      className="h-full overflow-y-auto bg-[#0b0b0d] text-[#d7d7da] font-mono text-[12px] leading-6 p-3"
      onClick={() => inputRef.current?.focus()}
    >
      <div className="space-y-0">
        {history.length === 0 && (
          <p className="text-zinc-600 italic mb-2">Terminal ready. Commands run in project root.</p>
        )}
        {history.map((entry, i) => (
          <div key={i} className="mb-1">
            <div className="flex items-center gap-2 text-zinc-300">
              <span className="text-zinc-500">{cwd}</span>
              <span className="text-zinc-600">$</span>
              <span>{entry.command}</span>
            </div>
            {entry.stdout && (
              <pre className="text-zinc-300 whitespace-pre-wrap leading-relaxed">{entry.stdout}</pre>
            )}
            {entry.stderr && (
              <pre className={`whitespace-pre-wrap leading-relaxed ${entry.exitCode !== 0 ? "text-red-400/90" : "text-zinc-500"}`}>
                {entry.stderr}
              </pre>
            )}
          </div>
        ))}
        {!running && (
          <div className="flex items-center gap-2">
            <span className="text-zinc-500">{cwd}</span>
            <span className="text-zinc-600">$</span>
            <input
              ref={inputRef}
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={!projectPath}
              placeholder={projectPath ? "" : "No project selected"}
              className="flex-1 bg-transparent outline-none text-zinc-200 placeholder:text-zinc-600"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
        )}
        {running && (
          <div className="flex items-center gap-2 text-zinc-500">
            <span className="text-zinc-500">{cwd}</span>
            <span className="text-zinc-600">$</span>
            <span>running…</span>
          </div>
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
