import { readConfig } from "../state/config.js";
import { StateManager } from "../state/manager.js";
import { createModelSet, getModelForRole } from "../llm/provider.js";
import { generateClarifyingQuestions, generateBrief } from "../roles/clarifier.js";
import { updateArchitecture } from "../roles/architect.js";
import { generateFeaturePlan } from "../roles/planner.js";
import * as ui from "./ui.js";

export async function planCommand(projectRoot: string, featureDescription: string): Promise<void> {
  ui.header("Bender Plan — New Feature / Change");

  const state = new StateManager(projectRoot);
  if (!state.isInitialized()) {
    ui.error("No .bender/ directory found. Run `bender init` first.");
    ui.cleanup();
    return;
  }

  const config = await readConfig(projectRoot);
  const existingContext = await state.gatherContext();

  if (!existingContext.brief || !existingContext.architecture) {
    ui.error("Project is missing brief or architecture. Run `bender init` first.");
    ui.cleanup();
    return;
  }

  let models;
  try {
    models = createModelSet(config);
  } catch (err: unknown) {
    ui.error(`Failed to initialize LLM provider: ${(err as Error).message}`);
    ui.cleanup();
    return;
  }

  // Step 1: Clarification (if the request is vague)
  ui.subheader("Step 1: Understanding the Change");
  ui.info(`Feature request: "${featureDescription}"\n`);

  const clarifierModel = getModelForRole(models, "clarifier");
  const questions = await generateClarifyingQuestions(
    clarifierModel,
    featureDescription,
    existingContext,
    ui.streamWriter(),
  );

  console.log("\n");
  ui.info("Answer any questions above, or press Enter to continue with defaults:\n");
  const answers = await ui.promptMultiline(">");

  let fullDescription = featureDescription;
  if (answers) {
    // Generate a refined brief for this feature
    const clarificationQA: { role: "user" | "assistant"; content: string }[] = [
      { role: "assistant", content: questions },
      { role: "user", content: answers },
    ];
    const featureBrief = await generateBrief(clarifierModel, featureDescription, clarificationQA, existingContext);
    fullDescription = featureBrief;
    console.log("\n" + featureBrief);
  }

  // Step 2: Architecture update
  ui.subheader("Step 2: Architecture Impact");
  ui.info("Analyzing architecture impact...\n");

  const architectModel = getModelForRole(models, "architect");
  const { architectureUpdate, schemaMigration } = await updateArchitecture(
    architectModel,
    fullDescription,
    config,
    existingContext,
    ui.streamWriter(),
  );

  console.log("\n");

  if (schemaMigration) {
    ui.warn("Schema migration required:");
    console.log(schemaMigration);
  }

  const archApproved = await ui.confirm("Approve architecture updates?");
  if (!archApproved) {
    ui.info("Architecture update cancelled. No changes made.");
    ui.cleanup();
    return;
  }

  // Update stored architecture
  const currentArch = existingContext.architecture ?? "";
  await state.writeArchitecture(currentArch + "\n\n---\n\n## Update: " + featureDescription + "\n\n" + architectureUpdate);

  // Write ADR if significant decisions were made
  const decisionNum = await state.nextDecisionNumber();
  const paddedNum = String(decisionNum).padStart(3, "0");
  const slug = featureDescription.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);
  await state.writeDecision(
    `${paddedNum}-${slug}.md`,
    `# ADR ${paddedNum}: ${featureDescription}\n\nDate: ${new Date().toISOString().split("T")[0]}\n\n${architectureUpdate}`,
  );

  // Step 3: Task plan
  ui.subheader("Step 3: Task Plan");
  ui.info("Generating implementation plan...\n");

  const plannerModel = getModelForRole(models, "planner");
  const plan = await generateFeaturePlan(
    plannerModel,
    fullDescription,
    architectureUpdate,
    existingContext,
    ui.streamWriter(),
  );

  console.log("\n");

  const planApproved = await ui.confirm("Approve this task plan?");
  if (!planApproved) {
    ui.info("You can edit .bender/tasks/current.md and run `bender implement`.");
    await state.writeCurrentTasks(plan);
    ui.cleanup();
    return;
  }

  await state.writeCurrentTasks(plan);
  ui.success("Task plan saved to .bender/tasks/current.md");
  console.log();
  ui.info("Next step: run `bender implement` to execute the plan.");
  ui.cleanup();
}
