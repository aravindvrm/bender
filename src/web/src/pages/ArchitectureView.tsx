import { useState, useCallback } from "react";
import type { ProjectState } from "../hooks/useApi";
import { MarkdownView } from "../components/MarkdownView";
import { MermaidView } from "../components/MermaidView";
import { sqlToErDiagram } from "../utils/sqlToErDiagram";
import { RefreshCw } from "lucide-react";

interface ArchitectureViewProps {
  state: ProjectState;
}

type Tab = "overview" | "schema" | "flows" | "decisions" | "conventions";

// Extract mermaid code blocks from markdown and render each one
function FlowsContent({ content, onRegenerate, generating }: {
  content: string;
  onRegenerate: () => void;
  generating: boolean;
}) {
  // Split on ## headings to get sections
  const sections = content.split(/(?=^## )/m).filter(Boolean);

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-zinc-100">User Flow Diagrams</h2>
        <button
          onClick={onRegenerate}
          disabled={generating}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-zinc-400 border border-zinc-700 rounded-lg hover:text-zinc-200 hover:border-zinc-500 transition-colors disabled:opacity-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${generating ? "animate-spin" : ""}`} />
          Regenerate
        </button>
      </div>

      {sections.map((section, i) => {
        const headingMatch = section.match(/^## (.+)$/m);
        const heading = headingMatch?.[1] ?? `Flow ${i + 1}`;
        const chartMatch = section.match(/```mermaid\n([\s\S]*?)```/);
        const chart = chartMatch?.[1]?.trim();

        return (
          <div key={i}>
            <h3 className="text-sm font-medium text-zinc-300 mb-3">{heading}</h3>
            {chart ? (
              <MermaidView chart={chart} />
            ) : (
              <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4 text-sm text-zinc-500">
                No diagram found in this section.
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function ArchitectureView({ state }: ArchitectureViewProps) {
  const [activeTab, setActiveTab] = useState<Tab>("overview");
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);

  const erDiagram = state.schema ? sqlToErDiagram(state.schema) : null;

  const generateFlows = useCallback(async () => {
    setGenerating(true);
    setGenError(null);
    try {
      const res = await fetch("/api/run/flows", { method: "POST" });
      if (!res.ok || !res.body) throw new Error("Request failed");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const evt = JSON.parse(line.slice(6));
            if (evt.type === "error") throw new Error(evt.message);
          } catch { /* ignore parse errors */ }
        }
      }
      // Refresh the page state
      window.location.reload();
    } catch (err) {
      setGenError((err as Error).message);
    } finally {
      setGenerating(false);
    }
  }, []);

  if (!state.architecture) {
    return (
      <div className="flex items-center justify-center h-full text-zinc-500">
        <div className="text-center">
          <p className="text-lg">No architecture yet</p>
          <p className="text-sm mt-1">Run <code className="bg-zinc-800 px-2 py-0.5 rounded text-zinc-300">bender init</code></p>
        </div>
      </div>
    );
  }

  const tabs: { id: Tab; label: string; available: boolean }[] = [
    { id: "overview", label: "Architecture", available: !!state.architecture },
    { id: "schema", label: "Schema", available: !!state.schema },
    { id: "flows", label: "Flows", available: true },
    { id: "decisions", label: `Decisions (${state.decisions.length})`, available: state.decisions.length > 0 },
    { id: "conventions", label: "Conventions", available: !!state.conventions },
  ];

  return (
    <div className="max-w-4xl mx-auto">
      {/* Tabs */}
      <div className="flex items-center gap-1 mb-6 border-b border-zinc-800">
        {tabs.filter((t) => t.available).map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`px-4 py-2.5 text-sm transition-colors border-b-2 -mb-px ${
              activeTab === tab.id
                ? "border-zinc-100 text-zinc-100"
                : "border-transparent text-zinc-500 hover:text-zinc-300"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="pb-8">
        {activeTab === "overview" && (
          <MarkdownView content={state.architecture} />
        )}

        {activeTab === "schema" && state.schema && (
          <div className="space-y-6">
            {erDiagram ? (
              <div>
                <h2 className="text-sm font-medium text-zinc-400 uppercase tracking-wide mb-4">Entity Relationship Diagram</h2>
                <MermaidView chart={erDiagram} />
              </div>
            ) : null}
            <div>
              <h2 className="text-sm font-medium text-zinc-400 uppercase tracking-wide mb-3">SQL Source</h2>
              <pre className="bg-zinc-900 border border-zinc-800 rounded-lg p-5 overflow-x-auto">
                <code className="text-sm text-zinc-300 leading-relaxed">{state.schema}</code>
              </pre>
            </div>
          </div>
        )}

        {activeTab === "flows" && (
          <div>
            {state.flows ? (
              <FlowsContent
                content={state.flows}
                onRegenerate={generateFlows}
                generating={generating}
              />
            ) : (
              <div className="flex flex-col items-center justify-center py-20 gap-4">
                <p className="text-zinc-500 text-sm">No flow diagrams generated yet.</p>
                <button
                  onClick={generateFlows}
                  disabled={generating}
                  className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded-lg text-sm text-zinc-200 transition-colors disabled:opacity-50 flex items-center gap-2"
                >
                  <RefreshCw className={`h-4 w-4 ${generating ? "animate-spin" : ""}`} />
                  {generating ? "Generating..." : "Generate Flow Diagrams"}
                </button>
                {genError && <p className="text-sm text-red-400/80">{genError}</p>}
              </div>
            )}
          </div>
        )}

        {activeTab === "decisions" && (
          <div className="space-y-4">
            <h2 className="text-lg font-semibold text-zinc-100">Architecture Decision Records</h2>
            {state.decisions.map((dec) => (
              <div key={dec.name} className="border border-zinc-800 rounded-lg p-5 bg-zinc-900/50">
                <div className="flex items-center gap-2 mb-3">
                  <span className="text-xs font-mono text-zinc-500 bg-zinc-800 px-2 py-0.5 rounded">
                    {dec.name.replace(".md", "")}
                  </span>
                </div>
                <MarkdownView content={dec.content} />
              </div>
            ))}
          </div>
        )}

        {activeTab === "conventions" && state.conventions && (
          <div>
            <h2 className="text-lg font-semibold text-zinc-100 mb-4">Coding Conventions</h2>
            <MarkdownView content={state.conventions} />
          </div>
        )}
      </div>
    </div>
  );
}
