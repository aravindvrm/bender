import { useState, useEffect, useMemo } from "react";
import type { ProjectState } from "../hooks/useApi";
import type { OperationStatus } from "../hooks/useOperation";
import { ProjectSelector } from "./ProjectSelector";
import { LoadingDots } from "./LoadingDots";
import {
  FileText,
  CirclePlus,
  FolderTree,
  GitBranch,
  MonitorCog,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
  Bot,
  Zap,
  Beaker,
  type LucideIcon,
} from "lucide-react";

export type View = "plan" | "workflows" | "architecture" | "brief" | "evals" | "agents" | "settings";

export function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(n);
}

function displayProviderName(provider?: string): string {
  const p = (provider ?? "").trim().toLowerCase();
  if (!p) return "—";
  if (p === "openai") return "OpenAI";
  if (p === "anthropic") return "Anthropic";
  if (p === "google") return "Google";
  if (p === "groq") return "Groq";
  if (p === "ollama") return "Ollama";
  if (p === "local") return "Local";
  return provider ?? "—";
}

/** Shorten a long model name to its most recognisable segment.
 *  e.g. "devstral-small-2-24b-instruct-2512" → "devstral-small-2-24b"
 *  e.g. "claude-sonnet-4-5-20250930" → "claude-sonnet-4-5"
 */
export function shortenModelName(name: string): string {
  if (!name || name === "—") return name;
  // Strip trailing date-like or build suffixes (e.g. -20250930, -2512, -instruct-2512)
  const stripped = name
    .replace(/-\d{8}$/, "")       // -20251231 trailing date
    .replace(/-\d{4}$/, "")       // -2512 build suffix
    .replace(/-instruct(-\d+)?$/, "") // -instruct or -instruct-2512
    .replace(/-preview$/, "");    // -preview suffix
  return stripped || name;
}

function resolveTierProvider(
  value: string | { provider: string; model: string } | undefined,
  fallback: string,
): string {
  if (typeof value === "string") return fallback;
  const provider = value?.provider?.trim();
  return provider || fallback;
}

function resolveTierModel(
  value: string | { provider: string; model: string } | undefined,
): string {
  if (typeof value === "string") return value.trim() || "—";
  return value?.model?.trim() || "—";
}

function llmProviderLabel(llm: ProjectState["config"]["llm"] | null | undefined): string {
  if (!llm) return "—";
  const fallback = llm.provider;
  const providers = new Set([
    resolveTierProvider(llm.models.fast, fallback),
    resolveTierProvider(llm.models.default, fallback),
    resolveTierProvider(llm.models.strong, fallback),
  ].filter(Boolean));
  if (providers.size > 1) return "Mixed";
  return displayProviderName([...providers][0] ?? fallback);
}

interface TokenStats {
  inputTokens: number;
  outputTokens: number;
}

interface SessionUsageResponse {
  inputTokens?: number;
  outputTokens?: number;
}

interface SidebarProps {
  activeView: View;
  onViewChange: (view: View) => void;
  state: ProjectState | null;
  onProjectChange: () => Promise<void> | void;
  onGlobalAction: (action: "new-project") => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  operationStatus?: OperationStatus;
  operationLabel?: string | null;
}

const projectNav: { id: View; label: string; icon: LucideIcon }[] = [
  { id: "brief", label: "Overview", icon: FileText },
  { id: "agents", label: "Agents", icon: Bot },
  { id: "plan", label: "Tasks", icon: MonitorCog },
  { id: "workflows", label: "Workflows", icon: GitBranch },
  { id: "architecture", label: "Architecture", icon: FolderTree },
  { id: "evals", label: "Evals", icon: Beaker },
];

