export type WorkflowStepType = "prompt" | "action" | "condition" | "extract" | "response";
export type WorkflowRunStatus = "queued" | "running" | "completed" | "failed";
export type WorkflowStepRunStatus = "running" | "completed" | "failed" | "skipped";

export type BuiltinWorkflowAction =
  | "analyze"
  | "plan"
  | "implement"
  | "review"
  | "eval"
  | "github-issue-extract-candidates";

export interface WorkflowDefinition {
  id: string;
  name: string;
  description?: string;
  acceptanceCriteria?: string[];
  version: number;
  enabled: boolean;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  steps: WorkflowStep[];
  createdAt: number;
  updatedAt: number;
}

export interface WorkflowStep {
  id: string;
  type: WorkflowStepType;
  name: string;
  config: Record<string, unknown>;
}

export interface WorkflowRun {
  id: string;
  workflowId: string;
  status: WorkflowRunStatus;
  input: Record<string, unknown>;
  output?: Record<string, unknown>;
  error?: string;
  startedAt: number;
  finishedAt?: number;
  steps: WorkflowRunStep[];
}

export interface WorkflowRunStep {
  stepId: string;
  type: WorkflowStepType;
  status: WorkflowStepRunStatus;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  error?: string;
  startedAt: number;
  finishedAt?: number;
}

