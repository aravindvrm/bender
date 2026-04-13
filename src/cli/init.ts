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
import { terminalAdapter, type UIAdapter } from "./adapter.js";
import { createRoleRuntime, type RoleRuntime } from "../llm/runtime.js";

export async function initCommand(projectRoot: string, adapter: UIAdapter = terminalAdapter): Promise<void> {
  adapter.header("Bender Init — New Project Setup");

  // Check if already initialized
  const state = new StateManager(projectRoot);
  if (state.isInitialized()) {
    const proceed = await adapter.confirm(
      "A .bender/ directory already exists. Re-initialize will overwrite existing state. Continue?",
      false,
    );
    if (!proceed) {
      adapter.info("Cancelled.");
      adapter.cleanup();
      return;
    }
  }

  // Step 1: Get project description from user
  adapter.subheader("Step 1: Describe Your Project");
  adapter.info("Tell me what you want to build. Be as detailed or as vague as you like —");
  adapter.info("the system will ask clarifying questions next.\n");

  const description = await adapter.promptMultiline(">");

  if (!description) {
    adapter.error("No description provided. Aborting.");
    adapter.cleanup();
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
    adapter.error(`Failed to initialize LLM provider: ${(err as Error).message}`);
    adapter.error("Check your .bender/config.yaml and ensure API keys are set.");
    adapter.cleanup();
    return;
  }

  // Step 2: Clarification
  let runtime: RoleRuntime;
  try {
    runtime = await createRoleRuntime(projectRoot, config, {
      info: (msg) => adapter.info(msg),
      warn: (msg) => adapter.warn(msg),
    });
  } catch (err: unknown) {
    adapter.error(`Failed to initialize MCP/skills runtime: ${(err as Error).message}`);
    adapter.cleanup();
    return;
  }

  try {
    adapter.subheader("Step 2: Clarification");
    adapter.info("Generating clarifying questions...\n");

    const clarifierModel = getModelForRole(models, "clarifier");
    const questions = await generateClarifyingQuestions(
      clarifierModel,
      description,
      null,
      adapter.streamWriter(),
      runtime,
    );

    const answers = await adapter.promptMultiline("Answer the questions above (or leave blank for defaults):");

    const clarificationQA: { role: "user" | "assistant"; content: string }[] = [
      { role: "assistant", content: questions },
      { role: "user", content: answers || "(No additional answers provided — use reasonable defaults)" },
    ];

    // Step 3: Generate product brief
    adapter.subheader("Step 3: Product Brief");
    const spin = adapter.spinner("Generating product brief...");
    spin.start();

    const brief = await generateBrief(clarifierModel, description, clarificationQA, null, undefined, runtime);
    spin.succeed("Brief generated");

    adapter.info(brief);

    const briefApproved = await adapter.confirm("Approve this product brief?");
    if (!briefApproved) {
      adapter.info("You can edit .bender/brief.md manually and re-run `bender init`.");
      await state.writeBrief(brief);
      adapter.cleanup();
      return;
    }

    await state.writeBrief(brief);
    adapter.success("Product brief saved.");

    // Step 4: Generate architecture
    adapter.subheader("Step 4: Architecture");
    adapter.info("Generating architecture document...\n");

    const architectModel = getModelForRole(models, "architect");
    const architecture = await generateArchitecture(
      architectModel,
      brief,
      config,
      null,
      adapter.streamWriter(),
      runtime,
    );

    const archApproved = await adapter.confirm("Approve this architecture?");
    if (!archApproved) {
      adapter.info("You can edit .bender/architecture.md manually and re-run `bender plan`.");
      await state.writeArchitecture(architecture);
      adapter.cleanup();
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

    adapter.success("Architecture saved.");

    // Step 5: Generate task plan
    adapter.subheader("Step 5: Task Plan");
    adapter.info("Generating implementation plan...\n");

    const plannerModel = getModelForRole(models, "planner");
    const plan = await generateInitialPlan(plannerModel, brief, architecture, adapter.streamWriter(), runtime);

    const planApproved = await adapter.confirm("Approve this task plan?");
    if (!planApproved) {
      adapter.info("You can edit .bender/tasks/current.md and run `bender implement`.");
      await state.writeCurrentTasks(plan);
      adapter.cleanup();
      return;
    }

    await state.writeCurrentTasks(plan);
    adapter.success("Task plan saved.");

    // Step 6: Git initialization
    const git = new GitOperations(projectRoot);
    await git.init();
    await git.commitAll("chore: initialize bender project state");

    // Write session log
    await state.writeSession("init", `# Init Session\n\nDate: ${new Date().toISOString()}\n\nProject: ${description.slice(0, 100)}\n\nStatus: completed`);

    // Summary
    adapter.header("Project Initialized");
    adapter.success("Product brief:     .bender/brief.md");
    adapter.success("Architecture:      .bender/architecture.md");
    adapter.success("Conventions:       .bender/conventions.md");
    adapter.success("Schema:            .bender/schema.sql");
    adapter.success("Task plan:         .bender/tasks/current.md");
    adapter.success("Config:            .bender/config.yaml");
    adapter.info("Next step: run `bender implement` to start executing the task plan.");
    adapter.cleanup();
  } finally {
    await runtime.close();
  }
}
