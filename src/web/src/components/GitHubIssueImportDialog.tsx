import { useEffect, useMemo, useState } from "react";
import { ChevronDown, GitBranch, Loader2, RefreshCw, Search, WandSparkles, X } from "lucide-react";

interface GitHubWorkItem {
  sourceType: "issue";
  repoFullName: string;
  issueNumber: number;
  title: string;
  body: string;
  state: string;
  url: string;
  labels: string[];
  assignees: string[];
  milestone?: string;
  alreadyLinkedTaskIds: number[];
}

interface ExtractionCandidate {
  id: string;
  sourceType: "issue";
  sourceIssueNumber: number;
  sourceIssueUrl: string;
  sourceTitle: string;
  repoFullName: string;
  title: string;
  description: string;
  dependencies: string;
  acceptanceCriteria: string;
  suggestedFiles: string[];
  rationale?: string;
  notes?: string;
  warnings: string[];
}

interface CandidateDraft extends ExtractionCandidate {
  accepted: boolean;
  suggestedFilesDraft: string;
}

interface GitHubIssueImportDialogProps {
  onClose: () => void;
  onImported?: () => Promise<void> | void;
}

function toErrorMessage(body: unknown, fallback: string): string {
  if (!body || typeof body !== "object") return fallback;
  const error = (body as { error?: unknown }).error;
  return typeof error === "string" && error.trim() ? error : fallback;
}

