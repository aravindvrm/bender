import type { ProjectState } from "../hooks/useApi";
import { MarkdownView } from "../components/MarkdownView";

interface BriefViewProps {
  state: ProjectState;
}

/** Strip leading/trailing markdown code fences (LLMs sometimes wrap output in ```markdown). */
function stripCodeFence(content: string): string {
  return content.replace(/^```[a-z]*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
}

/** Try several section heading patterns to find a features list. */
function extractFeatureLines(brief: string, patterns: RegExp[]): string[] {
  for (const pattern of patterns) {
    const match = brief.match(pattern);
    if (match?.[1]) {
      const lines = match[1].match(/^[-*]?\s*\d*\.?\s*.+$/gm) ?? [];
      if (lines.length > 0) return lines;
    }
  }
  return [];
}

/** Parse a feature list item into name + optional description, stripping markdown formatting. */
function parseFeatureLine(line: string): { name: string; desc: string } {
  // Strip leading list markers and numbering
  let cleaned = line.replace(/^[-*]\s+/, "").replace(/^\d+\.\s*/, "").trim();
  // Strip bold markers
  cleaned = cleaned.replace(/\*\*/g, "");
  // Split on " — ", " – ", ": " (colon-space after a word boundary)
  const separatorMatch = cleaned.match(/^(.+?)(?:\s[—–]\s|:\s)(.+)$/);
  if (separatorMatch) {
    return { name: separatorMatch[1].trim(), desc: separatorMatch[2].trim() };
  }
  return { name: cleaned, desc: "" };
}

const CORE_PATTERNS = [
  /##\s*Core Features.*?\n([\s\S]*?)(?=\n##)/,
  /##\s*Current Features.*?\n([\s\S]*?)(?=\n##)/,
  /##\s*Features\b.*?\n([\s\S]*?)(?=\n##)/,
];

const DEFERRED_PATTERNS = [
  /##\s*Deferred Features.*?\n([\s\S]*?)(?=\n##)/,
  /##\s*Deferred\b.*?\n([\s\S]*?)(?=\n##)/,
  /##\s*Future Features.*?\n([\s\S]*?)(?=\n##)/,
  /##\s*Planned Features.*?\n([\s\S]*?)(?=\n##)/,
];

export function BriefView({ state }: BriefViewProps) {
  if (!state.brief) {
    return (
      <div className="flex items-center justify-center min-h-[320px]">
        <div className="text-center max-w-xs space-y-3">
          <div className="mx-auto w-10 h-10 rounded-xl bg-zinc-900 border border-zinc-800 flex items-center justify-center mb-3">
            <svg className="w-4.5 h-4.5 text-zinc-600" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
            </svg>
          </div>
          <p className="text-[13px] font-medium text-zinc-300">No project brief yet</p>
          <p className="text-xs text-zinc-500 leading-relaxed">
            Run <code className="bg-zinc-800/80 px-1.5 py-0.5 rounded text-zinc-300 text-[11px]">bender analyze</code> or use the scan icon in the left rail to generate your project brief and architecture.
          </p>
        </div>
      </div>
    );
  }

  const brief = stripCodeFence(state.brief);
  const featureLines = extractFeatureLines(brief, CORE_PATTERNS);
  const deferredLines = extractFeatureLines(brief, DEFERRED_PATTERNS);

  return (
    <div className="max-w-4xl mx-auto space-y-8 w-full overflow-x-hidden">

      {/* Feature summary cards */}
      {featureLines.length > 0 && (
        <section>
          <h2 className="text-xs font-medium text-zinc-500 mb-3 uppercase tracking-widest">Core Features</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {featureLines.map((line, i) => {
              const { name, desc } = parseFeatureLine(line);
              return (
                <div key={i} className="border border-zinc-800 rounded-lg p-3 bg-zinc-900/40">
                  <div className="flex items-start gap-2">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0 mt-1.5" />
                    <div className="min-w-0">
                      <span className="text-sm text-zinc-200 font-medium">{name}</span>
                      {desc && <p className="text-xs text-zinc-500 mt-0.5">{desc}</p>}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {deferredLines.length > 0 && (
        <section>
          <h2 className="text-xs font-medium text-zinc-500 mb-3 uppercase tracking-widest">Deferred</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {deferredLines.map((line, i) => {
              const { name, desc } = parseFeatureLine(line);
              return (
                <div key={i} className="border border-zinc-800/40 rounded-lg p-3 bg-zinc-900/20">
                  <div className="flex items-start gap-2">
                    <span className="w-1.5 h-1.5 rounded-full bg-zinc-700 shrink-0 mt-1.5" />
                    <div className="min-w-0">
                      <span className="text-sm text-zinc-500">{name}</span>
                      {desc && <p className="text-xs text-zinc-600 mt-0.5">{desc}</p>}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Full brief */}
      <section className="border-t border-zinc-800/60 pt-6">
        <h2 className="text-xs font-medium text-zinc-500 mb-4 uppercase tracking-widest">Full Brief</h2>
        <MarkdownView content={brief} className="overflow-x-auto" />
      </section>
    </div>
  );
}
