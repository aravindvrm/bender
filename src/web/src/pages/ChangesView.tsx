import { useState, useEffect } from "react";
import type { ProjectState } from "../hooks/useApi";

interface ChangesViewProps {
  state: ProjectState;
}

interface DiffLine {
  type: "header" | "file" | "hunk" | "add" | "remove" | "context" | "meta";
  content: string;
}

function parseDiff(raw: string): DiffLine[] {
  return raw.split("\n").map((line) => {
    if (line.startsWith("diff --git")) return { type: "file", content: line };
    if (line.startsWith("index ") || line.startsWith("--- ") || line.startsWith("+++ ")) return { type: "meta", content: line };
    if (line.startsWith("@@")) return { type: "hunk", content: line };
    if (line.startsWith("+")) return { type: "add", content: line };
    if (line.startsWith("-")) return { type: "remove", content: line };
    return { type: "context", content: line };
  });
}

function extractFileName(line: string): string {
  // "diff --git a/src/foo.ts b/src/foo.ts" -> "src/foo.ts"
  const match = line.match(/diff --git a\/.+ b\/(.+)/);
  return match ? match[1] : line;
}

export function ChangesView({ state }: ChangesViewProps) {
  const [diff, setDiff] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [commits, setCommits] = useState(1);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/git/diff?commits=${commits}`)
      .then((r) => r.json())
      .then((data) => {
        setDiff(data.diff ?? null);
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });
  }, [commits]);

  const recentCommits = state.git?.recentCommits ?? [];

  return (
    <div className="space-y-4">
      {/* Commit selector */}
      {recentCommits.length > 0 && (
        <div className="flex items-center gap-3 flex-wrap">
          <span className="text-xs text-zinc-500">Show diff of last</span>
          {[1, 2, 3, 5].map((n) => (
            <button
              key={n}
              onClick={() => setCommits(n)}
              className={`px-3 py-1 rounded text-xs border transition-colors ${
                commits === n
                  ? "bg-zinc-700 border-zinc-500 text-zinc-100"
                  : "bg-transparent border-zinc-700 text-zinc-500 hover:border-zinc-500 hover:text-zinc-300"
              }`}
            >
              {n} commit{n > 1 ? "s" : ""}
            </button>
          ))}
        </div>
      )}

      {/* Recent commits list */}
      {recentCommits.length > 0 && (
        <div className="space-y-1">
          {recentCommits.slice(0, Math.min(commits + 2, recentCommits.length)).map((c, i) => (
            <div key={c.hash} className={`flex items-center gap-3 px-3 py-2 rounded-md ${i < commits ? "bg-zinc-900" : "bg-transparent opacity-40"}`}>
              <span className="font-mono text-xs text-zinc-500 w-14 shrink-0">{c.hash}</span>
              <span className="text-sm text-zinc-300 truncate">{c.message}</span>
              <span className="ml-auto text-xs text-zinc-600 shrink-0">{new Date(c.date).toLocaleDateString()}</span>
            </div>
          ))}
        </div>
      )}

      <div className="h-px bg-zinc-800" />

      {/* Diff output */}
      {loading && (
        <div className="flex items-center gap-2 text-sm text-zinc-500">
          <div className="w-4 h-4 border-2 border-zinc-700 border-t-zinc-400 rounded-full animate-spin" />
          Loading diff...
        </div>
      )}

      {error && <p className="text-sm text-red-400/80">{error}</p>}

      {!loading && !error && !diff && (
        <p className="text-sm text-zinc-500">No diff available.</p>
      )}

      {!loading && diff && <DiffViewer raw={diff} />}
    </div>
  );
}

function DiffViewer({ raw }: { raw: string }) {
  const lines = parseDiff(raw);

  // Group into file sections
  const sections: { file: string; lines: DiffLine[] }[] = [];
  let current: { file: string; lines: DiffLine[] } | null = null;

  for (const line of lines) {
    if (line.type === "file") {
      if (current) sections.push(current);
      current = { file: extractFileName(line.content), lines: [] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) sections.push(current);

  if (sections.length === 0) {
    return <pre className="text-xs text-zinc-400 font-mono whitespace-pre-wrap">{raw}</pre>;
  }

  return (
    <div className="space-y-4">
      {sections.map((section, i) => (
        <FileDiff key={i} file={section.file} lines={section.lines} />
      ))}
    </div>
  );
}

function FileDiff({ file, lines }: { file: string; lines: DiffLine[] }) {
  const [collapsed, setCollapsed] = useState(false);

  const addCount = lines.filter((l) => l.type === "add").length;
  const removeCount = lines.filter((l) => l.type === "remove").length;

  return (
    <div className="border border-zinc-800 rounded-lg overflow-hidden">
      {/* File header */}
      <button
        onClick={() => setCollapsed((v) => !v)}
        className="w-full flex items-center gap-3 px-4 py-2.5 bg-zinc-900 hover:bg-zinc-800/80 transition-colors text-left"
      >
        <span className="font-mono text-xs text-zinc-300 flex-1 truncate">{file}</span>
        {addCount > 0 && <span className="text-xs text-emerald-500">+{addCount}</span>}
        {removeCount > 0 && <span className="text-xs text-red-400">-{removeCount}</span>}
        <span className="text-zinc-600 text-xs ml-1">{collapsed ? "▶" : "▼"}</span>
      </button>

      {/* Diff lines */}
      {!collapsed && (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-xs font-mono">
            <tbody>
              {lines.map((line, i) => {
                if (line.type === "meta") return null;
                return (
                  <tr
                    key={i}
                    className={
                      line.type === "add"
                        ? "bg-emerald-950/30"
                        : line.type === "remove"
                        ? "bg-red-950/30"
                        : line.type === "hunk"
                        ? "bg-zinc-800/60"
                        : ""
                    }
                  >
                    <td className="pl-4 pr-2 py-0.5 select-none text-zinc-600 whitespace-pre w-4">
                      {line.type === "add" ? "+" : line.type === "remove" ? "-" : line.type === "hunk" ? "" : " "}
                    </td>
                    <td
                      className={`pr-4 py-0.5 whitespace-pre-wrap break-all ${
                        line.type === "add"
                          ? "text-emerald-300"
                          : line.type === "remove"
                          ? "text-red-300"
                          : line.type === "hunk"
                          ? "text-zinc-500"
                          : "text-zinc-400"
                      }`}
                    >
                      {line.type === "add" || line.type === "remove"
                        ? line.content.slice(1)
                        : line.content}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
