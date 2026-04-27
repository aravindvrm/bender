import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, Copy, Pencil, Play, Plus, Trash2 } from "lucide-react";
import { LoadingDots } from "../components/LoadingDots";
import { CreateEvalConfigModal } from "../components/drawer/CreateEvalConfigModal";
import type { ProjectState } from "../hooks/useApi";
import { roleLabel, type BaseRole } from "../lib/roleLabels";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ModelTier = "fast" | "default" | "strong";
type EvalRunStatus = "queued" | "running" | "succeeded" | "failed";
type EvalSuccessMode = "response-only" | "diff-generated" | "build-verified" | "test-verified";

interface EvalConfig {
  id: string;
  name: string;
  role: BaseRole;
  enabled: boolean;
  successMode?: EvalSuccessMode;
  modelTier?: ModelTier;
  provider?: string;
  model?: string;
  pinnedSkills?: string[];
  mcpServerIds?: string[];
}

interface SkillMeta {
  name: string;
  description: string;
  size: number;
  source?: "curated" | "user" | "project";
}

interface McpConnector {
  id: string;
  name: string;
  url: string;
  description: string;
  enabled: boolean;
  configured: boolean;
}

interface LlmStatus {
  hasAnyKey: boolean;
  activeProvider: string;
  providers: Record<string, { configured: boolean }>;
}

interface EvalSuite {
  id: string;
  name: string;
  taskIds: string[];
}

interface EvalUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

interface EvalTaskRun {
  id: string;
  taskId: string;
  configId: string;
  provider: string;
  model: string;
  status: EvalRunStatus;
  success: boolean;
  output: string;
  durationMs: number;
  usage?: EvalUsage;
  estimatedCostUsd?: number | null;
  error?: string;
  trace: Record<string, unknown>;
  assertionSummary?: EvalAssertionSummary;
  assertions?: EvalAssertionResult[];
  promptfoo?: Record<string, unknown>;
}

interface EvalAssertionSummary {
  total: number;
  passed: number;
  failed: number;
  score: number | null;
  reason?: string;
}

interface EvalAssertionResult {
  id: string;
  type: string;
  metric?: string;
  pass: boolean;
  score?: number | null;
  reason?: string;
  raw?: Record<string, unknown> | null;
}

interface EvalCompareRunSummary {
  id: string;
  taskId: string;
  status: EvalRunStatus;
  createdAt: number;
}

interface EvalSuiteConfigAggregate {
  configId: string;
  tasksAttempted: number;
  tasksSucceeded: number;
  successRate: number;
  totalLatencyMs: number;
  medianLatencyMs: number;
  totalEstimatedCostUsd: number | null;
  totalTokenUsage: number | null;
}

interface EvalSuiteRun {
  id: string;
  suiteId: string;
  status: EvalRunStatus;
  createdAt: number;
  ranking: EvalSuiteConfigAggregate[];
}

interface ParsedPlanTask {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
}

interface EvalsViewProps {
  state: ProjectState;
  onNewTask: () => void;
  runOperation?: (
    url: string,
    body: Record<string, unknown>,
    options?: { onSuccess?: () => void; onFinish?: (success: boolean) => void },
  ) => void;
}

// ---------------------------------------------------------------------------
// Constants + helpers
// ---------------------------------------------------------------------------

const ROLE_DOT: Record<BaseRole, string> = {
  analyzer: "bg-blue-400",
  architect: "bg-violet-400",
  planner: "bg-amber-400",
  implementer: "bg-emerald-400",
  reviewer: "bg-rose-400",
};

const TIER_BADGE: Record<ModelTier, string> = {
  fast: "text-sky-300 bg-sky-950/40 border-sky-900/40",
  default: "text-zinc-400 bg-zinc-800 border-zinc-700",
  strong: "text-violet-300 bg-violet-950/40 border-violet-900/40",
};

function fmtMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function fmtTokens(usage?: EvalUsage): string {
  if (!usage) return "—";
  const total = usage.totalTokens ?? ((usage.inputTokens ?? 0) + (usage.outputTokens ?? 0));
  return total > 0 ? total.toLocaleString() : "—";
}

function fmtCost(value?: number | null): string {
  if (typeof value !== "number") return "—";
  if (value === 0) return "$0";
  return `$${value.toFixed(4)}`;
}