export function GitHubIssueImportDialog({ onClose, onImported }: GitHubIssueImportDialogProps) {
  const [step, setStep] = useState<"select" | "review">("select");
  const [repoFullName, setRepoFullName] = useState("");
  const [workItems, setWorkItems] = useState<GitHubWorkItem[]>([]);
  const [selectedIssueNumbers, setSelectedIssueNumbers] = useState<number[]>([]);
  const [candidates, setCandidates] = useState<CandidateDraft[]>([]);

  const [q, setQ] = useState("");
  const [labels, setLabels] = useState("");
  const [assignee, setAssignee] = useState("");
  const [milestone, setMilestone] = useState("");
  const [unlinkedOnly, setUnlinkedOnly] = useState(false);

  const [loading, setLoading] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedCount = useMemo(() => selectedIssueNumbers.length, [selectedIssueNumbers]);
  const acceptedCount = useMemo(() => candidates.filter((candidate) => candidate.accepted).length, [candidates]);

  const selectedSet = useMemo(() => new Set(selectedIssueNumbers), [selectedIssueNumbers]);

  async function loadWorkItems() {
    setLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams();
      params.set("state", "open");
      if (q.trim()) params.set("q", q.trim());
      if (labels.trim()) params.set("labels", labels.trim());
      if (assignee.trim()) params.set("assignee", assignee.trim());
      if (milestone.trim()) params.set("milestone", milestone.trim());
      if (unlinkedOnly) params.set("unlinkedOnly", "true");

      const response = await fetch(`/api/github/work-items?${params.toString()}`);
      const body = await response.json();
      if (!response.ok) {
        throw new Error(toErrorMessage(body, "Failed to load GitHub issues"));
      }

      const nextItems = (body.workItems ?? []) as GitHubWorkItem[];
      setRepoFullName((body.repoFullName ?? "").trim());
      setWorkItems(nextItems);
      setSelectedIssueNumbers((previous) => previous.filter((value) => nextItems.some((item) => item.issueNumber === value)));
      setStep("select");
      setCandidates([]);
    } catch (err) {
      setError((err as Error).message);
      setWorkItems([]);
      setSelectedIssueNumbers([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadWorkItems();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function toggleIssue(issueNumber: number, checked: boolean) {
    setSelectedIssueNumbers((previous) => {
      const next = new Set(previous);
      if (checked) next.add(issueNumber);
      else next.delete(issueNumber);
      return [...next].sort((a, b) => a - b);
    });
  }

  function toggleAllVisible(checked: boolean) {
    if (checked) {
      setSelectedIssueNumbers(workItems.map((item) => item.issueNumber));
    } else {
      setSelectedIssueNumbers([]);
    }
  }

  async function extractCandidates() {
    const selectedItems = workItems.filter((item) => selectedSet.has(item.issueNumber));
    if (selectedItems.length === 0) {
      setError("Select at least one issue to extract tasks.");
      return;
    }

    setExtracting(true);
    setError(null);

    try {
      const response = await fetch("/api/github/work-items/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workItems: selectedItems }),
      });
      const body = await response.json();
      if (!response.ok) {
        throw new Error(toErrorMessage(body, "Failed to extract tasks from issues"));
      }

      const extracted = (body.candidates ?? []) as ExtractionCandidate[];
      setCandidates(extracted.map((candidate) => ({
        ...candidate,
        accepted: true,
        suggestedFilesDraft: candidate.suggestedFiles.join(", "),
      })));
      setStep("review");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setExtracting(false);
    }
  }

  function updateCandidate(candidateId: string, updates: Partial<CandidateDraft>) {
    setCandidates((previous) => previous.map((candidate) => (
      candidate.id === candidateId ? { ...candidate, ...updates } : candidate
    )));
  }

  async function importAccepted() {
    const accepted = candidates.filter((candidate) => candidate.accepted);
    if (accepted.length === 0) {
      setError("Select at least one extracted task to import.");
      return;
    }

    setImporting(true);
    setError(null);

    try {
      const response = await fetch("/api/github/work-items/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          candidates: accepted.map((candidate) => ({
            id: candidate.id,
            sourceType: candidate.sourceType,
            sourceIssueNumber: candidate.sourceIssueNumber,
            sourceIssueUrl: candidate.sourceIssueUrl,
            sourceTitle: candidate.sourceTitle,
            repoFullName: candidate.repoFullName,
            title: candidate.title,
            description: candidate.description,
            dependencies: candidate.dependencies,
            acceptanceCriteria: candidate.acceptanceCriteria,
            suggestedFiles: candidate.suggestedFilesDraft
              .split(",")
              .map((value) => value.trim())
              .filter(Boolean),
            rationale: candidate.rationale,
            notes: candidate.notes,
            warnings: candidate.warnings,
          })),
        }),
      });
      const body = await response.json();
      if (!response.ok) {
        throw new Error(toErrorMessage(body, "Failed to import accepted tasks"));
      }

      await onImported?.();
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setImporting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-start justify-center p-4 overflow-y-auto">
      <div className="w-full max-w-5xl bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl mt-8">
        <div className="px-4 py-3 border-b border-zinc-800 flex items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-medium text-zinc-100 flex items-center gap-2">
              <GitBranch className="h-4 w-4 text-zinc-400" />
              Import From GitHub Issues
            </h3>
            <p className="text-xs text-zinc-500 mt-0.5">
              {repoFullName ? `Linked repo: ${repoFullName}` : "Using current project linked repo."}
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/60 transition-colors"
            aria-label="Close import dialog"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="px-4 py-3 border-b border-zinc-800 flex items-center gap-2 text-xs">
          <span className={`px-2 py-1 rounded ${step === "select" ? "bg-zinc-100 text-zinc-900" : "bg-zinc-800 text-zinc-400"}`}>
            1. Select Issues
          </span>
          <ChevronDown className="h-3 w-3 text-zinc-600" />
          <span className={`px-2 py-1 rounded ${step === "review" ? "bg-zinc-100 text-zinc-900" : "bg-zinc-800 text-zinc-400"}`}>
            2. Review & Import
          </span>
        </div>

        {error && (
          <div className="px-4 py-2 border-b border-zinc-800">
            <p className="text-xs text-bender-danger">{error}</p>
          </div>
        )}

        {step === "select" && (
          <div className="p-4 space-y-3">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-2">
              <div className="relative lg:col-span-2">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-zinc-500" />
                <input
                  value={q}
                  onChange={(event) => setQ(event.target.value)}
                  placeholder="Keyword search"
                  className="w-full pl-7 pr-2 py-1.5 text-xs bg-zinc-950 border border-zinc-700 rounded text-zinc-200"
                />
              </div>
              <input
                value={labels}
                onChange={(event) => setLabels(event.target.value)}
                placeholder="Labels (comma)"
                className="px-2 py-1.5 text-xs bg-zinc-950 border border-zinc-700 rounded text-zinc-200"
              />
              <input
                value={assignee}
                onChange={(event) => setAssignee(event.target.value)}
                placeholder="Assignee"
                className="px-2 py-1.5 text-xs bg-zinc-950 border border-zinc-700 rounded text-zinc-200"
              />
              <input
                value={milestone}
                onChange={(event) => setMilestone(event.target.value)}
                placeholder="Milestone"
                className="px-2 py-1.5 text-xs bg-zinc-950 border border-zinc-700 rounded text-zinc-200"
              />
            </div>

            <div className="flex items-center justify-between gap-3 text-xs">
              <label className="inline-flex items-center gap-2 text-zinc-400">
                <input
                  type="checkbox"
                  checked={unlinkedOnly}
                  onChange={(event) => setUnlinkedOnly(event.target.checked)}
                />
                Show only issues not already linked to tasks
              </label>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => void loadWorkItems()}
                  disabled={loading}
                  className="px-2.5 py-1.5 border border-zinc-700 text-zinc-300 hover:bg-zinc-800 disabled:opacity-50 rounded inline-flex items-center gap-1.5"
                >
                  {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                  Refresh
                </button>
                <button
                  onClick={() => void extractCandidates()}
                  disabled={extracting || selectedCount === 0}
                  className="px-2.5 py-1.5 border border-zinc-200 bg-zinc-100 text-zinc-900 hover:bg-white disabled:opacity-50 rounded inline-flex items-center gap-1.5"
                >
                  {extracting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <WandSparkles className="h-3.5 w-3.5" />}
                  Extract Tasks ({selectedCount})
                </button>
              </div>
            </div>

            <div className="border border-zinc-800 rounded-lg overflow-hidden">
              <div className="grid grid-cols-[48px_1fr_120px_140px] gap-2 px-3 py-2 bg-zinc-900 border-b border-zinc-800 text-[11px] uppercase tracking-wider text-zinc-500">
                <label className="inline-flex items-center justify-center">
                  <input
                    type="checkbox"
                    checked={workItems.length > 0 && selectedCount === workItems.length}
                    onChange={(event) => toggleAllVisible(event.target.checked)}
                  />
                </label>
                <span>Issue</span>
                <span>Status</span>
                <span>Linked</span>
              </div>
              <div className="max-h-[360px] overflow-y-auto">
                {workItems.length === 0 && (
                  <div className="px-3 py-6 text-center text-sm text-zinc-500">
                    {loading ? "Loading issues..." : "No issues found for these filters."}
                  </div>
                )}
                {workItems.map((item) => (
                  <div key={item.issueNumber} className="grid grid-cols-[48px_1fr_120px_140px] gap-2 px-3 py-2 border-b border-zinc-800/60 text-xs">
                    <label className="inline-flex items-center justify-center">
                      <input
                        type="checkbox"
                        checked={selectedSet.has(item.issueNumber)}
                        onChange={(event) => toggleIssue(item.issueNumber, event.target.checked)}
                      />
                    </label>
                    <div>
                      <p className="text-zinc-200 truncate">
                        #{item.issueNumber} {item.title}
                      </p>
                      <p className="text-zinc-500 truncate">
                        {item.labels.length > 0 ? item.labels.join(", ") : "No labels"}
                      </p>
                    </div>
                    <span className="text-zinc-500">{item.state}</span>
                    <span className={item.alreadyLinkedTaskIds.length > 0 ? "text-amber-400" : "text-zinc-500"}>
                      {item.alreadyLinkedTaskIds.length > 0
                        ? `Task${item.alreadyLinkedTaskIds.length > 1 ? "s" : ""} ${item.alreadyLinkedTaskIds.join(", ")}`
                        : "No"}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {step === "review" && (
          <div className="p-4 space-y-3">
            <div className="flex items-center justify-between text-xs text-zinc-400">
              <span>{candidates.length} candidate task(s) extracted</span>
              <span>{acceptedCount} selected for import</span>
            </div>

            <div className="max-h-[420px] overflow-y-auto space-y-3 pr-1">
              {candidates.map((candidate) => (
                <div key={candidate.id} className="border border-zinc-800 rounded-lg p-3 space-y-2">
                  <label className="inline-flex items-center gap-2 text-xs text-zinc-300">
                    <input
                      type="checkbox"
                      checked={candidate.accepted}
                      onChange={(event) => updateCandidate(candidate.id, { accepted: event.target.checked })}
                    />
                    Import this task candidate
                  </label>

                  <p className="text-[11px] text-zinc-500">
                    Source issue: #{candidate.sourceIssueNumber} {candidate.sourceTitle}
                  </p>

                  {candidate.warnings.length > 0 && (
                    <div className="text-[11px] text-amber-300 bg-amber-500/10 border border-amber-500/20 rounded p-2 space-y-1">
                      {candidate.warnings.map((warning) => (
                        <p key={warning}>{warning}</p>
                      ))}
                    </div>
                  )}

                  <input
                    value={candidate.title}
                    onChange={(event) => updateCandidate(candidate.id, { title: event.target.value })}
                    className="w-full px-2 py-1.5 text-xs bg-zinc-950 border border-zinc-700 rounded text-zinc-200"
                    placeholder="Task title"
                  />
                  <textarea
                    value={candidate.description}
                    onChange={(event) => updateCandidate(candidate.id, { description: event.target.value })}
                    className="w-full px-2 py-1.5 text-xs bg-zinc-950 border border-zinc-700 rounded text-zinc-300"
                    rows={3}
                    placeholder="Task description"
                  />
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                    <input
                      value={candidate.dependencies}
                      onChange={(event) => updateCandidate(candidate.id, { dependencies: event.target.value })}
                      className="px-2 py-1.5 text-xs bg-zinc-950 border border-zinc-700 rounded text-zinc-200"
                      placeholder="Dependencies"
                    />
                    <input
                      value={candidate.suggestedFilesDraft}
                      onChange={(event) => updateCandidate(candidate.id, { suggestedFilesDraft: event.target.value })}
                      className="px-2 py-1.5 text-xs bg-zinc-950 border border-zinc-700 rounded text-zinc-200"
                      placeholder="Suggested files (comma separated)"
                    />
                  </div>
                  <input
                    value={candidate.acceptanceCriteria}
                    onChange={(event) => updateCandidate(candidate.id, { acceptanceCriteria: event.target.value })}
                    className="w-full px-2 py-1.5 text-xs bg-zinc-950 border border-zinc-700 rounded text-zinc-200"
                    placeholder="Acceptance criteria"
                  />
                </div>
              ))}
            </div>

            <div className="flex items-center justify-between gap-2">
              <button
                onClick={() => setStep("select")}
                disabled={importing}
                className="px-2.5 py-1.5 text-xs border border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 disabled:opacity-50 rounded"
              >
                Back to selection
              </button>
              <button
                onClick={() => void importAccepted()}
                disabled={importing || acceptedCount === 0}
                className="px-2.5 py-1.5 text-xs border border-zinc-200 bg-zinc-100 text-zinc-900 hover:bg-white disabled:opacity-50 rounded"
              >
                {importing ? "Importing..." : `Import ${acceptedCount} Task${acceptedCount === 1 ? "" : "s"}`}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
