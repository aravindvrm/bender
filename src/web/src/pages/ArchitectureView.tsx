import { useState, useCallback, useEffect } from "react";
import type { ProjectState } from "../hooks/useApi";
import { MarkdownView } from "../components/MarkdownView";
import { MermaidView } from "../components/MermaidView";
import { LoadingDots } from "../components/LoadingDots";
import { sqlToErDiagram } from "../utils/sqlToErDiagram";
import { RefreshCw, ShieldAlert, TestTube2, AlertTriangle, Info, AlertCircle, CheckCircle2, Plus } from "lucide-react";

interface ArchitectureViewProps {
  state: ProjectState;
  runOperation?: (
    url: string,
    body: Record<string, unknown>,
    options?: { onSuccess?: () => void; onFinish?: (success: boolean) => void },
  ) => void;
}

type Tab = "overview" | "schema" | "api" | "flows" | "decisions" | "conventions" | "security" | "tests";

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

function stripCodeFence(content: string): string {
  return content.replace(/^```[a-z]*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
}

function extractApiContent(content: string): string | null {
  const { sections } = parseMarkdownSections(content);
  const apiSection = sections.find((section) => isApiHeading(section.heading) && section.body.trim().length > 0);
  if (!apiSection) return null;
  return apiSection.body.trim();
}

interface ApiRoute {
  method: string;
  path: string;
  description: string;
}

const METHOD_COLORS: Record<string, string> = {
  GET:    "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
  POST:   "bg-blue-500/15 text-blue-400 border-blue-500/30",
  PUT:    "bg-amber-500/15 text-amber-400 border-amber-500/30",
  PATCH:  "bg-amber-500/15 text-amber-400 border-amber-500/30",
  DELETE: "bg-red-500/15 text-red-400 border-red-500/30",
};

function parseApiRoutes(raw: string): ApiRoute[] {
  const routes: ApiRoute[] = [];
  // Strip outer code fence if present
  const content = raw.startsWith("```") ? stripCodeFence(raw) : raw;

  for (const line of content.split("\n")) {
    // Strip leading list markers and all bold/italic markdown markers
    const cleaned = line.replace(/^[-–*\s]+/, "").replace(/\*\*/g, "").replace(/`/g, "").trim();
    // Match "METHOD /path: description" or "METHOD /path — description" (en/em dash)
    const m = cleaned.match(/^(GET|POST|PUT|PATCH|DELETE)\s+(\/\S*)\s*[:–—-]\s*(.+)$/i);
    if (m) {
      routes.push({ method: m[1].toUpperCase(), path: m[2], description: m[3].trim() });
    }
  }
  return routes;
}

function ApiRoutesView({ content }: { content: string }) {
  const routes = parseApiRoutes(content);

  if (routes.length === 0) {
    // Fall back to MarkdownView for structured content (YAML, OpenAPI, etc.)
    return <MarkdownView content={content} className="overflow-x-auto" />;
  }

  return (
    <div className="border border-zinc-800 rounded-xl overflow-hidden">
      <div className="grid grid-cols-[80px_1fr_2fr] gap-0 px-4 py-2 bg-zinc-900/60 border-b border-zinc-800">
        <span className="text-[11px] font-medium text-zinc-500 uppercase tracking-wider">Method</span>
        <span className="text-[11px] font-medium text-zinc-500 uppercase tracking-wider">Path</span>
        <span className="text-[11px] font-medium text-zinc-500 uppercase tracking-wider">Description</span>
      </div>
      {routes.map((route, i) => (
        <div
          key={i}
          className={`grid grid-cols-[80px_1fr_2fr] gap-0 px-4 py-3 items-start ${
            i < routes.length - 1 ? "border-b border-zinc-800/60" : ""
          } hover:bg-zinc-900/30 transition-colors`}
        >
          <div>
            <span className={`inline-flex items-center px-1.5 py-0.5 rounded border text-[11px] font-mono font-semibold ${METHOD_COLORS[route.method] ?? "bg-zinc-800 text-zinc-400 border-zinc-700"}`}>
              {route.method}
            </span>
          </div>
          <code className="text-xs text-zinc-300 font-mono">{route.path}</code>
          <span className="text-xs text-zinc-400 leading-relaxed">{route.description}</span>
        </div>
      ))}
    </div>
  );
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
          <RefreshCw className="h-3.5 w-3.5" />
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

function CenterLoadingState({ label }: { label: string }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 px-6 py-12 min-h-[240px] overflow-hidden flex flex-col items-center justify-center text-center">
      <LoadingDots size={28} className="justify-center mb-4" />
      <p className="text-sm text-zinc-500">{label}</p>
    </div>
  );
}

// ── Audit types ───────────────────────────────────────────────────────────────

interface AuditIssue {
  id: string;
  title: string;
  severity: "critical" | "high" | "medium" | "low" | "info";
  category: string;
  description: string;
  recommendation: string;
  files?: string[];
}

interface AuditResult {
  type: "security" | "tests";
  runAt: number;
  summary: string;
  coverageEstimate?: string;
  issues: AuditIssue[];
}

const SEVERITY_CONFIG: Record<string, { label: string; classes: string; icon: React.ReactNode }> = {
  critical: { label: "Critical", classes: "bg-red-500/15 text-red-400 border-red-500/30", icon: <AlertCircle className="h-3 w-3" /> },
  high:     { label: "High",     classes: "bg-orange-500/15 text-orange-400 border-orange-500/30", icon: <AlertTriangle className="h-3 w-3" /> },
  medium:   { label: "Medium",   classes: "bg-amber-500/15 text-amber-400 border-amber-500/30", icon: <AlertTriangle className="h-3 w-3" /> },
  low:      { label: "Low",      classes: "bg-blue-500/15 text-blue-400 border-blue-500/30", icon: <Info className="h-3 w-3" /> },
  info:     { label: "Info",     classes: "bg-zinc-500/15 text-zinc-400 border-zinc-500/30", icon: <Info className="h-3 w-3" /> },
};

function SeverityBadge({ severity }: { severity: string }) {
  const cfg = SEVERITY_CONFIG[severity] ?? SEVERITY_CONFIG.info;
  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[11px] font-medium ${cfg.classes}`}>
      {cfg.icon}
      {cfg.label}
    </span>
  );
}

function AuditIssueCard({ issue, onAddAsTask }: { issue: AuditIssue; onAddAsTask: (issue: AuditIssue) => void }) {
  const [expanded, setExpanded] = useState(false);
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  async function handleAdd() {
    setAddError(null);
    setAdding(true);
    try {
      const res = await fetch("/api/tasks/append", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: `Fix: ${issue.title}`,
          description: `**Issue:** ${issue.description}\n\n**Recommendation:** ${issue.recommendation}${issue.files?.length ? `\n\n**Files:** ${issue.files.join(", ")}` : ""}`,
          files: issue.files ?? [],
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error((body as { error?: string }).error ?? "Failed to add task");
      }
      setAdded(true);
      onAddAsTask(issue);
    } catch (err) {
      setAddError((err as Error).message);
    } finally {
      setAdding(false);
    }
  }

  return (
    <div className="border border-zinc-800 rounded-lg bg-zinc-900/50 overflow-hidden">
      <div
        className="flex items-start gap-3 px-4 py-3 cursor-pointer hover:bg-zinc-800/30 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="pt-0.5 shrink-0">
          <SeverityBadge severity={issue.severity} />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm text-zinc-200 font-medium leading-tight">{issue.title}</p>
          {issue.files && issue.files.length > 0 && (
            <p className="text-[11px] text-zinc-500 mt-0.5 truncate">{issue.files.join(", ")}</p>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {added ? (
            <span className="flex items-center gap-1 text-[11px] text-emerald-400">
              <CheckCircle2 className="h-3 w-3" /> Added
            </span>
          ) : (
            <button
              onClick={(e) => { e.stopPropagation(); void handleAdd(); }}
              disabled={adding}
              className="flex items-center gap-1 px-2 py-1 text-[11px] text-zinc-400 border border-zinc-700 rounded hover:text-zinc-200 hover:border-zinc-500 transition-colors disabled:opacity-50"
            >
              <Plus className="h-3 w-3" />
              {adding ? "Adding..." : "Add as task"}
            </button>
          )}
          <span className="text-zinc-600 text-xs">{expanded ? "▲" : "▼"}</span>
        </div>
      </div>
      {expanded && (
        <div className="border-t border-zinc-800 px-4 py-3 space-y-3">
          <div>
            <p className="text-[11px] font-medium text-zinc-500 uppercase tracking-wide mb-1">Description</p>
            <p className="text-sm text-zinc-300 leading-relaxed">{issue.description}</p>
          </div>
          <div>
            <p className="text-[11px] font-medium text-zinc-500 uppercase tracking-wide mb-1">Recommendation</p>
            <p className="text-sm text-zinc-300 leading-relaxed">{issue.recommendation}</p>
          </div>
          {issue.category && (
            <div>
              <span className="text-[11px] font-medium text-zinc-600">Category: </span>
              <span className="text-[11px] text-zinc-500">{issue.category}</span>
            </div>
          )}
          {addError && (
            <p className="text-xs text-red-400">{addError}</p>
          )}
        </div>
      )}
    </div>
  );
}

function AuditTabContent({
  auditType,
  audit,
  running,
  error,
  onRun,
}: {
  auditType: "security" | "tests";
  audit: AuditResult | null;
  running: boolean;
  error: string | null;
  onRun: () => void;
}) {
  const [addedIds, setAddedIds] = useState<Set<string>>(new Set());
  const label = auditType === "security" ? "Security Audit" : "Test Harness Audit";
  const Icon = auditType === "security" ? ShieldAlert : TestTube2;

  const criticalCount = audit?.issues.filter((i) => i.severity === "critical").length ?? 0;
  const highCount = audit?.issues.filter((i) => i.severity === "high").length ?? 0;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Icon className="h-4 w-4 text-zinc-400" />
          <h2 className="text-sm font-medium text-zinc-300">{label}</h2>
          {audit && (
            <span className="text-xs text-zinc-600">
              · {new Date(audit.runAt).toLocaleDateString()}
            </span>
          )}
        </div>
        <button
          onClick={onRun}
          disabled={running}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-zinc-400 border border-zinc-700 rounded-lg hover:text-zinc-200 hover:border-zinc-500 transition-colors disabled:opacity-50"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          {running ? "Analyzing…" : audit ? "Re-run" : "Run audit"}
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-red-800/40 bg-red-900/10 p-3 text-sm text-red-400">{error}</div>
      )}

      {running && (
        <CenterLoadingState label={`Running ${label.toLowerCase()}…`} />
      )}

      {!running && audit && (
        <>
          {audit.summary && (
            <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 px-4 py-3">
              <p className="text-[11px] font-medium text-zinc-500 uppercase tracking-wide mb-1.5">Summary</p>
              <p className="text-sm text-zinc-300 leading-relaxed">{audit.summary}</p>
              {audit.coverageEstimate && (
                <p className="text-xs text-zinc-500 mt-2">Coverage estimate: <span className="text-zinc-300">{audit.coverageEstimate}</span></p>
              )}
            </div>
          )}

          {audit.issues.length > 0 ? (
            <>
              <div className="flex items-center gap-3 text-xs text-zinc-500">
                <span>{audit.issues.length} issue{audit.issues.length !== 1 ? "s" : ""} found</span>
                {criticalCount > 0 && <span className="text-red-400">{criticalCount} critical</span>}
                {highCount > 0 && <span className="text-orange-400">{highCount} high</span>}
              </div>
              <div className="space-y-2">
                {audit.issues.map((issue) => (
                  <AuditIssueCard
                    key={issue.id}
                    issue={issue}
                    onAddAsTask={(i) => setAddedIds((prev) => new Set([...prev, i.id]))}
                  />
                ))}
              </div>
            </>
          ) : (
            <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-6 text-center">
              <CheckCircle2 className="h-6 w-6 text-emerald-400 mx-auto mb-2" />
              <p className="text-sm text-zinc-400">No issues found.</p>
            </div>
          )}
        </>
      )}

      {!running && !audit && !error && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-8 text-center space-y-3">
          <Icon className="h-8 w-8 text-zinc-700 mx-auto" />
          <p className="text-sm text-zinc-500">No {label.toLowerCase()} results yet.</p>
          <p className="text-xs text-zinc-600">Click "Run audit" to analyze the project.</p>
        </div>
      )}
    </div>
  );
}

