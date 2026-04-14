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
