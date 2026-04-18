import { useState } from "react";

interface DiffLine {
  type: "file" | "hunk" | "add" | "remove" | "context" | "meta";
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
  const match = line.match(/diff --git a\/.+ b\/(.+)/);
  return match ? match[1] : line;
}

export function GitDiffViewer({ raw }: { raw: string }) {
  const lines = parseDiff(raw);
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
      <button
        onClick={() => setCollapsed((v) => !v)}
        className="w-full flex items-center gap-3 px-4 py-2.5 bg-zinc-900 hover:bg-zinc-800/80 transition-colors text-left"
      >
        <span className="font-mono text-xs text-zinc-300 flex-1 truncate">{file}</span>
        {addCount > 0 && <span className="text-xs text-emerald-500">+{addCount}</span>}
        {removeCount > 0 && <span className="text-xs text-red-400">-{removeCount}</span>}
        <span className="text-zinc-600 text-xs ml-1">{collapsed ? "▶" : "▼"}</span>
      </button>

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
                      {line.type === "add" || line.type === "remove" ? line.content.slice(1) : line.content}
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
