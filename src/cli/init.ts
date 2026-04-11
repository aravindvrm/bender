import { writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readConfig, writeConfig, type BenderConfig } from "../state/config.js";
import { StateManager } from "../state/manager.js";
import { createModelSet, getModelForRole } from "../llm/provider.js";
import { generateClarifyingQuestions, generateBrief } from "../roles/clarifier.js";
import { generateArchitecture } from "../roles/architect.js";
import { generateInitialPlan } from "../roles/planner.js";
import { GitOperations } from "../git/operations.js";
import * as ui from "./ui.js";

export async function initCommand(projectRoot: string): Promise<void> {
  ui.header("Bender Init — New Project Setup");

  // Check if already initialized
  const state = new StateManager(projectRoot);
  if (state.isInitialized()) {
    const proceed = await ui.confirm(
      "A .bender/ directory already exists. Re-initialize will overwrite existing state. Continue?",
      false,
    );
    if (!proceed) {
      ui.info("Cancelled.");
      ui.cleanup();
      return;
    }
  }

  // Step 1: Get project description from user
  ui.subheader("Step 1: Describe Your Project");
  ui.info("Tell me what you want to build. Be as detailed or as vague as you like —");
  ui.info("the system will ask clarifying questions next.\n");

  const description = await ui.promptMultiline(">");

  if (!description) {
    ui.error("No description provided. Aborting.");
    ui.cleanup();
    return;
  }

  // Initialize state and config
  const config = await readConfig(projectRoot);
  await state.init();
  await writeConfig(projectRoot, config);

  // Initialize models
  let models;
  try {
    models = createModelSet(config);
  } catch (err: unknown) {
    ui.error(`Failed to initialize LLM provider: ${(err as Error).message}`);
    ui.error("Check your .bender/config.yaml and ensure API keys are set (e.g., ANTHROPIC_API_KEY env var).");
    ui.cleanup();
    return;
  }

  // Step 2: Clarification
  ui.subheader("Step 2: Clarification");
  ui.info("Generating clarifying questions...\n");

  const clarifierModel = getModelForRole(models, "clarifier");
  const questions = await generateClarifyingQuestions(
    clarifierModel,
    description,
    null,
    ui.streamWriter(),
  );

  console.log("\n");
  ui.info("Answer the questions above (or type 'skip' to use defaults):\n");
  const answers = await ui.promptMultiline(">");

  const clarificationQA: { role: "user" | "assistant"; content: string }[] = [
    { role: "assistant", content: questions },
    { role: "user", content: answers || "(No additional answers provided — use reasonable defaults)" },
  ];

  // Step 3: Generate product brief
  ui.subheader("Step 3: Product Brief");
  const spin = ui.spinner("Generating product brief...");
  spin.start();

  const brief = await generateBrief(clarifierModel, description, clarificationQA, null);
  spin.stop();

  console.log(brief);
  console.log("\n");

  const briefApproved = await ui.confirm("Approve this product brief?");
  if (!briefApproved) {
    ui.info("You can edit .bender/brief.md manually and re-run `bender init`.");
    await state.writeBrief(brief);
    ui.cleanup();
    return;
  }

  await state.writeBrief(brief);
  ui.success("Product brief saved.");

  // Step 4: Generate architecture
  ui.subheader("Step 4: Architecture");
  ui.info("Generating architecture document...\n");

  const architectModel = getModelForRole(models, "architect");
  const architecture = await generateArchitecture(
    architectModel,
    brief,
    config,
    null,
    ui.streamWriter(),
  );

  console.log("\n");

  const archApproved = await ui.confirm("Approve this architecture?");
  if (!archApproved) {
    ui.info("You can edit .bender/architecture.md manually and re-run `bender plan`.");
    await state.writeArchitecture(architecture);
    ui.cleanup();
    return;
  }

  await state.writeArchitecture(architecture);

  // Extract and save conventions and schema from architecture
  const conventionsMatch = architecture.match(/##\s*Conventions\s*\n([\s\S]*?)(?=\n##|$)/);
  if (conventionsMatch) {
    await state.writeConventions(conventionsMatch[1].trim());
  }

  const schemaMatch = architecture.match(/```sql\n([\s\S]*?)```/);
  if (schemaMatch) {
    await state.writeSchema(schemaMatch[1].trim());
  }

  ui.success("Architecture saved.");

  // Step 5: Generate task plan
  ui.subheader("Step 5: Task Plan");
  ui.info("Generating implementation plan...\n");

  const plannerModel = getModelForRole(models, "planner");
  const plan = await generateInitialPlan(plannerModel, brief, architecture, ui.streamWriter());

  console.log("\n");

  const planApproved = await ui.confirm("Approve this task plan?");
  if (!planApproved) {
    ui.info("You can edit .bender/tasks/current.md and run `bender implement`.");
    await state.writeCurrentTasks(plan);
    ui.cleanup();
    return;
  }

  await state.writeCurrentTasks(plan);
  ui.success("Task plan saved.");

  // Step 6: Git initialization
  const git = new GitOperations(projectRoot);
  await git.init();
  await git.commitAll("chore: initialize bender project state");

  // Summary
  ui.header("Project Initialized");
  ui.success("Product brief:     .bender/brief.md");
  ui.success("Architecture:      .bender/architecture.md");
  ui.success("Conventions:       .bender/conventions.md");
  ui.success("Schema:            .bender/schema.sql");
  ui.success("Task plan:         .bender/tasks/current.md");
  ui.success("Config:            .bender/config.yaml");
  console.log();
  ui.info("Next step: run `bender implement` to start executing the task plan.");
  ui.cleanup();
}
