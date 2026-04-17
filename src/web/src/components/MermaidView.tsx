import { useEffect, useRef, useState } from "react";
import mermaid from "mermaid";
import { LoadingDots } from "./LoadingDots";
import { looksLikeMermaidErrorSvg, normalizeMermaidChartInput, repairMermaidChart } from "../utils/mermaid";

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
  const lastReportedError = useRef<string>("");
  const [svg, setSvg] = useState<string>("");
  const [error, setError] = useState<string>("");

  useEffect(() => {
    if (!chart?.trim()) {
      setSvg("");
      setError("");
      return;
    }
    const normalizedChart = normalizeMermaidChartInput(chart);
    const repairedChart = repairMermaidChart(normalizedChart);
    const isRepairCandidate = repairedChart !== normalizedChart;
    let canceled = false;
    setSvg("");
    setError("");

    async function render(): Promise<void> {
      const nextId = () => `mermaid-${++counter}`;
      try {
        const firstPass = await mermaid.render(nextId(), normalizedChart);
        if (looksLikeMermaidErrorSvg(firstPass.svg)) {
          throw new Error("Mermaid produced an error diagram");
        }
        if (canceled) return;
        setSvg(firstPass.svg);
        lastReportedError.current = "";
        // Reset counter id so re-renders get a fresh id.
        id.current = nextId();
        return;
      } catch (err) {
        const firstError = String((err as Error)?.message ?? err);
        if (!isRepairCandidate) {
          if (canceled) return;
          setError("Diagram could not be rendered.");
          const signature = `${firstError}|${normalizedChart}`;
          if (lastReportedError.current === signature) return;
          lastReportedError.current = signature;
          void fetch("/api/logs/client", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              component: "mermaid",
              level: "error",
              message: "Mermaid render failed",
              data: {
                error: firstError,
                chartPreview: normalizedChart.slice(0, 800),
                chartLength: normalizedChart.length,
              },
            }),
          }).catch(() => {
            // Ignore diagnostics transport failures in UI rendering path.
          });
          return;
        }

        try {
          const secondPass = await mermaid.render(nextId(), repairedChart);
          if (looksLikeMermaidErrorSvg(secondPass.svg)) {
            throw new Error("Mermaid produced an error diagram after repair");
          }
          if (canceled) return;
          setSvg(secondPass.svg);
          lastReportedError.current = "";
          id.current = nextId();
          void fetch("/api/logs/client", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              component: "mermaid",
              level: "warn",
              message: "Mermaid chart auto-repaired after parse failure",
              data: {
                error: firstError,
                chartPreview: normalizedChart.slice(0, 800),
                repairedPreview: repairedChart.slice(0, 800),
              },
            }),
          }).catch(() => {
            // Ignore diagnostics transport failures in UI rendering path.
          });
        } catch (retryErr) {
          if (canceled) return;
          const retryMessage = String((retryErr as Error)?.message ?? retryErr);
          setError("Diagram could not be rendered.");
          const signature = `${retryMessage}|${normalizedChart}`;
          if (lastReportedError.current === signature) return;
          lastReportedError.current = signature;
          void fetch("/api/logs/client", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              component: "mermaid",
              level: "error",
              message: "Mermaid render failed after auto-repair attempt",
              data: {
                firstError,
                retryError: retryMessage,
                chartPreview: normalizedChart.slice(0, 800),
                repairedPreview: repairedChart.slice(0, 800),
                chartLength: normalizedChart.length,
              },
            }),
          }).catch(() => {
            // Ignore diagnostics transport failures in UI rendering path.
          });
        }
      }
    }

    void render();
    return () => {
      canceled = true;
    };
  }, [chart]);

  if (error) {
    return (
      <div className={`rounded-lg border border-zinc-800 bg-zinc-900/50 p-4 ${className}`}>
        <p className="text-xs text-zinc-500">{error}</p>
      </div>
    );
  }

  if (!svg) {
    return (
      <div className={`flex items-center justify-center p-8 ${className}`}>
        <LoadingDots size={22} />
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
