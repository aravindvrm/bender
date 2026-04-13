import { useState, useCallback } from "react";
import type { ProjectState } from "../hooks/useApi";
import { MarkdownView } from "../components/MarkdownView";
import { MermaidView } from "../components/MermaidView";
import { sqlToErDiagram } from "../utils/sqlToErDiagram";
import { RefreshCw } from "lucide-react";

interface ArchitectureViewProps {
  state: ProjectState;
}

type Tab = "overview" | "schema" | "api" | "flows" | "decisions" | "conventions";

type StackFieldKey = "framework" | "database" | "orm" | "auth" | "styling" | "language" | "deployment";
interface MarkdownSection {
  heading: string;
  level: number;
  body: string;
}

const STACK_FIELD_LABELS: Record<StackFieldKey, string> = {
  framework: "Framework",
  database: "Database",
  orm: "ORM",
  auth: "Auth",
  styling: "Styling",
  language: "Language",
  deployment: "Deployment",
};

function normalizeStackKey(raw: string): StackFieldKey | null {
  const key = raw.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  if (key === "framework") return "framework";
  if (key === "database") return "database";
  if (key === "orm") return "orm";
  if (key === "auth" || key === "authentication") return "auth";
  if (key === "styling" || key === "styles" || key === "ui") return "styling";
  if (key === "language") return "language";
  if (key === "deployment") return "deployment";
  return null;
}

function parseStackLines(lines: string[]): Partial<Record<StackFieldKey, string>> {
  const parsed: Partial<Record<StackFieldKey, string>> = {};
  for (const line of lines) {
    const cleaned = line.replace(/^[-*]\s+/, "").trim();
    const match = cleaned.match(/^\**([^:*]+?)\**\s*:\s*(.+)$/);
    if (!match) continue;
    const key = normalizeStackKey(match[1]);
    if (!key) continue;
    parsed[key] = match[2].trim();
  }
  return parsed;
}

