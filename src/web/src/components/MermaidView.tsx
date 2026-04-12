import { useEffect, useRef, useState } from "react";
import mermaid from "mermaid";

mermaid.initialize({
  startOnLoad: false,
  theme: "dark",
  themeVariables: {
    darkMode: true,
    background: "#09090b",
    primaryColor: "#27272a",
    primaryTextColor: "#e4e4e7",
    primaryBorderColor: "#3f3f46",
    lineColor: "#52525b",
    secondaryColor: "#18181b",
    tertiaryColor: "#18181b",
    edgeLabelBackground: "#18181b",
    attributeBackgroundColorOdd: "#18181b",
    attributeBackgroundColorEven: "#27272a",
  },
  er: { diagramPadding: 24, layoutDirection: "TB" },
  flowchart: { padding: 12, curve: "basis" },
  securityLevel: "loose",
});

let counter = 0;

interface MermaidViewProps {
  chart: string;
  className?: string;
}

export function MermaidView({ chart, className = "" }: MermaidViewProps) {
  const id = useRef(`mermaid-${++counter}`);
  const [svg, setSvg] = useState<string>("");
  const [error, setError] = useState<string>("");

  useEffect(() => {
    if (!chart?.trim()) return;
    setError("");
    mermaid
      .render(id.current, chart)
      .then(({ svg }) => {
        setSvg(svg);
        // reset counter id so re-renders get a fresh id
        id.current = `mermaid-${++counter}`;
      })
      .catch((err) => setError(String(err?.message ?? err)));
  }, [chart]);

  if (error) {
    return (
      <div className={`rounded-lg border border-red-900/40 bg-red-950/20 p-4 ${className}`}>
        <p className="text-xs text-red-400 font-mono">{error}</p>
      </div>
    );
  }

  if (!svg) {
    return (
      <div className={`flex items-center justify-center p-8 ${className}`}>
        <div className="w-4 h-4 border-2 border-zinc-700 border-t-zinc-400 rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div
      className={`overflow-auto rounded-lg bg-zinc-950 border border-zinc-800 p-4 ${className}`}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
