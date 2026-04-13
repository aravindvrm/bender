import type { ProjectState } from "../hooks/useApi";
import { MarkdownView } from "../components/MarkdownView";
import { Sparkles } from "lucide-react";

interface BriefViewProps {
  state: ProjectState;
  onPlanFeature: () => void;
}

export function BriefView({ state, onPlanFeature }: BriefViewProps) {
  if (!state.brief) {
    return (
      <div className="flex items-center justify-center h-full text-zinc-500">
        <div className="text-center">
          <p className="text-lg">No product brief</p>
          <p className="text-sm mt-1">Run <code className="bg-zinc-800 px-2 py-0.5 rounded text-zinc-300">bender init</code></p>
        </div>
      </div>
    );
  }

  // Extract features from brief
  const coreFeatures = state.brief.match(/## Core Features.*?\n([\s\S]*?)(?=\n##)/);
  const deferredFeatures = state.brief.match(/## Deferred Features.*?\n([\s\S]*?)(?=\n##)/);
  const featureLines = coreFeatures?.[1]?.match(/^\d+\..+$/gm) ?? [];
  const deferredLines = deferredFeatures?.[1]?.match(/^\d+\..+$/gm) ?? [];

  return (
    <div className="max-w-4xl mx-auto">
      {/* Action bar */}
      <div className="flex items-center justify-end mb-6">
        <button
          onClick={onPlanFeature}
          className="flex items-center gap-2 px-4 py-2 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded-lg text-sm text-zinc-200 transition-colors"
        >
          <Sparkles className="h-4 w-4 text-zinc-400" />
          New Task
        </button>
      </div>

      {/* Feature summary cards */}
      {featureLines.length > 0 && (
        <div className="mb-8">
          <h2 className="text-sm font-medium text-zinc-400 mb-3 uppercase tracking-wider">Core Features</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {featureLines.map((line, i) => {
              const cleaned = line.replace(/^\d+\.\s*/, "");
              const [name, desc] = cleaned.split(" — ");
              return (
                <div key={i} className="border border-zinc-800 rounded-lg p-3 bg-zinc-900/50">
                  <div className="flex items-center gap-2">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" />
                    <span className="text-sm text-zinc-200 font-medium">{name}</span>
                  </div>
                  {desc && <p className="text-xs text-zinc-500 mt-1 ml-4">{desc}</p>}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {deferredLines.length > 0 && (
        <div className="mb-8">
          <h2 className="text-sm font-medium text-zinc-400 mb-3 uppercase tracking-wider">Deferred</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {deferredLines.map((line, i) => {
              const cleaned = line.replace(/^\d+\.\s*/, "");
              const [name, desc] = cleaned.split(" — ");
              return (
                <div key={i} className="border border-zinc-800/50 rounded-lg p-3 bg-zinc-900/20">
                  <div className="flex items-center gap-2">
                    <span className="w-1.5 h-1.5 rounded-full bg-zinc-600 shrink-0" />
                    <span className="text-sm text-zinc-500">{name}</span>
                  </div>
                  {desc && <p className="text-xs text-zinc-600 mt-1 ml-4">{desc}</p>}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Full brief */}
      <div className="border-t border-zinc-800 pt-6">
        <h2 className="text-sm font-medium text-zinc-400 mb-4 uppercase tracking-wider">Full Brief</h2>
        <MarkdownView content={state.brief} />
      </div>
    </div>
  );
}