function extractStackFromArchitecture(content: string): Partial<Record<StackFieldKey, string>> {
  const lines = content.split("\n");
  const headingIndex = lines.findIndex((line) => /^#{1,6}\s*stack\s*$/i.test(line.trim()));
  if (headingIndex >= 0) {
    const section: string[] = [];
    for (let i = headingIndex + 1; i < lines.length; i += 1) {
      const line = lines[i];
      if (/^#{1,6}\s+\S/.test(line.trim())) break;
      section.push(line);
    }
    const parsed = parseStackLines(section);
    if (Object.keys(parsed).length > 0) return parsed;
  }

  const plainIndex = lines.findIndex((line) => /^stack$/i.test(line.trim()));
  if (plainIndex >= 0) {
    const section = lines.slice(plainIndex + 1, plainIndex + 20);
    const parsed = parseStackLines(section);
    if (Object.keys(parsed).length > 0) return parsed;
  }

  return parseStackLines(lines);
}

function isStackValueLine(line: string): boolean {
  const cleaned = line.replace(/^[-*]\s+/, "").trim();
  const match = cleaned.match(/^\**([^:*]+?)\**\s*:\s*(.+)$/);
  if (!match) return false;
  return normalizeStackKey(match[1]) !== null;
}

function normalizeHeadingTitle(heading: string): string {
  return heading.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function parseMarkdownSections(content: string): { preface: string; sections: MarkdownSection[] } {
  const lines = content.split("\n");
  const sections: MarkdownSection[] = [];
  const headingIndexes: Array<{ index: number; level: number; heading: string }> = [];

  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(/^(#{1,6})\s+(.+)$/);
    if (!match) continue;
    headingIndexes.push({ index: i, level: match[1].length, heading: match[2].trim() });
  }

  if (headingIndexes.length === 0) {
    return { preface: content.trim(), sections: [] };
  }

  const preface = lines.slice(0, headingIndexes[0].index).join("\n").trim();

  for (let i = 0; i < headingIndexes.length; i += 1) {
    const current = headingIndexes[i];
    const next = headingIndexes[i + 1];
    const body = lines.slice(current.index + 1, next ? next.index : lines.length).join("\n").trim();
    sections.push({
      heading: current.heading,
      level: current.level,
      body,
    });
  }

  return { preface, sections };
}

function isStackHeading(heading: string): boolean {
  return normalizeHeadingTitle(heading) === "stack";
}

function isSchemaHeading(heading: string): boolean {
  const normalized = normalizeHeadingTitle(heading);
  return normalized === "schema" || normalized === "database schema";
}

function isConventionsHeading(heading: string): boolean {
  const normalized = normalizeHeadingTitle(heading);
  return normalized === "conventions" || normalized === "coding conventions";
}

function isApiHeading(heading: string): boolean {
  const normalized = normalizeHeadingTitle(heading);
  return normalized === "api"
    || normalized.startsWith("api ")
    || normalized.includes(" api")
    || normalized.includes("api contract")
    || normalized === "endpoints"
    || normalized === "routes";
}

function isDesignHeading(heading: string): boolean {
  const normalized = normalizeHeadingTitle(heading);
  return normalized === "design"
    || normalized === "design decisions"
    || normalized === "key design decisions"
    || normalized === "key decisions";
}

function buildOverviewContent(content: string): string {
  const withoutStackLines = content
    .split("\n")
    .filter((line) => !isStackValueLine(line))
    .join("\n")
    .trim();

  const { preface, sections } = parseMarkdownSections(withoutStackLines);
  const designSection = sections.find((section) => isDesignHeading(section.heading));
  const filtered = sections.filter((section) =>
    !isStackHeading(section.heading)
    && !isSchemaHeading(section.heading)
    && !isConventionsHeading(section.heading)
    && !isApiHeading(section.heading)
    && !isDesignHeading(section.heading),
  );

  const blocks: string[] = [];

  if (designSection?.body) {
    blocks.push(`## Design\n\n${designSection.body.trim()}`);
  }

  if (preface) {
    blocks.push(preface);
  }

  for (const section of filtered) {
    if (!section.body.trim()) continue;
    const level = "#".repeat(Math.min(6, Math.max(1, section.level)));
    blocks.push(`${level} ${section.heading}\n\n${section.body.trim()}`);
  }

  return blocks.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
}

function extractApiContent(content: string): string | null {
  const { sections } = parseMarkdownSections(content);
  const apiSection = sections.find((section) => isApiHeading(section.heading) && section.body.trim().length > 0);
  if (!apiSection) return null;
  return apiSection.body.trim();
}

function formatApiContent(content: string): string {
  const trimmed = content.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("#") || trimmed.includes("```")) return trimmed;
  return `\`\`\`yaml\n${trimmed}\n\`\`\``;
}

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
  const parsedStack = extractStackFromArchitecture(state.architecture ?? "");
  const stackRows: Array<{ label: string; value: string }> = [
    {
      label: STACK_FIELD_LABELS.framework,
      value: parsedStack.framework ?? state.config.stack.framework,
    },
    {
      label: STACK_FIELD_LABELS.database,
      value: parsedStack.database ?? state.config.stack.database,
    },
    {
      label: STACK_FIELD_LABELS.orm,
      value: parsedStack.orm ?? state.config.stack.orm,
    },
    {
      label: STACK_FIELD_LABELS.auth,
      value: parsedStack.auth ?? state.config.stack.auth,
    },
    {
      label: STACK_FIELD_LABELS.styling,
      value: parsedStack.styling ?? state.config.stack.styling,
    },
    {
      label: STACK_FIELD_LABELS.language,
      value: parsedStack.language ?? state.config.stack.language,
    },
  ];
  if (parsedStack.deployment) {
    stackRows.push({
      label: STACK_FIELD_LABELS.deployment,
      value: parsedStack.deployment,
    });
  }
  const architectureContent = state.architecture ?? "";
  const overviewContent = buildOverviewContent(architectureContent);
  const apiContent = (() => {
    const direct = state.apiContracts?.trim() ?? "";
    if (direct) return formatApiContent(direct);
    const extracted = extractApiContent(architectureContent);
    return extracted ? formatApiContent(extracted) : "";
  })();

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
    { id: "api", label: "API", available: true },
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
          <div className="space-y-6">
            <section>
              <h2 className="text-sm font-medium text-zinc-400 uppercase tracking-wide mb-3">Stack</h2>
              <div className="grid grid-cols-2 gap-2">
                {stackRows.map((row) => (
                  <div key={row.label} className="flex items-center justify-between px-3 py-2 bg-zinc-900 rounded-md border border-zinc-800">
                    <span className="text-xs text-zinc-500">{row.label}</span>
                    <span className="text-xs text-zinc-300">{row.value}</span>
                  </div>
                ))}
              </div>
            </section>
            <MarkdownView content={overviewContent || state.architecture} />
          </div>
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

        {activeTab === "api" && (
          <div className="space-y-4">
            <h2 className="text-sm font-medium text-zinc-400 uppercase tracking-wide">API Contracts</h2>
            {apiContent ? (
              <MarkdownView content={apiContent} />
            ) : (
              <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4 text-sm text-zinc-500">
                No API contracts found yet.
              </div>
            )}
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