export function Sidebar({
  activeView,
  onViewChange,
  state,
  onProjectChange,
  onGlobalAction,
  collapsed,
  onToggleCollapsed,
  operationStatus,
  operationLabel,
}: SidebarProps) {
  const taskCount = state?.currentTaskPlan?.tasks?.length
    ?? state?.currentTasks?.match(/###\s*Task\s+[^:\n]+/g)?.length
    ?? 0;
  const decisionCount = state?.decisions?.length ?? 0;
  const llmProvider = llmProviderLabel(state?.config?.llm);
  const tierModels = useMemo(() => {
    const llm = state?.config?.llm;
    if (!llm) {
      return { fast: "—", default: "—", strong: "—" };
    }
    return {
      fast: resolveTierModel(llm.models.fast),
      default: resolveTierModel(llm.models.default),
      strong: resolveTierModel(llm.models.strong),
    };
  }, [state?.config?.llm]);
  const hasProject = !!state?.projectRoot;
  const isRunning = operationStatus === "running";

  const [tokenStats, setTokenStats] = useState<TokenStats>({ inputTokens: 0, outputTokens: 0 });

  // Load token usage from logs periodically
  useEffect(() => {
    if (!hasProject) return;

    function loadTokens() {
      fetch("/api/usage/session")
        .then((r) => r.json())
        .then((data: SessionUsageResponse) => {
          setTokenStats({
            inputTokens: typeof data.inputTokens === "number" ? data.inputTokens : 0,
            outputTokens: typeof data.outputTokens === "number" ? data.outputTokens : 0,
          });
        })
        .catch(() => setTokenStats({ inputTokens: 0, outputTokens: 0 }));
    }

    loadTokens();
    const id = setInterval(loadTokens, 5000);
    const settleId = operationStatus && operationStatus !== "running"
      ? window.setTimeout(loadTokens, 1200)
      : null;
    return () => {
      clearInterval(id);
      if (settleId !== null) window.clearTimeout(settleId);
    };
  }, [hasProject, operationStatus]); // re-fetch after operations

  return (
    <aside className={`shrink-0 border-r border-zinc-800 bg-zinc-950 flex overflow-visible ${collapsed ? "w-[52px]" : "w-[280px]"}`}>

      {/* Narrow icon rail — global controls */}
      <div className="w-[52px] shrink-0 border-r border-zinc-800/60 flex flex-col items-center py-3 gap-1">
        <button
          onClick={onToggleCollapsed}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className="w-9 h-9 rounded-lg flex items-center justify-center transition-colors text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/60"
        >
          {collapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
        </button>

        {/* Project switcher */}
        <ProjectSelector
          compact
          currentPath={state?.projectRoot ?? null}
          onProjectChange={onProjectChange}
        />

        {/* New project */}
        <button
          onClick={() => onGlobalAction("new-project")}
          title="New Project"
          className="w-9 h-9 rounded-lg flex items-center justify-center transition-colors text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/60"
        >
          <CirclePlus className="h-4 w-4" />
        </button>


        {collapsed && (
          <div className="w-full flex flex-col items-center gap-1 pt-1">
            {projectNav.map((item) => {
              const Icon = item.icon;
              const isActive = activeView === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => onViewChange(item.id)}
                  title={item.label}
                  className={`w-9 h-9 rounded-lg flex items-center justify-center transition-colors ${
                    isActive
                      ? "bg-zinc-800 text-zinc-100"
                      : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/60"
                  }`}
                >
                  <Icon className="h-4 w-4" />
                </button>
              );
            })}
          </div>
        )}

        <div className="flex-1" />

        {/* Settings */}
        <button
          onClick={() => onViewChange("settings")}
          title="Settings"
          className={`w-9 h-9 rounded-lg flex items-center justify-center transition-colors ${
            activeView === "settings"
              ? "bg-zinc-800 text-zinc-100"
              : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/60"
          }`}
        >
          <Settings className="h-4 w-4" />
        </button>
      </div>

      {/* Main panel — project-specific */}
      {!collapsed && (
        <div className="flex-1 flex flex-col min-w-0">

        {/* Project header */}
        <div className="px-4 h-10 border-b border-zinc-800/60 flex items-center">
          <p className="font-bender-brand text-[16px] leading-none tracking-[0.08em] select-none">
            <span className="text-zinc-100">Bender</span>
            <span className="text-zinc-500">.desktop</span>
          </p>
        </div>

        {/* Project nav */}
        <nav className="flex-1 py-3">
          {projectNav.map((item) => {
            const Icon = item.icon;
            const isActive = activeView === item.id;
            const badge =
              item.id === "plan"
                ? taskCount
                : item.id === "architecture"
                  ? decisionCount
                  : null;

            return (
              <button
                key={item.id}
                onClick={() => onViewChange(item.id)}
                className={`w-full flex items-center gap-2.5 px-4 py-[7px] text-sm transition-colors relative ${
                  isActive
                    ? "bg-zinc-800/70 text-zinc-100"
                    : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/30"
                }`}
              >
                {/* Left accent bar on active */}
                {isActive && (
                  <span className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-4 bg-zinc-300 rounded-full" />
                )}
                <Icon className={`h-[15px] w-[15px] shrink-0 ${isActive ? "text-zinc-200" : "text-zinc-500"}`} />
                <span className="flex-1 text-left text-[13px]">{item.label}</span>
                {badge !== null && badge > 0 && (
                  <span className={`text-[11px] font-medium px-1.5 py-0.5 rounded-full ${
                    isActive ? "bg-zinc-700 text-zinc-200" : "bg-zinc-800 text-zinc-500"
                  }`}>
                    {badge}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        {/* Running task notification */}
        {isRunning && (
          <div className="px-4 py-2 border-t border-zinc-800/60 bg-zinc-900/40">
            <div className="flex items-center gap-2 mb-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-zinc-400 animate-pulse shrink-0" />
              <span className="text-[11px] text-zinc-400 truncate">
                {operationLabel ?? "Running…"}
              </span>
            </div>
            {/* Indeterminate progress bar */}
            <div className="h-0.5 w-full bg-zinc-800 rounded-full overflow-hidden">
              <div className="h-full bg-zinc-500 rounded-full animate-[progress-slide_1.5s_ease-in-out_infinite]"
                style={{ width: "40%", animation: "progressSlide 1.5s ease-in-out infinite" }}
              />
            </div>
          </div>
        )}

        {/* Footer info */}
        <div className="px-4 py-3 border-t border-zinc-800/60 space-y-1.5">
          {state?.config ? (
            <>
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-zinc-600">LLM Provider</span>
                <span className="text-[11px] text-zinc-400">
                  {llmProvider}
                </span>
              </div>
              <div className="space-y-0.5 pb-0.5">
                {(["fast", "default", "strong"] as const).map((tier) => (
                  <div key={tier} className="flex items-center justify-between gap-2">
                    <span className="text-[10px] text-zinc-600 shrink-0">{tier}</span>
                    <span
                      title={tierModels[tier] !== "—" ? tierModels[tier] : undefined}
                      className="text-[10px] text-zinc-500 font-mono truncate"
                    >
                      {shortenModelName(tierModels[tier])}
                    </span>
                  </div>
                ))}
              </div>
            </>
          ) : hasProject ? (
            <LoadingDots size={16} label="Loading config…" className="py-0.5" textClassName="text-[11px] text-zinc-600 italic" />
          ) : null}

          <div className="flex items-center justify-between pt-1 border-t border-zinc-800/60">
            <span className="text-[11px] text-zinc-600 flex items-center gap-1">
              <Zap className="h-2.5 w-2.5" /> Session tokens
            </span>
            <span className="text-[11px] text-zinc-500 tabular-nums">
              {formatTokenCount(tokenStats.inputTokens + tokenStats.outputTokens)}
            </span>
          </div>

          {state?.git && (
            <div className="flex items-center gap-1.5 pt-1 border-t border-zinc-800/60">
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${state.git.clean ? "bg-bender-success" : "bg-bender-warning"}`} />
              <span className="text-[11px] text-zinc-600 truncate">{state.git.branch || "main"}</span>
            </div>
          )}
        </div>
        </div>
      )}
    </aside>
  );
}
