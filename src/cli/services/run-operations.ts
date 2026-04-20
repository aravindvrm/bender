import { existsSync } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { addToRegistry } from "../../state/registry.js";
import { readEffectiveConfig, writeConfig } from "../../state/config.js";
import { StateManager } from "../../state/manager.js";
import { createModelSet, getModelForTier } from "../../llm/provider.js";
import { createRoleRuntime, type RoleRuntime } from "../../llm/runtime.js";
import { getEffectiveAgentForRole } from "../../state/agents.js";
import { initCommand } from "../init.js";
import { planCommand } from "../plan.js";
import { implementCommand, implementSingleTask } from "../implement.js";
import { analyzeCommand } from "../analyze.js";
import { runAuditWorkflow } from "./audits.js";
import { generateFlows } from "../../roles/flowcharter.js";
import { updateArchitecture } from "../../roles/architect.js";
import { runOfficeHours, type OfficeHoursVerdict } from "../../roles/office-hours.js";
import { generateFeaturePlan } from "../../roles/planner.js";
import { reviewCode } from "../../roles/reviewer.js";
import { GitOperations } from "../../git/operations.js";
import { parseTaskPlanMarkdown, type CanonicalTaskPlanTask } from "../../state/task-plan.js";
import { appendTask } from "./tasks.js";
import { createLogger, logError, makeAdapterSink, toLoggerOptions } from "../../logger.js";
import type { UIAdapter } from "../adapter.js";

interface RunInitDeps {
  getProject: () => string;
  setCurrentProject: (path: string) => void;
  normalizeUserPath: (input?: string) => string;
}

export interface IterativePlanOperationInput {
  feature?: string;
  mode?: "proposal" | "commit";
  includeArchitectureImpact?: boolean;
  officeHoursMode?: "off" | "pressure-test";
}

export interface IterativePlanOperationResult {
  mode: "proposal" | "commit";
  feature: string;
  tasks: CanonicalTaskPlanTask[];
  planMarkdown: string;
  architectureImpact?: string;
  officeHoursVerdict?: OfficeHoursVerdict | null;
  appendedTaskIds?: string[];
}

export async function runInitOperation(
  deps: RunInitDeps,
  input: {
    description?: string;
    path?: string;
    template?: "nextjs-saas" | "express-api" | "auto";
    llmProvider?: "anthropic" | "openai" | "google" | "groq" | "ollama" | "openai-compatible";
    llmApiKey?: string;
  },
  adapter: UIAdapter,
): Promise<void> {
  const {
    description,
    path: requestedPath,
    template,
    llmProvider,
    llmApiKey,
  } = input;

  let projectRoot: string;
  if (requestedPath?.trim()) {
    projectRoot = deps.normalizeUserPath(requestedPath);
    if (!existsSync(projectRoot)) {
      await mkdir(projectRoot, { recursive: true });
    } else {
      const rootStat = await stat(projectRoot);
      if (!rootStat.isDirectory()) {
        throw new Error("Selected path is not a directory.");
      }
    }
  } else {
    projectRoot = deps.getProject();
  }

  deps.setCurrentProject(projectRoot);

  const initialConfig = await readEffectiveConfig(projectRoot);
  let shouldWriteConfig = false;
  const nextConfig = {
    ...initialConfig,
    llm: { ...initialConfig.llm },
    providers: { ...(initialConfig.providers ?? {}) },
    stack: { ...initialConfig.stack },
  };

  if (template && template !== "auto") {
    nextConfig.stack.template = template;
    if (template === "nextjs-saas") {
      nextConfig.stack.framework = "next.js";
    } else if (template === "express-api") {
      nextConfig.stack.framework = "express";
    }
    shouldWriteConfig = true;
  }

  if (llmProvider) {
    nextConfig.llm.provider = llmProvider;
    if (llmApiKey?.trim() && llmProvider !== "ollama") {
      nextConfig.providers[llmProvider] = { apiKey: llmApiKey.trim() };
    }
    shouldWriteConfig = true;
  }

  if (shouldWriteConfig) {
    await writeConfig(projectRoot, nextConfig);
  }

  let firstPrompt = true;
  const originalPrompt = adapter.promptMultiline.bind(adapter);
  adapter.promptMultiline = async (question: string) => {
    if (firstPrompt && description) {
      firstPrompt = false;
      adapter.info(`> ${description}`);
      return description;
    }
    return originalPrompt(question);
  };

  await initCommand(projectRoot, adapter);
  await addToRegistry(projectRoot);
}

export async function runPlanOperation(
  projectRoot: string,
  input: {
    feature?: string;
    role?: "analyzer" | "architect" | "planner" | "implementer" | "reviewer";
    agentId?: string;
    officeHoursMode?: "pressure-test" | "execution-plan";
    askClarifyingQuestions?: boolean;
    requireArchitectureApproval?: boolean;
    requirePlanApproval?: boolean;
  },
  adapter: UIAdapter,
): Promise<void> {
  if (!input.feature) {
    throw new Error("feature is required");
  }

  await planCommand(projectRoot, input.feature, adapter, {
    role: input.role,
    agentId: input.agentId,
    officeHoursMode: input.officeHoursMode,
    askClarifyingQuestions: input.askClarifyingQuestions,
    requireArchitectureApproval: input.requireArchitectureApproval,
    requirePlanApproval: input.requirePlanApproval,
  });
}

