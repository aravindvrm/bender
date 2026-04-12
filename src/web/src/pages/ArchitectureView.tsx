import type { ProjectState } from "../hooks/useApi";
import { MarkdownView } from "../components/MarkdownView";
import { useState } from "react";

interface ArchitectureViewProps {
  state: ProjectState;
}

type Tab = "overview" | "schema" | "decisions" | "conventions";

export function ArchitectureView({ state }: ArchitectureViewProps) {
  const [activeTab, setActiveTab] = useState<Tab>("overview");

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
        {activeTab === "overview" && state.architecture && (
          <MarkdownView content={state.architecture} />
        )}

        {activeTab === "schema" && state.schema && (
          <div>
            <h2 className="text-lg font-semibold text-zinc-100 mb-4">Database Schema</h2>
            <pre className="bg-zinc-900 border border-zinc-800 rounded-lg p-5 overflow-x-auto">
              <code className="text-sm text-zinc-300 leading-relaxed">{state.schema}</code>
            </pre>
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
