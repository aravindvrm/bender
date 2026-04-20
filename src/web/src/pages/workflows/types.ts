export type WorkflowStepType = "prompt" | "action" | "condition" | "extract" | "response";
export type WorkflowRunStatus = "queued" | "running" | "completed" | "failed";
export type WorkflowStepRunStatus = "running" | "completed" | "failed" | "skipped";

export interface WorkflowSummary {
  id: string;
  name: string;
  enabled: boolean;
  version: number;
  acceptanceCriteria: string[];
}

export interface WorkflowStep {
  id: string;
  type: WorkflowStepType;
  name: string;
  config: Record<string, unknown>;
}

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

export interface WorkflowEditorState {
  id: string;
  name: string;
  description: string;
  acceptanceCriteriaText: string;
  enabled: boolean;
  stepsText: string;
  inputSchemaText: string;
  outputSchemaText: string;
}

// API response shapes
export interface WorkflowsListResponse {
  workflows?: WorkflowSummary[];
  error?: string;
}

export interface WorkflowDetailResponse {
  workflow?: WorkflowDefinition;
  error?: string;
}

export interface WorkflowRunsResponse {
  runs?: WorkflowRun[];
  error?: string;
}

export interface WorkflowRunResponse {
  run?: WorkflowRun;
  error?: string;
}

export interface WorkflowExecuteResponse {
  runId?: string;
  status?: WorkflowRunStatus;
  output?: Record<string, unknown> | null;
  error?: string;
}