export async function runImplementOperation(
  projectRoot: string,
  input: { taskId?: string },
  adapter: UIAdapter,
): Promise<void> {
  if (input.taskId !== undefined) {
    await implementSingleTask(projectRoot, String(input.taskId), adapter);
    return;
  }
  await implementCommand(projectRoot, adapter);
}

export async function runAnalyzeOperation(projectRoot: string, adapter: UIAdapter): Promise<void> {
  await analyzeCommand(projectRoot, adapter);
}

export async function runAuditOperation(
  projectRoot: string,
  kind: "security" | "tests",
  adapter: UIAdapter,
): Promise<void> {
  await runAuditWorkflow(projectRoot, kind, adapter);
}

export async function runReviewOperation(
  projectRoot: string,
  input: {
    taskTitle?: string;
    staged?: boolean;
    range?: string;
  },
  adapter: UIAdapter,
): Promise<{ status: string; issueCount: number; message: string; raw: string }> {
  const state = new StateManager(projectRoot);
  const context = await state.gatherContext();
  const config = await readEffectiveConfig(projectRoot);
  const gitOps = new GitOperations(projectRoot);

  if (!(await gitOps.isRepo())) {
    throw new Error("Current project is not a git repository.");
  }

  const rawDiff = input.range?.trim()
    ? await gitOps.getDiffRange(input.range.trim())
    : await gitOps.getDiff(Boolean(input.staged));
  const diff = rawDiff.trim();
  if (!diff) {
    adapter.info("No git diff detected for review.");
    return {
      status: "APPROVED",
      issueCount: 0,
      message: "No changes to review.",
      raw: "No changes to review.",
    };
  }

  const models = createModelSet(config);
  const reviewerAgent = await getEffectiveAgentForRole("reviewer");
  const runtime = await createRoleRuntime(
    projectRoot,
    config,
    {
      role: "reviewer",
      taskDescription: input.taskTitle?.trim() || "Review current working changes",
      pinnedSkills: reviewerAgent.pinnedSkills,
      mcpServerIds: reviewerAgent.mcpServerIds,
      capabilityPolicy: reviewerAgent.capabilityPolicy,
      modelTier: reviewerAgent.modelTier,
      systemPromptAddition: reviewerAgent.systemPromptAddition,
    },
    context.architecture ?? undefined,
  );

  try {
    const result = await reviewCode(
      getModelForTier(models, reviewerAgent.modelTier),
      input.taskTitle?.trim() || "Current working changes",
      [{ path: "git.diff", action: "modify", content: diff.slice(0, 120_000) }],
      context,
      runtime,
    );
    const message = result.status === "APPROVED"
      ? "Review completed: no blocking issues."
      : `Review completed: ${result.issues.length} issue(s) found.`;
    adapter.info(message);
    return {
      status: result.status,
      issueCount: result.issues.length,
      message,
      raw: result.raw,
    };
  } finally {
    await runtime.close();
  }
}