export function ArchitectureView({ state, runOperation }: ArchitectureViewProps) {
  const [activeTab, setActiveTab] = useState<Tab>("overview");
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);

  // Audit state
  const [securityAudit, setSecurityAudit] = useState<AuditResult | null>(null);
  const [testsAudit, setTestsAudit] = useState<AuditResult | null>(null);
  const [securityRunning, setSecurityRunning] = useState(false);
  const [testsRunning, setTestsRunning] = useState(false);
  const [securityError, setSecurityError] = useState<string | null>(null);
  const [testsError, setTestsError] = useState<string | null>(null);

  // Load existing audit results on mount
  useEffect(() => {
    fetch("/api/audits")
      .then((r) => r.json())
      .then((data: { security?: AuditResult | null; tests?: AuditResult | null }) => {
        if (data.security) setSecurityAudit(data.security);
        if (data.tests) setTestsAudit(data.tests);
      })
      .catch(() => { /* ignore */ });
  }, []);

  const runAudit = useCallback(async (auditType: "security" | "tests") => {
    const setRunning = auditType === "security" ? setSecurityRunning : setTestsRunning;
    const setError = auditType === "security" ? setSecurityError : setTestsError;
    const setAudit = auditType === "security" ? setSecurityAudit : setTestsAudit;

    setRunning(true);
    setError(null);

    if (runOperation) {
      runOperation(`/api/run/audit/${auditType}`, {}, {
        onSuccess: () => {
          fetch("/api/audits")
            .then((r) => r.json())
            .then((audits: { security?: AuditResult; tests?: AuditResult }) => {
              if (audits[auditType]) setAudit(audits[auditType] ?? null);
            })
            .catch((err) => setError((err as Error).message));
        },
        onFinish: (success) => {
          if (!success) setError(`Failed to run ${auditType} audit.`);
          setRunning(false);
        },
      });
      return;
    }

    try {
      const res = await fetch(`/api/run/audit/${auditType}`, { method: "POST" });
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
            const evt = JSON.parse(line.slice(6)) as { type: string; message?: string };
            if (evt.type === "error") throw new Error(evt.message ?? "Audit failed");
          } catch (parseErr) {
            if ((parseErr as Error).message !== "Unexpected token") throw parseErr;
          }
        }
      }

      // Reload audit results
      const audits = await fetch("/api/audits").then((r) => r.json()) as { security?: AuditResult; tests?: AuditResult };
      if (audits[auditType]) setAudit(audits[auditType] ?? null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRunning(false);
    }
  }, [runOperation]);

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
    if (direct) return direct;
    return extractApiContent(architectureContent) ?? "";
  })();

  const generateFlows = useCallback(async () => {
    setGenerating(true);
    setGenError(null);

    if (runOperation) {
      runOperation("/api/run/flows", {}, {
        onSuccess: () => window.location.reload(),
        onFinish: (success) => {
          if (!success) setGenError("Failed to generate flows.");
          setGenerating(false);
        },
      });
      return;
    }

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
  }, [runOperation]);

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

  const securityIssueCount = securityAudit?.issues.length ?? 0;
  const testsIssueCount = testsAudit?.issues.length ?? 0;

  const tabs: { id: Tab; label: string; available: boolean }[] = [
    { id: "overview", label: "Architecture", available: !!state.architecture },
    { id: "schema", label: "Schema", available: !!state.schema },
    { id: "api", label: "API", available: true },
    { id: "flows", label: "Flows", available: true },
    { id: "decisions", label: `Decisions (${state.decisions.length})`, available: state.decisions.length > 0 },
    { id: "conventions", label: "Conventions", available: !!state.conventions },
    { id: "security", label: securityIssueCount > 0 ? `Security (${securityIssueCount})` : "Security", available: true },
    { id: "tests", label: testsIssueCount > 0 ? `Tests (${testsIssueCount})` : "Tests", available: true },
  ];
  const availableTabs = tabs.filter((t) => t.available);

  return (
    <div className="max-w-4xl mx-auto">
      {/* Tabs */}
      <div className="inline-flex border border-zinc-800 overflow-hidden mb-6">
        {availableTabs.map((tab, idx) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`px-4 py-2 text-xs ${activeTab === tab.id ? "bg-zinc-800 text-zinc-100" : "bg-zinc-900 text-zinc-400 hover:text-zinc-200"} ${
              idx > 0 ? "border-l border-zinc-800" : ""
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
                <h2 className="text-xs font-medium text-zinc-500 uppercase tracking-widest mb-4">Entity Relationship Diagram</h2>
                <MermaidView chart={erDiagram} />
              </div>
            ) : null}
            <div>
              <h2 className="text-xs font-medium text-zinc-500 uppercase tracking-widest mb-3">SQL Source</h2>
              <pre className="bg-zinc-900 border border-zinc-800 rounded-lg p-5 overflow-x-auto text-sm leading-relaxed">
                <code className="text-zinc-300">{stripCodeFence(state.schema)}</code>
              </pre>
            </div>
          </div>
        )}

        {activeTab === "api" && (
          <div className="space-y-4">
            <h2 className="text-xs font-medium text-zinc-500 uppercase tracking-widest mb-4">API Contracts</h2>
            {apiContent ? (
              <ApiRoutesView content={apiContent} />
            ) : (
              <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4 text-sm text-zinc-500">
                No API contracts found yet.
              </div>
            )}
          </div>
        )}

        {activeTab === "flows" && (
          <div>
            {generating ? (
              <CenterLoadingState label="Generating flow diagrams…" />
            ) : state.flows ? (
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
                  <RefreshCw className="h-4 w-4" />
                  Generate Flow Diagrams
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
            <h2 className="text-xs font-medium text-zinc-500 uppercase tracking-widest mb-5">Coding Conventions</h2>
            <MarkdownView content={stripCodeFence(state.conventions)} />
          </div>
        )}

        {activeTab === "security" && (
          <AuditTabContent
            auditType="security"
            audit={securityAudit}
            running={securityRunning}
            error={securityError}
            onRun={() => { void runAudit("security"); }}
          />
        )}

        {activeTab === "tests" && (
          <AuditTabContent
            auditType="tests"
            audit={testsAudit}
            running={testsRunning}
            error={testsError}
            onRun={() => { void runAudit("tests"); }}
          />
        )}
      </div>
    </div>
  );
}
