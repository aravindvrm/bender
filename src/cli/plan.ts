import { readEffectiveConfig } from "../state/config.js";
import { StateManager } from "../state/manager.js";
import { createModelSet, getModelForTier, resolveProviderModelForTier } from "../llm/provider.js";
import { generateClarifyingQuestions, generateBrief } from "../roles/clarifier.js";
import { updateArchitecture } from "../roles/architect.js";
import { generateFeaturePlan } from "../roles/planner.js";
import { runOfficeHours, type OfficeHoursVerdict } from "../roles/office-hours.js";
import { terminalAdapter, type UIAdapter } from "./adapter.js";
import { createRoleRuntime, type RoleRuntime } from "../llm/runtime.js";
import { getEffectiveAgentForRole } from "../state/agents.js";
import { createLogger, makeAdapterSink, toLoggerOptions } from "../logger.js";

export interface PlanCommandOptions {
  role?: "analyzer" | "architect" | "planner" | "implementer" | "reviewer";
  agentId?: string;
  officeHoursMode?: "pressure-test" | "execution-plan";
  askClarifyingQuestions?: boolean;
  requireArchitectureApproval?: boolean;
  requirePlanApproval?: boolean;
}

function parseGeneratedTaskIds(planMarkdown: string): number[] {
  const matches = [...planMarkdown.matchAll(/###\s*Task\s*(\d+):/g)];
  return matches.map((m) => parseInt(m[1], 10)).filter((n) => Number.isFinite(n));
}

type ArchitectureGate = "PASS" | "SIMPLIFY" | "VALIDATE" | "BLOCKED";

function parseArchitectureGate(architectureUpdate: string): ArchitectureGate | null {
  const m = architectureUpdate.match(/GATE:\s*(PASS|SIMPLIFY|VALIDATE|BLOCKED)/i);
  if (!m) return null;
  return m[1].toUpperCase() as ArchitectureGate;
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
  const officeHoursMode = options.officeHoursMode ?? "pressure-test";
  const askClarifyingQuestions = options.askClarifyingQuestions ?? false;
  const requireArchitectureApproval = options.requireArchitectureApproval ?? false;
  const requirePlanApproval = options.requirePlanApproval ?? false;
  logger.info("Starting plan", {
    feature: featureDescription.slice(0, 120),
    requestedRole,
    officeHoursMode,
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
  const officeHoursEnabled = requestedRole === "planner"
    && officeHoursMode === "pressure-test";

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
        capabilityPolicy: plannerAgent.capabilityPolicy,
        modelTier: plannerAgent.modelTier,
        systemPromptAddition: plannerAgent.systemPromptAddition,
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
    const plannerModelSelection = resolveProviderModelForTier(config, plannerAgent.modelTier);
    adapter.info(
      `Using planner agent: ${plannerAgent.name} (${plannerAgent.modelTier}) · model ${plannerModelSelection.provider}:${plannerModelSelection.model || "(unconfigured)"}`,
    );

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

    let officeHoursVerdict: OfficeHoursVerdict | null = null;
    let officeHoursOutput: string | null = null;
    if (officeHoursEnabled) {
      adapter.subheader("Step 1.5: Office Hours Pressure Test");
      adapter.info("Running office-hours pressure test before architecture and task planning...\n");
      const officeHoursModel = getModelForTier(models, plannerAgent.modelTier);
      const result = await runOfficeHours(
        officeHoursModel,
        fullDescription,
        existingContext.brief,
        existingContext.architecture,
        adapter.streamWriter(),
        plannerRuntime,
      );
      officeHoursVerdict = result.verdict;
      officeHoursOutput = result.output;

      if (officeHoursVerdict) {
        adapter.info(`Office Hours verdict: ${officeHoursVerdict}`);
      } else {
        adapter.warn("Office Hours verdict missing. Continuing with planner flow.");
      }

      if (officeHoursVerdict === "KILL" || officeHoursVerdict === "DEFER") {
        const continueAfterGate = await adapter.confirm(
          `Office Hours returned ${officeHoursVerdict}. Continue to architecture and task planning anyway?`,
          false,
        );
        if (!continueAfterGate) {
          adapter.info("Planning halted based on Office Hours verdict.");
          await state.writeSession(
            "plan",
            `# Plan Session\n\nDate: ${new Date().toISOString()}\n\nFeature: ${featureDescription}\n\nRole: ${requestedRole}\n\nOffice Hours verdict: ${officeHoursVerdict}\n\nStatus: halted`,
          );
          adapter.cleanup();
          return;
        }
      }
    }

    // Step 2: Architecture update
    adapter.subheader("Step 2: Architecture Impact");
    adapter.info("Analyzing architecture impact...\n");

    const architectModelSelection = resolveProviderModelForTier(config, architectAgent.modelTier);
    adapter.info(
      `Using architect agent: ${architectAgent.name} (${architectAgent.modelTier}) · model ${architectModelSelection.provider}:${architectModelSelection.model || "(unconfigured)"}`,
    );
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
          capabilityPolicy: architectAgent.capabilityPolicy,
          modelTier: architectAgent.modelTier,
          systemPromptAddition: architectAgent.systemPromptAddition,
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

    const architectureGate = parseArchitectureGate(architectureUpdate);
    if (architectureGate) {
      adapter.info(`Architecture gate: ${architectureGate}`);
    }
    if (architectureGate === "BLOCKED") {
      const continueBlocked = await adapter.confirm(
        "Architecture gate is BLOCKED. Continue anyway?",
        false,
      );
      if (!continueBlocked) {
        adapter.info("Planning halted based on architecture gate.");
        adapter.cleanup();
        return;
      }
    } else if (architectureGate === "SIMPLIFY" || architectureGate === "VALIDATE") {
      const continueRisk = await adapter.confirm(
        `Architecture gate is ${architectureGate}. Continue to task planning with this risk?`,
        false,
      );
      if (!continueRisk) {
        adapter.info("Planning halted based on architecture gate.");
        adapter.cleanup();
        return;
      }
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
      `# Plan Session\n\nDate: ${new Date().toISOString()}\n\nFeature: ${featureDescription}\n\nRole: ${requestedRole}\n\nOffice Hours mode: ${requestedRole === "planner" ? officeHoursMode : "n/a"}\n${officeHoursEnabled ? `Office Hours verdict: ${officeHoursVerdict ?? "unknown"}\n\n` : ""}${officeHoursOutput ? `## Office Hours\n\n${officeHoursOutput}\n\n` : ""}Status: completed`,
    );

    logger.info("Plan complete");
    adapter.success("Task plan saved to .bender/tasks/current.md");
    adapter.info("Next step: run `bender implement` to execute the plan.");
    adapter.cleanup();
  } finally {
    await plannerRuntime.close();
  }
}