export async function runIterativePlanOperation(
  projectRoot: string,
  input: IterativePlanOperationInput,
  adapter: UIAdapter,
): Promise<IterativePlanOperationResult> {
  const feature = input.feature?.trim();
  if (!feature) {
    throw new Error("feature is required");
  }

  const mode = input.mode === "commit" ? "commit" : "proposal";
  const includeArchitectureImpact = input.includeArchitectureImpact !== false;
  const officeHoursMode = input.officeHoursMode === "pressure-test" ? "pressure-test" : "off";

  const state = new StateManager(projectRoot);
  const context = await state.gatherContext();
  if (!context.brief || !context.architecture) {
    throw new Error("Project needs brief and architecture before iterative planning.");
  }

  const config = await readEffectiveConfig(projectRoot);
  const models = createModelSet(config);
  const plannerAgent = await getEffectiveAgentForRole("planner");
  const architectAgent = await getEffectiveAgentForRole("architect");

  const plannerRuntime = await createRoleRuntime(
    projectRoot,
    config,
    {
      role: "planner",
      taskDescription: feature,
      pinnedSkills: plannerAgent.pinnedSkills,
      mcpServerIds: plannerAgent.mcpServerIds,
      capabilityPolicy: plannerAgent.capabilityPolicy,
      modelTier: plannerAgent.modelTier,
      systemPromptAddition: plannerAgent.systemPromptAddition,
    },
    context.architecture ?? undefined,
  );

  try {
    let officeHoursVerdict: OfficeHoursVerdict | null = null;
    if (officeHoursMode === "pressure-test") {
      const officeHours = await runOfficeHours(
        getModelForTier(models, plannerAgent.modelTier),
        feature,
        context.brief,
        context.architecture,
        adapter.streamWriter(),
        plannerRuntime,
      );
      officeHoursVerdict = officeHours.verdict;
    }

    let architectureImpact = "No architecture-impact review requested.";
    if (includeArchitectureImpact) {
      const architectRuntime = await createRoleRuntime(
        projectRoot,
        config,
        {
          role: "architect",
          taskDescription: feature,
          pinnedSkills: architectAgent.pinnedSkills,
          mcpServerIds: architectAgent.mcpServerIds,
          capabilityPolicy: architectAgent.capabilityPolicy,
          modelTier: architectAgent.modelTier,
          systemPromptAddition: architectAgent.systemPromptAddition,
        },
        context.architecture ?? undefined,
      );
      try {
        const architectUpdate = await updateArchitecture(
          getModelForTier(models, architectAgent.modelTier),
          feature,
          config,
          context,
          adapter.streamWriter(),
          architectRuntime,
        );
        architectureImpact = architectUpdate.architectureUpdate.trim() || architectureImpact;
      } finally {
        await architectRuntime.close();
      }
    }

    const planMarkdown = await generateFeaturePlan(
      getModelForTier(models, plannerAgent.modelTier),
      feature,
      architectureImpact,
      context,
      adapter.streamWriter(),
      plannerRuntime,
    );
    const tasks = parseTaskPlanMarkdown(planMarkdown);
    const appendedTaskIds: string[] = [];

    if (mode === "commit") {
      for (const task of tasks) {
        const created = await appendTask(projectRoot, {
          title: task.title,
          description: task.description,
          acceptanceCriteria: task.acceptanceCriteria,
          implementerAgentId: task.implementerAgentId,
        });
        appendedTaskIds.push(created.taskId);
      }
    }

    return {
      mode,
      feature,
      tasks,
      planMarkdown,
      ...(includeArchitectureImpact ? { architectureImpact } : {}),
      ...(officeHoursMode === "pressure-test" ? { officeHoursVerdict } : {}),
      ...(mode === "commit" ? { appendedTaskIds } : {}),
    };
  } finally {
    await plannerRuntime.close();
  }
}

export async function runFlowsOperation(projectRoot: string, adapter: UIAdapter): Promise<void> {
  const state = new StateManager(projectRoot);
  const context = await state.gatherContext();

  if (!context.brief || !context.architecture) {
    throw new Error("Project needs a brief and architecture before flows can be generated. Run init or analyze first.");
  }

  let runtime: RoleRuntime | undefined;
  let architectTier: "fast" | "default" | "strong" = "default";
  let architectAgentName = "Eng Review";
  const config = await readEffectiveConfig(projectRoot);
  const logger = createLogger(
    "flows",
    projectRoot,
    makeAdapterSink(adapter),
    toLoggerOptions(config.logging),
  );
  logger.info("Starting flow generation", {
    hasBrief: !!context.brief,
    hasArchitecture: !!context.architecture,
    hasSchema: !!context.schema,
  });

  try {
    const models = createModelSet(config);
    const architectAgent = await getEffectiveAgentForRole("architect");
    architectTier = architectAgent.modelTier;
    architectAgentName = architectAgent.name;
    runtime = await createRoleRuntime(
      projectRoot,
      config,
      {
        role: "architect",
        pinnedSkills: architectAgent.pinnedSkills,
        mcpServerIds: architectAgent.mcpServerIds,
        capabilityPolicy: architectAgent.capabilityPolicy,
        modelTier: architectAgent.modelTier,
        systemPromptAddition: architectAgent.systemPromptAddition,
      },
      context.architecture ?? undefined,
      logger,
    );

    adapter.subheader("Generating user flow diagrams...");
    adapter.info(`Using agent: ${architectAgentName} (${architectTier})`);

    const flows = await generateFlows(
      getModelForTier(models, architectTier),
      context.brief,
      context.architecture,
      context.schema,
      adapter.streamWriter(),
      runtime,
    );

    await state.writeFlows(flows);
    logger.info("Flow generation complete", {
      agentName: architectAgentName,
      modelTier: architectTier,
      outputChars: flows.length,
    });
    adapter.success("Flow diagrams saved to .bender/flows.md");
  } catch (err: unknown) {
    logError(logger, "Flow generation failed", err, {
      agentName: architectAgentName,
      modelTier: architectTier,
    });
    if ((err as Error)?.message?.startsWith("Missing API key")) {
      throw new Error(`Failed to initialize LLM provider: ${(err as Error).message}`);
    }
    if ((err as Error)?.message?.startsWith("Failed to initialize LLM provider:")) {
      throw err;
    }
    if ((err as Error).message.includes("Missing API key")) {
      throw new Error(`Failed to initialize LLM provider: ${(err as Error).message}`);
    }
    throw err;
  } finally {
    await runtime?.close();
  }
}
