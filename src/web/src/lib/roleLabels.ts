export type BaseRole = "analyzer" | "architect" | "planner" | "implementer" | "reviewer";

const ROLE_LABELS: Record<BaseRole, string> = {
  analyzer: "Discovery",
  architect: "Eng Review",
  planner: "Execution Plan",
  implementer: "Implement",
  reviewer: "Review",
};

export function roleLabel(role: BaseRole): string {
  return ROLE_LABELS[role];
}

const ROLE_SUMMARIES: Record<BaseRole, string> = {
  analyzer: "Best for discovery, problem framing, and identifying scope/risk gaps early.",
  architect: "Best for architecture scrutiny, complexity control, and failure-mode planning.",
  planner: "Best for converting approved direction into ordered, atomic implementation tasks.",
  implementer: "Best for producing concrete code/file changes that satisfy a task.",
  reviewer: "Best for adversarial production-risk review, hidden breakage, and safety checks.",
};

export function roleSummary(role: BaseRole): string {
  return ROLE_SUMMARIES[role];
}
