import type { StateManager } from "../state/manager.js";
import type { WorkflowDefinition } from "./types.js";

const BUILTIN_WORKFLOW_IDS = [
  "issue-extract-candidates",
  "task-to-implement",
  "review-current-changes",
] as const;

export type BuiltinWorkflowId = typeof BUILTIN_WORKFLOW_IDS[number];

export function getBuiltinWorkflowDefinitions(nowTs = Date.now()): WorkflowDefinition[] {
  return [
    {
      id: "issue-extract-candidates",
      name: "Issue -> Extract Candidates",
      description: "Extract actionable task candidates from a GitHub issue for review-driven import.",
      acceptanceCriteria: [
        "Produces a persisted workflow run record",
        "Returns extracted task candidates for review before import",
      ],
      version: 1,
      enabled: true,
      inputSchema: {
        type: "object",
        required: ["issueNumber"],
        properties: {
          issueNumber: { type: "number" },
          repoFullName: { type: "string" },
        },
      },
      outputSchema: {
        type: "object",
        properties: {
          repoFullName: { type: "string" },
          candidates: { type: "array" },
        },
      },
      steps: [
        {
          id: "collect",
          type: "prompt",
          name: "Gather issue selection context",
          config: {
            template: "Prepare GitHub issue context for extraction pipeline.",
          },
        },
        {
          id: "extract",
          type: "action",
          name: "Extract role-based candidates",
          config: {
            action: "github-issue-extract-candidates",
          },
        },
        {
          id: "response",
          type: "response",
          name: "Return candidate summary",
          config: {
            fields: ["steps.extract.repoFullName", "steps.extract.candidates"],
          },
        },
      ],
      createdAt: nowTs,
      updatedAt: nowTs,
    },
    {
      id: "task-to-implement",
      name: "Task -> Implement",
      description: "Resolve a task and execute implementation through the canonical task pipeline.",
      acceptanceCriteria: [
        "Produces a persisted workflow run record",
        "Returns implementation outcome summary",
      ],
      version: 1,
      enabled: true,
      inputSchema: {
        type: "object",
        required: ["taskId"],
        properties: {
          taskId: { type: "string" },
        },
      },
      outputSchema: {
        type: "object",
        properties: {
          taskId: { type: "string" },
          completed: { type: "boolean" },
          message: { type: "string" },
        },
      },
      steps: [
        {
          id: "resolve-task",
          type: "extract",
          name: "Resolve task id from input",
          config: {
            from: "input",
            fields: ["taskId"],
          },
        },
        {
          id: "implement",
          type: "action",
          name: "Run implement pipeline",
          config: {
            action: "implement",
            bodyTemplate: {
              taskId: "{{steps.resolve-task.taskId}}",
            },
          },
        },
        {
          id: "response",
          type: "response",
          name: "Return implementation summary",
          config: {
            fields: ["steps.implement.taskId", "steps.implement.completed", "steps.implement.message"],
          },
        },
      ],
      createdAt: nowTs,
      updatedAt: nowTs,
    },
    {
      id: "review-current-changes",
      name: "Review Current Changes",
      description: "Run reviewer checks on the current repository diff.",
      acceptanceCriteria: [
        "Produces a persisted workflow run record",
        "Returns reviewer findings summary",
      ],
      version: 1,
      enabled: true,
      inputSchema: {
        type: "object",
        properties: {},
      },
      outputSchema: {
        type: "object",
        properties: {
          status: { type: "string" },
          issueCount: { type: "number" },
          message: { type: "string" },
        },
      },
      steps: [
        {
          id: "review",
          type: "action",
          name: "Run review pipeline",
          config: {
            action: "review",
          },
        },
        {
          id: "response",
          type: "response",
          name: "Return review findings summary",
          config: {
            fields: ["steps.review.status", "steps.review.issueCount", "steps.review.message"],
          },
        },
      ],
      createdAt: nowTs,
      updatedAt: nowTs,
    },
  ];
}

export async function ensureBuiltinWorkflows(state: StateManager): Promise<void> {
  const builtins = getBuiltinWorkflowDefinitions();
  for (const workflow of builtins) {
    const existing = await state.readWorkflow(workflow.id);
    if (!existing) {
      await state.writeWorkflow(workflow);
    }
  }
}

export function isBuiltinWorkflowId(workflowId: string): workflowId is BuiltinWorkflowId {
  return BUILTIN_WORKFLOW_IDS.includes(workflowId as BuiltinWorkflowId);
}