function parsePlanTasks(state: ProjectState): ParsedPlanTask[] {
  if (state.currentTaskPlan?.tasks?.length) {
    return state.currentTaskPlan.tasks.map((task) => ({
      id: task.id,
      title: task.title,
      description: task.description,
      acceptanceCriteria: Array.isArray(task.acceptanceCriteria) ? task.acceptanceCriteria : [],
    }));
  }
  const markdown = state.currentTasks;
  if (!markdown) return [];
  const tasks: ParsedPlanTask[] = [];
  const pattern = /###\s*Task\s*([^:\n]+):\s*(.+?)\n([\s\S]*?)(?=\n###\s*Task|\n##\s|$)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(markdown)) !== null) {
    const body = match[3];
    const rawId = match[1].trim();
    const normalizedId = /^task-\d+$/i.test(rawId)
      ? rawId.toLowerCase()
      : /^\d+$/.test(rawId)
        ? `task-${rawId}`
        : "";
    if (!normalizedId) continue;
    const descMatch = body.match(/\*\*Description\*\*:\s*([\s\S]*?)(?=\n-\s*\*\*|\n###|$)/);
    const criteriaSection = body.match(
      /\*\*Acceptance criteria\*\*:\s*([\s\S]*?)(?=\n-\s*\*\*|\n###|$)/,
    );
    const acceptanceCriteria = (criteriaSection?.[1] ?? "")
      .split("\n")
      .map((line) => line.trim().replace(/^[-*]\s+/, "").trim())
      .filter(Boolean);
    tasks.push({
      id: normalizedId,
      title: match[2].trim(),
      description: descMatch?.[1]?.trim() ?? "",
      acceptanceCriteria:
        acceptanceCriteria.length > 0 ? acceptanceCriteria : ["Task implemented and verified."],
    });
  }
  return tasks;
}

function evalTaskIdForPlanTask(taskId: string): string {
  return `plan-task-${taskId}`;
}

function planTaskIdFromEvalTaskId(evalTaskId: string): string | null {
  const prefix = "plan-task-";
  return evalTaskId.startsWith(prefix) ? evalTaskId.slice(prefix.length) || null : null;
}

function evalTaskPromptFromPlanTask(task: ParsedPlanTask): string {
  const criteria =
    task.acceptanceCriteria.length > 0
      ? task.acceptanceCriteria.map((e) => `- ${e}`).join("\n")
      : "- Task implemented and verified.";
  return [
    `Implement Task ${task.id}: ${task.title}`,
    "",
    "Description:",
    task.description || "No description provided.",
    "",
    "Acceptance criteria:",
    criteria,
  ].join("\n");
}

// Winner = index of the best value (returns -1 if < 2 valid values)
function findWinner(
  values: (number | null)[],
  higherIsBetter: boolean,
): number {
  const valid = values.map((v, i) => ({ v, i })).filter((x) => x.v !== null);
  if (valid.length < 2) return -1;
  return (higherIsBetter
    ? valid.reduce((best, cur) => (cur.v! > best.v! ? cur : best))
    : valid.reduce((best, cur) => (cur.v! < best.v! ? cur : best))
  ).i;
}

// ---------------------------------------------------------------------------
// Config chip
// ---------------------------------------------------------------------------

function ConfigChip({
  config,
  onEdit,
  onDuplicate,
  onDelete,
}: {
  config: EvalConfig;
  onEdit: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const tier = config.modelTier ?? "default";
  return (
    <div className="group relative flex items-center gap-2 pl-2.5 pr-1.5 py-1.5 rounded-lg border border-zinc-800 bg-zinc-900/60 text-xs hover:border-zinc-700 transition-colors">
      <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${ROLE_DOT[config.role]}`} />
      <span className="text-zinc-200 font-medium max-w-[120px] truncate">{config.name}</span>
      <span className="text-[10px] text-zinc-500">{roleLabel(config.role)}</span>
      <span
        className={`text-[10px] px-1 py-0 rounded border font-medium ${TIER_BADGE[tier]}`}
      >
        {tier}
      </span>
      {(config.provider || config.model) && (
        <span className="text-[10px] text-zinc-600 font-mono max-w-[100px] truncate">
          {config.provider || "default"}/{config.model || "—"}
        </span>
      )}
      {!!config.pinnedSkills?.length && (
        <span className="text-[10px] text-zinc-600">⊞{config.pinnedSkills.length}</span>
      )}
      {/* Hover actions */}
      <div className="flex items-center gap-0 opacity-0 group-hover:opacity-100 transition-opacity ml-0.5 border-l border-zinc-800 pl-1">
        <button
          type="button"
          onClick={onEdit}
          title="Edit"
          className="p-1 text-zinc-600 hover:text-zinc-300 transition-colors rounded"
        >
          <Pencil className="h-2.5 w-2.5" />
        </button>
        <button
          type="button"
          onClick={onDuplicate}
          title="Duplicate"
          className="p-1 text-zinc-600 hover:text-zinc-300 transition-colors rounded"
        >
          <Copy className="h-2.5 w-2.5" />
        </button>
        <button
          type="button"
          onClick={onDelete}
          title="Delete"
          className="p-1 text-zinc-600 hover:text-rose-400 transition-colors rounded"
        >
          <Trash2 className="h-2.5 w-2.5" />
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// History tab strip
// ---------------------------------------------------------------------------

type HistoryItem =
  | { key: string; kind: "compare"; run: EvalCompareRunSummary; label: string }
  | { key: string; kind: "suite"; run: EvalSuiteRun; label: string };

function statusDot(status: EvalRunStatus): { color: string; pulse: boolean } {
  if (status === "running" || status === "queued")
    return { color: "bg-amber-400", pulse: true };
  if (status === "succeeded") return { color: "bg-emerald-400", pulse: false };
  return { color: "bg-rose-400", pulse: false };
}

function HistoryTabStrip({
  items,
  activeKey,
  onSelect,
}: {
  items: HistoryItem[];
  activeKey: string | null;
  onSelect: (key: string) => void;
}) {
  if (items.length === 0) return null;

  return (
    <div className="flex gap-1.5 overflow-x-auto pb-0.5 scrollbar-hide">
      {items.map((item) => {
        const dot = statusDot(item.run.status);
        const active = activeKey === item.key;
        return (
          <button
            key={item.key}
            type="button"
            onClick={() => onSelect(item.key)}
            className={`flex-shrink-0 flex items-center gap-2 px-3 py-2 rounded-lg text-xs transition-colors border
              ${
                active
                  ? "bg-zinc-800 border-zinc-600 text-zinc-100"
                  : "bg-zinc-900/40 border-zinc-800 text-zinc-400 hover:text-zinc-200 hover:border-zinc-700"
              }`}
          >
            <span
              className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${dot.color} ${dot.pulse ? "animate-pulse" : ""}`}
            />
            <span className="max-w-[180px] truncate">{item.label}</span>
            <span className="text-[10px] text-zinc-600 flex-shrink-0">
              {item.kind === "suite" ? "suite" : "task"}
            </span>
            <span className="text-[10px] text-zinc-700 flex-shrink-0">
              {new Date(item.run.createdAt).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </span>
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Detail drawer (expands below a matrix column)
// ---------------------------------------------------------------------------

function DetailDrawer({ run }: { run: EvalTaskRun }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 p-4 bg-zinc-950/60 border-t border-zinc-800">
      {/* Output */}
      <div className="space-y-2">
        <p className="text-[11px] uppercase tracking-wide text-zinc-500">Output</p>
        {run.error && !run.success ? (
          <p className="text-xs text-rose-400 bg-rose-950/20 border border-rose-900/30 rounded-lg px-3 py-2">
            {run.error}
          </p>
        ) : null}
        <pre className="text-xs text-zinc-300 whitespace-pre-wrap break-words max-h-56 overflow-auto rounded-lg border border-zinc-800 bg-zinc-950 p-3 leading-relaxed">
          {run.output || "No output."}
        </pre>
        <div className="flex gap-2">
          <details className="flex-1">
            <summary className="text-[11px] text-zinc-600 cursor-pointer hover:text-zinc-400 transition-colors select-none">
              Promptfoo details
            </summary>
            <pre className="mt-2 text-[11px] text-zinc-400 whitespace-pre-wrap break-words max-h-40 overflow-auto rounded-lg border border-zinc-800 bg-zinc-950 p-3">
              {JSON.stringify(run.promptfoo ?? {}, null, 2)}
            </pre>
          </details>
          <details className="flex-1">
            <summary className="text-[11px] text-zinc-600 cursor-pointer hover:text-zinc-400 transition-colors select-none">
              Trace
            </summary>
            <pre className="mt-2 text-[11px] text-zinc-400 whitespace-pre-wrap break-words max-h-40 overflow-auto rounded-lg border border-zinc-800 bg-zinc-950 p-3">
              {JSON.stringify(run.trace, null, 2)}
            </pre>
          </details>
        </div>
      </div>

      {/* Assertions */}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <p className="text-[11px] uppercase tracking-wide text-zinc-500">Assertions</p>
          {run.assertionSummary && (
            <span className="text-[10px] text-zinc-600">
              {run.assertionSummary.passed}/{run.assertionSummary.total} passed
              {typeof run.assertionSummary.score === "number"
                ? ` · score ${run.assertionSummary.score.toFixed(3)}`
                : ""}
            </span>
          )}
        </div>
        {!run.assertions?.length ? (
          <p className="text-xs text-zinc-600">No assertion data.</p>
        ) : (
          <div className="space-y-1.5">
            {run.assertions.map((a) => (
              <div
                key={a.id}
                className={`rounded-lg border px-3 py-2 text-xs space-y-1 ${
                  a.pass
                    ? "border-emerald-900/40 bg-emerald-950/20"
                    : "border-rose-900/40 bg-rose-950/20"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-zinc-300 font-medium">{a.metric ?? a.type}</span>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    {typeof a.score === "number" && (
                      <span className="text-[10px] font-mono text-zinc-500">
                        {a.score.toFixed(2)}
                      </span>
                    )}
                    <span
                      className={`text-[10px] font-medium ${a.pass ? "text-emerald-400" : "text-rose-400"}`}
                    >
                      {a.pass ? "pass" : "fail"}
                    </span>
                  </div>
                </div>
                {a.reason && <p className="text-[11px] text-zinc-500 leading-relaxed">{a.reason}</p>}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Comparison matrix (single-task compare)
// ---------------------------------------------------------------------------

function ComparisonMatrix({
  runs,
  configById,
}: {
  runs: EvalTaskRun[];
  configById: Map<string, EvalConfig>;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const sorted = useMemo(
    () =>
      [...runs].sort((a, b) => {
        const na = configById.get(a.configId)?.name ?? a.configId;
        const nb = configById.get(b.configId)?.name ?? b.configId;
        return na.localeCompare(nb);
      }),
    [runs, configById],
  );

  // Metric arrays (null = not available / failed)
  const successOnly = (r: EvalTaskRun) => (r.success ? r : null);

  const scoreVals = sorted.map((r) => (successOnly(r) ? (r.assertionSummary?.score ?? null) : null));
  const durationVals = sorted.map((r) => (r.durationMs > 0 ? r.durationMs : null));
  const tokenVals = sorted.map((r) => {
    const u = r.usage;
    if (!u) return null;
    const t = u.totalTokens ?? ((u.inputTokens ?? 0) + (u.outputTokens ?? 0));
    return t > 0 ? t : null;
  });
  const costVals = sorted.map((r) =>
    typeof r.estimatedCostUsd === "number" ? r.estimatedCostUsd : null,
  );
  const assertVals = sorted.map((r) =>
    r.assertionSummary
      ? r.assertionSummary.passed / Math.max(r.assertionSummary.total, 1)
      : null,
  );

  const wScore = findWinner(scoreVals, true);
  const wDuration = findWinner(durationVals, false);
  const wTokens = findWinner(tokenVals, false);
  const wCost = findWinner(costVals, false);
  const wAssert = findWinner(assertVals, true);

  function winClass(idx: number, winnerIdx: number): string {
    return idx === winnerIdx && winnerIdx !== -1 ? "text-emerald-300" : "text-zinc-300";
  }

  const expandedRun = sorted.find((r) => r.id === expandedId);

  return (
    <div className="rounded-xl border border-zinc-800 overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full min-w-max">
          {/* Column headers */}
          <thead>
            <tr className="border-b border-zinc-800 bg-zinc-950/40">
              <th className="w-28 px-4 py-3 text-left" />
              {sorted.map((run) => {
                const config = configById.get(run.configId);
                const isExpanded = expandedId === run.id;
                return (
                  <th
                    key={run.id}
                    className={`px-4 py-3 text-left min-w-[180px] border-l border-zinc-800 ${isExpanded ? "bg-zinc-800/50" : ""}`}
                  >
                    <button
                      type="button"
                      onClick={() => setExpandedId(isExpanded ? null : run.id)}
                      className="text-left w-full group"
                    >
                      <div className="flex items-center gap-1.5">
                        <span
                          className={`w-2 h-2 rounded-full flex-shrink-0 ${run.success ? "bg-emerald-400" : run.status === "running" ? "bg-amber-400 animate-pulse" : "bg-rose-400"}`}
                        />
                        <span className="text-xs font-medium text-zinc-200 truncate max-w-[140px]">
                          {config?.name ?? run.configId}
                        </span>
                      </div>
                      <p className="text-[11px] text-zinc-500 font-mono mt-0.5 truncate max-w-[200px]">
                        {run.provider}/{run.model}
                      </p>
                      <p
                        className={`text-[10px] mt-0.5 transition-colors ${isExpanded ? "text-zinc-400" : "text-zinc-700 group-hover:text-zinc-500"}`}
                      >
                        {isExpanded ? "▲ collapse" : "▼ details"}
                      </p>
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>

          <tbody>
            {/* Success */}
            <tr className="border-b border-zinc-800/60">
              <td className="px-4 py-2.5 text-[11px] text-zinc-500 uppercase tracking-wide">
                Success
              </td>
              {sorted.map((run) => (
                <td key={run.id} className="px-4 py-2.5 border-l border-zinc-800/40">
                  {run.status === "running" || run.status === "queued" ? (
                    <span className="text-[11px] text-amber-400">{run.status}…</span>
                  ) : run.success ? (
                    <span className="text-[11px] text-emerald-400">✓ pass</span>
                  ) : (
                    <span className="text-[11px] text-rose-400">✗ fail</span>
                  )}
                </td>
              ))}
            </tr>

            {/* Score */}
            <tr className="border-b border-zinc-800/60">
              <td className="px-4 py-2.5 text-[11px] text-zinc-500 uppercase tracking-wide">
                Score
              </td>
              {sorted.map((run, i) => {
                const score = scoreVals[i];
                return (
                  <td
                    key={run.id}
                    className={`px-4 py-2.5 border-l border-zinc-800/40 ${winClass(i, wScore)}`}
                  >
                    {score !== null ? (
                      <div className="flex items-center gap-2">
                        <div className="w-16 h-1 rounded-full bg-zinc-800 overflow-hidden flex-shrink-0">
                          <div
                            className={`h-full rounded-full ${i === wScore ? "bg-emerald-400" : "bg-zinc-500"}`}
                            style={{ width: `${Math.max(0, Math.min(1, score)) * 100}%` }}
                          />
                        </div>
                        <span className="text-[11px] font-mono">{score.toFixed(3)}</span>
                        {i === wScore && <span className="text-[10px] text-amber-300">★</span>}
                      </div>
                    ) : (
                      <span className="text-[11px] text-zinc-600">—</span>
                    )}
                  </td>
                );
              })}
            </tr>

            {/* Duration */}
            <tr className="border-b border-zinc-800/60">
              <td className="px-4 py-2.5 text-[11px] text-zinc-500 uppercase tracking-wide">
                Duration
              </td>
              {sorted.map((run, i) => (
                <td
                  key={run.id}
                  className={`px-4 py-2.5 border-l border-zinc-800/40 text-[11px] font-mono ${winClass(i, wDuration)}`}
                >
                  {fmtMs(run.durationMs)}
                  {i === wDuration && (
                    <span className="ml-1 text-[10px] text-amber-300">★</span>
                  )}
                </td>
              ))}
            </tr>

            {/* Tokens */}
            <tr className="border-b border-zinc-800/60">
              <td className="px-4 py-2.5 text-[11px] text-zinc-500 uppercase tracking-wide">
                Tokens
              </td>
              {sorted.map((run, i) => {
                const t = tokenVals[i];
                return (
                  <td
                    key={run.id}
                    className={`px-4 py-2.5 border-l border-zinc-800/40 text-[11px] font-mono ${winClass(i, wTokens)}`}
                  >
                    {t !== null ? (
                      <>
                        {t.toLocaleString()}
                        {i === wTokens && (
                          <span className="ml-1 text-[10px] text-amber-300">★</span>
                        )}
                      </>
                    ) : (
                      "—"
                    )}
                  </td>
                );
              })}
            </tr>

            {/* Cost */}
            <tr className="border-b border-zinc-800/60">
              <td className="px-4 py-2.5 text-[11px] text-zinc-500 uppercase tracking-wide">
                Cost
              </td>
              {sorted.map((run, i) => (
                <td
                  key={run.id}
                  className={`px-4 py-2.5 border-l border-zinc-800/40 text-[11px] font-mono ${winClass(i, wCost)}`}
                >
                  {fmtCost(run.estimatedCostUsd)}
                  {i === wCost && costVals[i] !== null && (
                    <span className="ml-1 text-[10px] text-amber-300">★</span>
                  )}
                </td>
              ))}
            </tr>

            {/* Assertions */}
            <tr>
              <td className="px-4 py-2.5 text-[11px] text-zinc-500 uppercase tracking-wide">
                Assertions
              </td>
              {sorted.map((run, i) => {
                const s = run.assertionSummary;
                return (
                  <td
                    key={run.id}
                    className={`px-4 py-2.5 border-l border-zinc-800/40 text-[11px] ${winClass(i, wAssert)}`}
                  >
                    {s ? (
                      <>
                        {s.passed}/{s.total}
                        {i === wAssert && (
                          <span className="ml-1 text-[10px] text-amber-300">★</span>
                        )}
                      </>
                    ) : (
                      <span className="text-zinc-600">—</span>
                    )}
                  </td>
                );
              })}
            </tr>

            {/* Detail row */}
            {expandedRun && (
              <tr>
                <td colSpan={sorted.length + 1} className="p-0">
                  <DetailDrawer run={expandedRun} />
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Suite run matrix (configs ranked by aggregate metrics)
// ---------------------------------------------------------------------------

function SuiteMatrix({
  suiteRun,
  taskRuns,
  configById,
  planTaskById,
}: {
  suiteRun: EvalSuiteRun;
  taskRuns: EvalTaskRun[];
  configById: Map<string, EvalConfig>;
  planTaskById: Map<string, ParsedPlanTask>;
}) {
  const ranking = [...suiteRun.ranking].sort((a, b) => b.successRate - a.successRate);
  const configs = ranking.map((r) => r.configId);

  // Build task × config matrix from taskRuns
  const cellMap = useMemo(() => {
    const m = new Map<string, EvalTaskRun>(); // key = `${taskId}:${configId}`
    for (const run of taskRuns) {
      m.set(`${run.taskId}:${run.configId}`, run);
    }
    return m;
  }, [taskRuns]);

  const taskIds = useMemo(() => {
    const ids = new Set<string>();
    for (const run of taskRuns) ids.add(run.taskId);
    return [...ids];
  }, [taskRuns]);

  const wSuccessRate = findWinner(
    ranking.map((r) => r.successRate),
    true,
  );
  const wLatency = findWinner(
    ranking.map((r) => r.medianLatencyMs),
    false,
  );
  const wCost = findWinner(
    ranking.map((r) => r.totalEstimatedCostUsd ?? null),
    false,
  );

  return (
    <div className="space-y-4">
      {/* Ranking table */}
      <div className="rounded-xl border border-zinc-800 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-max">
            <thead>
              <tr className="border-b border-zinc-800 bg-zinc-950/40">
                <th className="w-28 px-4 py-3 text-left" />
                {ranking.map((row) => (
                  <th
                    key={row.configId}
                    className="px-4 py-3 text-left min-w-[160px] border-l border-zinc-800"
                  >
                    <p className="text-xs font-medium text-zinc-200 truncate max-w-[140px]">
                      {configById.get(row.configId)?.name ?? row.configId}
                    </p>
                    <p className="text-[11px] text-zinc-600 font-mono mt-0.5 truncate max-w-[160px]">
                      {configById.get(row.configId)?.provider ?? "—"}/
                      {configById.get(row.configId)?.model ?? "—"}
                    </p>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-zinc-800/60">
                <td className="px-4 py-2.5 text-[11px] text-zinc-500 uppercase tracking-wide">
                  Success rate
                </td>
                {ranking.map((row, i) => (
                  <td
                    key={row.configId}
                    className={`px-4 py-2.5 border-l border-zinc-800/40 text-[11px] ${i === wSuccessRate ? "text-emerald-300" : "text-zinc-300"}`}
                  >
                    <div className="flex items-center gap-2">
                      <div className="w-14 h-1 rounded-full bg-zinc-800 overflow-hidden flex-shrink-0">
                        <div
                          className={`h-full rounded-full ${i === wSuccessRate ? "bg-emerald-400" : "bg-zinc-500"}`}
                          style={{ width: `${row.successRate * 100}%` }}
                        />
                      </div>
                      <span className="font-mono">
                        {(row.successRate * 100).toFixed(0)}%
                      </span>
                      <span className="text-zinc-600">
                        ({row.tasksSucceeded}/{row.tasksAttempted})
                      </span>
                      {i === wSuccessRate && (
                        <span className="text-[10px] text-amber-300">★</span>
                      )}
                    </div>
                  </td>
                ))}
              </tr>
              <tr className="border-b border-zinc-800/60">
                <td className="px-4 py-2.5 text-[11px] text-zinc-500 uppercase tracking-wide">
                  Median latency
                </td>
                {ranking.map((row, i) => (
                  <td
                    key={row.configId}
                    className={`px-4 py-2.5 border-l border-zinc-800/40 text-[11px] font-mono ${i === wLatency ? "text-emerald-300" : "text-zinc-300"}`}
                  >
                    {fmtMs(row.medianLatencyMs)}
                    {i === wLatency && (
                      <span className="ml-1 text-[10px] text-amber-300">★</span>
                    )}
                  </td>
                ))}
              </tr>
              <tr className="border-b border-zinc-800/60">
                <td className="px-4 py-2.5 text-[11px] text-zinc-500 uppercase tracking-wide">
                  Total tokens
                </td>
                {ranking.map((row) => (
                  <td
                    key={row.configId}
                    className="px-4 py-2.5 border-l border-zinc-800/40 text-[11px] font-mono text-zinc-300"
                  >
                    {row.totalTokenUsage != null ? row.totalTokenUsage.toLocaleString() : "—"}
                  </td>
                ))}
              </tr>
              <tr>
                <td className="px-4 py-2.5 text-[11px] text-zinc-500 uppercase tracking-wide">
                  Total cost
                </td>
                {ranking.map((row, i) => (
                  <td
                    key={row.configId}
                    className={`px-4 py-2.5 border-l border-zinc-800/40 text-[11px] font-mono ${i === wCost ? "text-emerald-300" : "text-zinc-300"}`}
                  >
                    {fmtCost(row.totalEstimatedCostUsd)}
                    {i === wCost && row.totalEstimatedCostUsd !== null && (
                      <span className="ml-1 text-[10px] text-amber-300">★</span>
                    )}
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* Per-task breakdown */}
      {taskIds.length > 0 && (
        <details>
          <summary className="text-xs text-zinc-500 cursor-pointer hover:text-zinc-300 transition-colors select-none px-1">
            Per-task breakdown ({taskIds.length} tasks)
          </summary>
          <div className="mt-2 rounded-xl border border-zinc-800 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full min-w-max">
                <thead>
                  <tr className="border-b border-zinc-800 bg-zinc-950/40">
                    <th className="px-4 py-2 text-left text-[11px] text-zinc-500 uppercase tracking-wide">
                      Task
                    </th>
                    {configs.map((cid) => (
                      <th
                        key={cid}
                        className="px-4 py-2 text-left text-[11px] text-zinc-500 border-l border-zinc-800 min-w-[120px] truncate max-w-[140px]"
                      >
                        {configById.get(cid)?.name ?? cid}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {taskIds.map((taskId) => {
                    const planId = planTaskIdFromEvalTaskId(taskId);
                    const planTask = planId ? planTaskById.get(planId) : null;
                    return (
                      <tr key={taskId} className="border-b border-zinc-800/60 last:border-b-0">
                        <td className="px-4 py-2 text-xs text-zinc-400 max-w-[200px] truncate">
                          {planTask ? `${planTask.id}: ${planTask.title}` : taskId}
                        </td>
                        {configs.map((cid) => {
                          const run = cellMap.get(`${taskId}:${cid}`);
                          return (
                            <td
                              key={cid}
                              className="px-4 py-2 border-l border-zinc-800/40 text-[11px]"
                            >
                              {!run ? (
                                <span className="text-zinc-700">—</span>
                              ) : run.success ? (
                                <span className="text-emerald-400">✓</span>
                              ) : (
                                <span className="text-rose-400">✗</span>
                              )}
                              {run?.assertionSummary?.score != null && (
                                <span className="ml-1.5 text-zinc-500 font-mono">
                                  {run.assertionSummary.score.toFixed(2)}
                                </span>
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </details>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main view
// ---------------------------------------------------------------------------

export function EvalsView({ state, onNewTask, runOperation }: EvalsViewProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const [configs, setConfigs] = useState<EvalConfig[]>([]);
  const [suites, setSuites] = useState<EvalSuite[]>([]);
  const [compareRuns, setCompareRuns] = useState<EvalCompareRunSummary[]>([]);
  const [suiteRuns, setSuiteRuns] = useState<EvalSuiteRun[]>([]);
  const [skills, setSkills] = useState<SkillMeta[]>([]);
  const [connectors, setConnectors] = useState<McpConnector[]>([]);
  const [llmStatus, setLlmStatus] = useState<LlmStatus | null>(null);

  // Run selections
  const [selectedConfigIds, setSelectedConfigIds] = useState<Set<string>>(new Set());
  const [selectedPlanTaskId, setSelectedPlanTaskId] = useState<string>("");
  const [selectedSuiteId, setSelectedSuiteId] = useState<string>("");

  // Suite creation
  const [newSuiteName, setNewSuiteName] = useState("");
  const [showSuiteForm, setShowSuiteForm] = useState(false);

  // History / results
  const [activeHistoryKey, setActiveHistoryKey] = useState<string | null>(null);
  const [activeCompareRun, setActiveCompareRun] = useState<{
    summary: EvalCompareRunSummary;
    runs: EvalTaskRun[];
  } | null>(null);
  const [activeSuiteRun, setActiveSuiteRun] = useState<{
    suiteRun: EvalSuiteRun;
    taskRuns: EvalTaskRun[];
  } | null>(null);

  // Config modal
  const [showConfigModal, setShowConfigModal] = useState(false);
  const [editingConfig, setEditingConfig] = useState<EvalConfig | null>(null);

  const planTasks = useMemo(() => parsePlanTasks(state), [state]);
  const planTaskById = useMemo(() => new Map(planTasks.map((t) => [t.id, t])), [planTasks]);
  const configById = useMemo(() => new Map(configs.map((c) => [c.id, c])), [configs]);
  const suiteNameById = useMemo(() => new Map(suites.map((s) => [s.id, s.name])), [suites]);

  // Unified history: merge compare + suite runs sorted by createdAt desc
  const historyItems = useMemo((): HistoryItem[] => {
    const compareItems: HistoryItem[] = compareRuns.map((run) => {
      const pid = planTaskIdFromEvalTaskId(run.taskId);
      const task = pid ? planTaskById.get(pid) : null;
      return {
        key: `compare:${run.id}`,
        kind: "compare" as const,
        run,
        label: task ? `${task.id}: ${task.title}` : run.taskId,
      };
    });
    const suiteItems: HistoryItem[] = suiteRuns.map((run) => ({
      key: `suite:${run.id}`,
      kind: "suite" as const,
      run,
      label: suiteNameById.get(run.suiteId) ?? run.suiteId,
    }));
    return [...compareItems, ...suiteItems]
      .sort((a, b) => b.run.createdAt - a.run.createdAt)
      .slice(0, 30);
  }, [compareRuns, suiteRuns, planTaskById, suiteNameById]);

  const canCompare =
    selectedConfigIds.size >= 2 && !!selectedPlanTaskId;
  const canRunSuite = selectedConfigIds.size >= 2 && !!selectedSuiteId;
  const canSaveSuite = !!newSuiteName.trim() && !!selectedPlanTaskId;

  // ── Data loading ──────────────────────────────────────────────────────────

  const loadSkillsCatalog = useCallback(async (): Promise<SkillMeta[]> => {
    try {
      const res = await fetch("/api/skills/catalog");
      const body = (await res.json()) as { skills?: SkillMeta[] };
      if (res.ok && Array.isArray(body.skills)) return body.skills;
    } catch { /* fall through */ }
    try {
      const res = await fetch("/api/skills/registry");
      const body = (await res.json()) as { skills?: SkillMeta[] };
      return Array.isArray(body.skills) ? body.skills : [];
    } catch { return []; }
  }, []);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [configsRes, suitesRes, compareRunsRes, suiteRunsRes, skillsCatalog, connectorsRes, llmRes] =
        await Promise.all([
          fetch("/api/evals/configs"),
          fetch("/api/evals/suites"),
          fetch("/api/evals/runs/compare?limit=30"),
          fetch("/api/evals/runs/suites?limit=30"),
          loadSkillsCatalog(),
          fetch("/api/mcp/connectors"),
          fetch("/api/llm/status"),
        ]);
      if (!configsRes.ok || !suitesRes.ok || !compareRunsRes.ok || !suiteRunsRes.ok) {
        throw new Error("Failed to load eval state");
      }
      const [c, s, cr, sr] = await Promise.all([
        configsRes.json() as Promise<{ configs: EvalConfig[] }>,
        suitesRes.json() as Promise<{ suites: EvalSuite[] }>,
        compareRunsRes.json() as Promise<{ runs: EvalCompareRunSummary[] }>,
        suiteRunsRes.json() as Promise<{ runs: EvalSuiteRun[] }>,
      ]);
      setConfigs(c.configs);
      setSuites(s.suites);
      setCompareRuns(cr.runs);
      setSuiteRuns(sr.runs);
      setSkills(skillsCatalog);
      if (connectorsRes.ok) {
        const b = (await connectorsRes.json()) as { connectors?: McpConnector[] };
        setConnectors(Array.isArray(b.connectors) ? b.connectors : []);
      }
      if (llmRes.ok) {
        setLlmStatus((await llmRes.json()) as LlmStatus);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [loadSkillsCatalog]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  // Auto-select first plan task
  useEffect(() => {
    if (!selectedPlanTaskId && planTasks.length > 0) {
      setSelectedPlanTaskId(planTasks[0].id);
    }
  }, [planTasks, selectedPlanTaskId]);

  // ── History selection ─────────────────────────────────────────────────────

  const handleHistorySelect = useCallback(
    async (key: string) => {
      setActiveHistoryKey(key);
      setActiveCompareRun(null);
      setActiveSuiteRun(null);
      const [kind, id] = key.split(":");
      try {
        if (kind === "compare") {
          const res = await fetch(`/api/evals/runs/compare/${encodeURIComponent(id)}`);
          if (!res.ok) throw new Error("Failed to load compare run");
          const json = (await res.json()) as {
            summary: EvalCompareRunSummary;
            runs: EvalTaskRun[];
          };
          setActiveCompareRun(json);
        } else {
          const res = await fetch(`/api/evals/runs/suites/${encodeURIComponent(id)}`);
          if (!res.ok) throw new Error("Failed to load suite run");
          const json = (await res.json()) as {
            suiteRun: EvalSuiteRun;
            taskRuns: EvalTaskRun[];
          };
          setActiveSuiteRun(json);
        }
      } catch (err) {
        setMessage((err as Error).message);
      }
    },
    [],
  );

  // ── Actions ───────────────────────────────────────────────────────────────

  async function upsertEvalTaskFromPlan(task: ParsedPlanTask): Promise<string> {
    const evalTaskId = evalTaskIdForPlanTask(task.id);
    const res = await fetch("/api/evals/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: evalTaskId,
        name: `Task ${task.id}: ${task.title}`,
        prompt: evalTaskPromptFromPlanTask(task),
      }),
    });
    if (!res.ok) {
      const b = await res.json().catch(() => ({ error: "Failed to sync eval task." }));
      throw new Error((b as { error?: string }).error ?? "Failed to sync eval task.");
    }
    return evalTaskId;
  }

  async function runCompare() {
    setMessage(null);
    if (!canCompare) return;
    const task = planTaskById.get(selectedPlanTaskId);
    if (!task) return;
    const evalTaskId = await upsertEvalTaskFromPlan(task);
    const body = { taskId: evalTaskId, configIds: [...selectedConfigIds] };
    if (runOperation) {
      runOperation("/api/run/evals/compare", body, { onSuccess: () => void loadData() });
      return;
    }
    await fetch("/api/run/evals/compare", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    await loadData();
  }

  function runSuite() {
    setMessage(null);
    if (!canRunSuite) return;
    const body = { configIds: [...selectedConfigIds] };
    const doRun = () =>
      fetch(`/api/run/evals/suites/${encodeURIComponent(selectedSuiteId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).then(() => loadData());
    if (runOperation) {
      runOperation(
        `/api/run/evals/suites/${encodeURIComponent(selectedSuiteId)}`,
        body,
        { onSuccess: () => void loadData() },
      );
      return;
    }
    void doRun();
  }

  async function saveAsSuite() {
    setMessage(null);
    if (!newSuiteName.trim() || !selectedPlanTaskId) return;
    const task = planTaskById.get(selectedPlanTaskId);
    if (!task) return;
    const evalTaskId = await upsertEvalTaskFromPlan(task);
    const res = await fetch("/api/evals/suites", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newSuiteName.trim(), taskIds: [evalTaskId] }),
    });
    if (!res.ok) {
      setMessage("Failed to save suite.");
      return;
    }
    setNewSuiteName("");
    setShowSuiteForm(false);
    setMessage("Suite saved.");
    await loadData();
  }

  async function deleteSuite(suiteId: string) {
    const res = await fetch(`/api/evals/suites/${encodeURIComponent(suiteId)}`, {
      method: "DELETE",
    });
    if (res.ok) await loadData();
  }

  async function duplicateConfig(configId: string) {
    const source = configById.get(configId);
    if (!source) return;
    const payload = {
      name: `${source.name} copy`,
      role: source.role,
      successMode: source.successMode ?? "diff-generated",
      modelTier: source.modelTier ?? "default",
      provider: source.provider,
      model: source.model,
      pinnedSkills: source.pinnedSkills ?? [],
      mcpServerIds: source.mcpServerIds ?? [],
      enabled: source.enabled,
    };
    const res = await fetch("/api/evals/configs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (res.ok) {
      setMessage("Config duplicated.");
      await loadData();
    }
  }

  async function deleteConfig(configId: string) {
    if (!window.confirm("Delete this config?")) return;
    const res = await fetch(`/api/evals/configs/${encodeURIComponent(configId)}`, {
      method: "DELETE",
    });
    if (res.ok) {
      setSelectedConfigIds((prev) => {
        const next = new Set(prev);
        next.delete(configId);
        return next;
      });
      await loadData();
    }
  }

  // ── Loading ───────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <LoadingDots size={28} />
      </div>
    );
  }

  if (error) {
    return <p className="text-sm text-red-400 py-4">{error}</p>;
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="max-w-6xl space-y-5">
      {/* Header */}
      <div className="flex items-center gap-3">
        <h3 className="text-sm font-semibold text-zinc-300">Evals</h3>
        <p className="text-xs text-zinc-600">
          Compare models, configs, and skill combinations on your actual tasks. Powered by promptfoo.
        </p>
      </div>

      {message && (
        <p className="text-xs px-3 py-2 rounded-lg border border-zinc-800 bg-zinc-900/40 text-zinc-400">
          {message}
        </p>
      )}

      {/* ── Section 1: Configs ── */}
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <span className="text-[11px] uppercase tracking-wider text-zinc-500">
            Configs
          </span>
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400">
            {configs.length}
          </span>
          <p className="text-xs text-zinc-600 ml-1">
            Each config is one comparison row — a model × role × skill setup.
          </p>
          <button
            type="button"
            onClick={() => {
              setEditingConfig(null);
              setShowConfigModal(true);
            }}
            className="ml-auto flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-zinc-700 text-[11px] text-zinc-300 hover:border-zinc-500 hover:text-zinc-100 transition-colors"
          >
            <Plus className="h-3 w-3" />
            Add Config
          </button>
        </div>

        {configs.length === 0 ? (
          <p className="text-xs text-zinc-600">
            No configs yet.{" "}
            <button
              type="button"
              onClick={() => { setEditingConfig(null); setShowConfigModal(true); }}
              className="text-zinc-400 underline underline-offset-2 hover:text-zinc-200 transition-colors"
            >
              Add one
            </button>{" "}
            to start comparing.
          </p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {configs.map((config) => (
              <ConfigChip
                key={config.id}
                config={config}
                onEdit={() => {
                  setEditingConfig(config);
                  setShowConfigModal(true);
                }}
                onDuplicate={() => void duplicateConfig(config.id)}
                onDelete={() => void deleteConfig(config.id)}
              />
            ))}
          </div>
        )}
      </section>

      {/* ── Section 2: Run control ── */}
      <section className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-4 space-y-4">
        <p className="text-[11px] uppercase tracking-wider text-zinc-500">Run</p>

        {/* Config toggle pills */}
        <div className="space-y-1.5">
          <p className="text-xs text-zinc-500">
            Select configs to compare{" "}
            <span
              className={`${selectedConfigIds.size < 2 ? "text-amber-400" : "text-zinc-600"}`}
            >
              ({selectedConfigIds.size} selected, need 2+)
            </span>
          </p>
          {configs.length === 0 ? (
            <p className="text-xs text-zinc-600">No configs yet.</p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {configs.map((config) => {
                const active = selectedConfigIds.has(config.id);
                return (
                  <button
                    key={config.id}
                    type="button"
                    onClick={() => {
                      setSelectedConfigIds((prev) => {
                        const next = new Set(prev);
                        if (next.has(config.id)) next.delete(config.id);
                        else next.add(config.id);
                        return next;
                      });
                    }}
                    className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-xs transition-colors
                      ${active
                        ? "border-zinc-600 bg-zinc-800 text-zinc-100"
                        : "border-zinc-800 text-zinc-500 hover:border-zinc-700 hover:text-zinc-300"
                      }`}
                  >
                    <span
                      className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${ROLE_DOT[config.role]} ${!active ? "opacity-40" : ""}`}
                    />
                    {config.name}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Task compare row */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <select
              value={selectedPlanTaskId}
              onChange={(e) => setSelectedPlanTaskId(e.target.value)}
              className="select-flat pl-3 pr-8 py-1.5 text-xs"
            >
              <option value="">— select task —</option>
              {planTasks.map((t) => (
                <option key={t.id} value={t.id}>
                  Task {t.id}: {t.title}
                </option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 h-3 w-3 text-zinc-500" />
          </div>
          <button
            type="button"
            onClick={() => void runCompare()}
            disabled={!canCompare}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-zinc-100 text-zinc-900 hover:bg-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            <Play className="h-3 w-3" />
            Compare
          </button>
          <button
            type="button"
            onClick={onNewTask}
            className="px-2.5 py-1.5 rounded-lg text-[11px] border border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:border-zinc-500 transition-colors"
          >
            + New task
          </button>
        </div>

        {/* Suites row */}
        <div className="pt-2 border-t border-zinc-800 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-[11px] text-zinc-500 flex-shrink-0">Suites</p>
            {suites.map((suite) => (
              <div
                key={suite.id}
                className={`flex items-center gap-1.5 px-2 py-1 rounded-lg border text-xs transition-colors cursor-pointer
                  ${selectedSuiteId === suite.id
                    ? "border-zinc-600 bg-zinc-800 text-zinc-100"
                    : "border-zinc-800 text-zinc-500 hover:border-zinc-700 hover:text-zinc-300"
                  }`}
                onClick={() =>
                  setSelectedSuiteId((prev) => (prev === suite.id ? "" : suite.id))
                }
              >
                <span>{suite.name}</span>
                <span className="text-[10px] text-zinc-600">{suite.taskIds.length}t</span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    void deleteSuite(suite.id);
                  }}
                  className="text-zinc-700 hover:text-rose-400 transition-colors ml-0.5"
                  title="Delete suite"
                >
                  ×
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={runSuite}
              disabled={!canRunSuite}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs border border-zinc-700 text-zinc-300 hover:border-zinc-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              <Play className="h-3 w-3" />
              Run suite
            </button>
            <button
              type="button"
              onClick={() => setShowSuiteForm((p) => !p)}
              className="text-[11px] text-zinc-600 hover:text-zinc-400 transition-colors"
            >
              {showSuiteForm ? "Cancel" : "+ Save as suite"}
            </button>
          </div>
          {showSuiteForm && (
            <div className="flex items-center gap-2">
              <input
                autoFocus
                value={newSuiteName}
                onChange={(e) => setNewSuiteName(e.target.value)}
                placeholder="Suite name"
                onKeyDown={(e) => {
                  if (e.key === "Enter") void saveAsSuite();
                  if (e.key === "Escape") setShowSuiteForm(false);
                }}
                className="bg-zinc-950/50 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-600 w-48"
              />
              <button
                type="button"
                onClick={() => void saveAsSuite()}
                disabled={!canSaveSuite}
                className="px-2.5 py-1.5 rounded-lg text-xs border border-zinc-700 text-zinc-300 hover:border-zinc-500 disabled:opacity-40 transition-colors"
              >
                Save
              </button>
            </div>
          )}
        </div>
      </section>

      {/* ── Section 3: Results ── */}
      <section className="space-y-3">
        <p className="text-[11px] uppercase tracking-wider text-zinc-500">Results</p>

        {historyItems.length === 0 ? (
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/20 py-16 flex items-center justify-center">
            <p className="text-sm text-zinc-600">
              Run a comparison to see results here.
            </p>
          </div>
        ) : (
          <>
            <HistoryTabStrip
              items={historyItems}
              activeKey={activeHistoryKey}
              onSelect={handleHistorySelect}
            />

            {activeHistoryKey === null && (
              <div className="rounded-xl border border-zinc-800 bg-zinc-900/20 py-12 flex items-center justify-center">
                <p className="text-sm text-zinc-600">
                  Select a run above to inspect results.
                </p>
              </div>
            )}

            {activeCompareRun && (
              <ComparisonMatrix
                runs={activeCompareRun.runs}
                configById={configById}
              />
            )}

            {activeSuiteRun && (
              <SuiteMatrix
                suiteRun={activeSuiteRun.suiteRun}
                taskRuns={activeSuiteRun.taskRuns}
                configById={configById}
                planTaskById={planTaskById}
              />
            )}
          </>
        )}
      </section>

      {/* ── Config modal ── */}
      {showConfigModal && (
        <CreateEvalConfigModal
          existingConfig={editingConfig}
          skills={skills}
          connectors={connectors}
          llmStatus={llmStatus}
          onClose={() => {
            setShowConfigModal(false);
            setEditingConfig(null);
          }}
          onSaved={() => {
            setShowConfigModal(false);
            setEditingConfig(null);
            void loadData();
          }}
        />
      )}
    </div>
  );
}
