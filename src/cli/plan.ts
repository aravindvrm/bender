import { readEffectiveConfig } from "../state/config.js";
import { StateManager } from "../state/manager.js";
import { createModelSet, getModelForTier } from "../llm/provider.js";
import { generateClarifyingQuestions, generateBrief } from "../roles/clarifier.js";
import { updateArchitecture } from "../roles/architect.js";
import { generateFeaturePlan } from "../roles/planner.js";
import { terminalAdapter, type UIAdapter } from "./adapter.js";
import { createRoleRuntime, type RoleRuntime } from "../llm/runtime.js";
import { getEffectiveAgentForRole } from "../state/agents.js";
import { createLogger, makeAdapterSink, toLoggerOptions } from "../logger.js";

export interface PlanCommandOptions {
  role?: "analyzer" | "architect" | "planner" | "implementer" | "reviewer";
  agentId?: string;
  askClarifyingQuestions?: boolean;
  requireArchitectureApproval?: boolean;
  requirePlanApproval?: boolean;
}

function parseGeneratedTaskIds(planMarkdown: string): number[] {
  const matches = [...planMarkdown.matchAll(/###\s*Task\s*(\d+):/g)];
  return matches.map((m) => parseInt(m[1], 10)).filter((n) => Number.isFinite(n));
}

export async function planCommand(
  projectRoot: string,
  featureDescription: string,
  adapter: UIAdapter = terminalAdapter,
  options: PlanCommandOptions = {},
): Promise<void> {
  adapter.header("Bender Plan — New Feature / Change");

  const state = new StateManager(projectRoot);
  if (!state.isInitialized()) {
    adapter.error("No .bender/ directory found. Run `bender init` first.");
    adapter.cleanup();
    return;
  }

  const config = await readEffectiveConfig(projectRoot);
  const logger = createLogger(
    "plan",
    projectRoot,
    makeAdapterSink(adapter),
    toLoggerOptions(config.logging),
  );
  const requestedRole = options.role ?? "planner";
  const askClarifyingQuestions = options.askClarifyingQuestions ?? false;
  const requireArchitectureApproval = options.requireArchitectureApproval ?? false;
  const requirePlanApproval = options.requirePlanApproval ?? false;
  logger.info("Starting plan", {
    feature: featureDescription.slice(0, 120),
    requestedRole,
    agentId: options.agentId ?? null,
    askClarifyingQuestions,
    requireArchitectureApproval,
    requirePlanApproval,
  });
  const existingContext = await state.gatherContext();

  if (!existingContext.brief || !existingContext.architecture) {
    adapter.error("Project is missing brief or architecture. Run `bender init` first.");
    adapter.cleanup();
    return;
  }

  let models;
  try {
    models = createModelSet(config);
  } catch (err: unknown) {
    adapter.error(`Failed to initialize LLM provider: ${(err as Error).message}`);
    adapter.cleanup();
    return;
  }

  const plannerAgent = await getEffectiveAgentForRole(
    "planner",
    requestedRole === "planner" ? options.agentId : undefined,
  );
  const architectAgent = await getEffectiveAgentForRole(
    "architect",
    requestedRole === "architect" ? options.agentId : undefined,
  );
  const roleGuidance = requestedRole !== "planner"
    ? `\n\nRole perspective: prioritize outcomes and risks from the ${requestedRole} role.`
    : "";
  const roleGuidedFeatureDescription = `${featureDescription}${roleGuidance}`.trim();

  // Step 1 + 3 use planner runtime
  let plannerRuntime: RoleRuntime;
  try {
    plannerRuntime = await createRoleRuntime(
      projectRoot,
      config,
      {
        role: "planner",
        taskDescription: roleGuidedFeatureDescription,
        pinnedSkills: plannerAgent.pinnedSkills,
        mcpServerIds: plannerAgent.mcpServerIds,
        modelTier: plannerAgent.modelTier,
      },
      existingContext.architecture ?? undefined,
      logger,
    );
  } catch (err: unknown) {
    adapter.error(`Failed to initialize MCP/skills runtime: ${(err as Error).message}`);
    adapter.cleanup();
    return;
  }

  try {
    adapter.subheader("Step 1: Understanding the Change");
    adapter.info(`Feature request: "${featureDescription}"\n`);
    adapter.info(`Requested role perspective: ${requestedRole}`);
    adapter.info(`Using planner agent: ${plannerAgent.name} (${plannerAgent.modelTier})`);

    const clarifierModel = getModelForTier(models, plannerAgent.modelTier);
    let fullDescription = roleGuidedFeatureDescription;
    if (askClarifyingQuestions) {
      const questions = await generateClarifyingQuestions(
        clarifierModel,
        roleGuidedFeatureDescription,
        existingContext,
        adapter.streamWriter(),
        plannerRuntime,
      );

      const answers = await adapter.promptMultiline("Answer any questions above, or press Enter to continue with defaults:");
      if (answers) {
        const clarificationQA: { role: "user" | "assistant"; content: string }[] = [
          { role: "assistant", content: questions },
          { role: "user", content: answers },
        ];
        const featureBrief = await generateBrief(
          clarifierModel,
          roleGuidedFeatureDescription,
          clarificationQA,
          existingContext,
          undefined,
          plannerRuntime,
        );
        fullDescription = featureBrief;
        adapter.info(featureBrief);
      }
    } else {
      adapter.info("Clarification step: skipped (explicit toggle off).");
    }

    // Step 2: Architecture update
    adapter.subheader("Step 2: Architecture Impact");
    adapter.info("Analyzing architecture impact...\n");

    adapter.info(`Using architect agent: ${architectAgent.name} (${architectAgent.modelTier})`);
    const architectModel = getModelForTier(models, architectAgent.modelTier);
    let architectureUpdate = "";
    let schemaMigration: string | null = null;
    let architectRuntime: RoleRuntime;
    try {
      architectRuntime = await createRoleRuntime(
        projectRoot,
        config,
        {
          role: "architect",
          taskDescription: fullDescription,
          pinnedSkills: architectAgent.pinnedSkills,
          mcpServerIds: architectAgent.mcpServerIds,
          modelTier: architectAgent.modelTier,
        },
        existingContext.architecture ?? undefined,
        logger,
      );
    } catch (err: unknown) {
      adapter.error(`Failed to initialize MCP/skills runtime: ${(err as Error).message}`);
      adapter.cleanup();
      return;
    }
    try {
      const result = await updateArchitecture(
        architectModel,
        fullDescription,
        config,
        existingContext,
        adapter.streamWriter(),
        architectRuntime,
      );
      architectureUpdate = result.architectureUpdate;
      schemaMigration = result.schemaMigration;
    } finally {
      await architectRuntime.close();
    }

    if (schemaMigration) {
      adapter.warn("Schema migration required:");
      adapter.info(schemaMigration);
    }

    const archApproved = requireArchitectureApproval
      ? await adapter.confirm("Approve architecture updates?")
      : true;
    if (!archApproved) {
      adapter.info("Architecture update cancelled. No changes made.");
      adapter.cleanup();
      return;
    }

    // Update stored architecture
    const currentArch = existingContext.architecture ?? "";
    await state.writeArchitecture(currentArch + "\n\n---\n\n## Update: " + featureDescription + "\n\n" + architectureUpdate);

    // Write ADR
    const decisionNum = await state.nextDecisionNumber();
    const paddedNum = String(decisionNum).padStart(3, "0");
    const slug = featureDescription.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);
    await state.writeDecision(
      `${paddedNum}-${slug}.md`,
      `# ADR ${paddedNum}: ${featureDescription}\n\nDate: ${new Date().toISOString().split("T")[0]}\n\n${architectureUpdate}`,
    );

    // Step 3: Task plan
    adapter.subheader("Step 3: Task Plan");
    adapter.info("Generating implementation plan...\n");

    const plannerModel = getModelForTier(models, plannerAgent.modelTier);
    const plan = await generateFeaturePlan(
      plannerModel,
      fullDescription,
      architectureUpdate,
      existingContext,
      adapter.streamWriter(),
      plannerRuntime,
    );

    const planApproved = requirePlanApproval
      ? await adapter.confirm("Approve this task plan?")
      : true;
    if (!planApproved) {
      adapter.info("You can edit .bender/tasks/current.md and run `bender implement`.");
      await state.writeCurrentTasks(plan);
      adapter.cleanup();
      return;
    }

    await state.writeCurrentTasks(plan);
    if (requestedRole === "implementer" && options.agentId) {
      const taskIds = parseGeneratedTaskIds(plan);
      for (const taskId of taskIds) {
        await state.setTaskAgent(String(taskId), options.agentId);
      }
      if (taskIds.length > 0) {
        adapter.info(`Assigned ${taskIds.length} generated task(s) to agent '${options.agentId}'.`);
      }
    }

    // Write session log
    await state.writeSession(
      "plan",
      `# Plan Session\n\nDate: ${new Date().toISOString()}\n\nFeature: ${featureDescription}\n\nRole: ${requestedRole}\n\nStatus: completed`,
    );

    logger.info("Plan complete");
    adapter.success("Task plan saved to .bender/tasks/current.md");
    adapter.info("Next step: run `bender implement` to execute the plan.");
    adapter.cleanup();
  } finally {
    await plannerRuntime.close();
  }
}
