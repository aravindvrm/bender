import { readEffectiveConfig, writeConfig } from "../state/config.js";
import { StateManager } from "../state/manager.js";
import { createModelSet } from "../llm/provider.js";
import { getModelForTier } from "../llm/provider.js";
import { scanCodebase, analyzeCodebase, parseAnalysisOutput } from "../roles/analyzer.js";
import { GitOperations } from "../git/operations.js";
import { terminalAdapter, type UIAdapter } from "./adapter.js";
import { createRoleRuntime, type RoleRuntime } from "../llm/runtime.js";
import { getEffectiveAgentForRole } from "../state/agents.js";

export async function analyzeCommand(projectRoot: string, adapter: UIAdapter = terminalAdapter): Promise<void> {
  adapter.header("Bender Analyze — Existing Project");

  const state = new StateManager(projectRoot);

  if (state.isInitialized()) {
    const proceed = await adapter.confirm(
      "This project already has a .bender/ directory. Re-analyzing will overwrite existing brief and architecture. Continue?",
      false,
    );
    if (!proceed) {
      adapter.info("Cancelled.");
      adapter.cleanup();
      return;
    }
  }

  const config = await readEffectiveConfig(projectRoot);

  let models;
  try {
    models = createModelSet(config);
  } catch (err: unknown) {
    adapter.error(`Failed to initialize LLM provider: ${(err as Error).message}`);
    adapter.error("Configure your API key in Settings first.");
    adapter.cleanup();
    return;
  }

  // Step 1: Scan the codebase
  adapter.subheader("Step 1: Scanning Codebase");
  const scanSpin = adapter.spinner("Reading file structure...");
  scanSpin.start();

  let summary;
  try {
    summary = await scanCodebase(projectRoot);
    scanSpin.succeed(`Found ${summary.totalFiles} source files (${summary.languages.join(", ") || "unknown language"})`);
  } catch (err: unknown) {
    scanSpin.fail(`Scan failed: ${(err as Error).message}`);
    adapter.cleanup();
    return;
  }

  adapter.info(`Reading ${summary.keyFiles.length} key files for analysis...`);

  // Step 2: LLM analysis
  adapter.subheader("Step 2: Analyzing");
  adapter.info("Generating project brief and architecture from existing code...\n");

  const analyzerAgent = await getEffectiveAgentForRole("analyzer");
  let runtime: RoleRuntime;
  try {
    runtime = await createRoleRuntime(
      projectRoot,
      config,
      {
        role: "analyzer",
        pinnedSkills: analyzerAgent.pinnedSkills,
        mcpServerIds: analyzerAgent.mcpServerIds,
        modelTier: analyzerAgent.modelTier,
      },
      undefined,
      { info: (msg) => adapter.info(msg), warn: (msg) => adapter.warn(msg) },
    );
  } catch (err: unknown) {
    adapter.error(`Failed to initialize MCP/skills runtime: ${(err as Error).message}`);
    adapter.cleanup();
    return;
  }

  // Use the strong model — analysis is a one-shot expensive operation
  let rawOutput: string;
  try {
    adapter.info(`Using agent: ${analyzerAgent.name} (${analyzerAgent.modelTier})`);
    rawOutput = await analyzeCodebase(
      getModelForTier(models, analyzerAgent.modelTier),
      projectRoot,
      summary,
      adapter.streamWriter(),
      runtime,
    );
  } catch (err: unknown) {
    adapter.error(`Analysis failed: ${(err as Error).message}`);
    adapter.cleanup();
    return;
  } finally {
    await runtime.close();
  }

  const parsed = parseAnalysisOutput(rawOutput);

  // Step 3: Review and approve
  adapter.subheader("Step 3: Review");

  const approved = await adapter.confirm(
    "Save this analysis as your project's .bender/ state?",
  );

  if (!approved) {
    adapter.info("Cancelled. No files written.");
    adapter.cleanup();
    return;
  }

  // Step 4: Write .bender/ state
  adapter.subheader("Step 4: Writing State");
  const writeSpin = adapter.spinner("Initializing .bender/ directory...");
  writeSpin.start();

  await state.init();
  await writeConfig(projectRoot, config);

  await state.writeBrief(parsed.brief);
  await state.writeArchitecture(parsed.architecture);
  if (parsed.conventions) await state.writeConventions(parsed.conventions);
  if (parsed.schema) await state.writeSchema(parsed.schema);

  // Write session log
  await state.writeSession(
    "analyze",
    `# Analyze Session\n\nDate: ${new Date().toISOString()}\n\nProject: ${projectRoot}\n\nFiles scanned: ${summary.totalFiles}\nKey files read: ${summary.keyFiles.length}\n\nStatus: completed`,
  );

  writeSpin.succeed("Project state written.");

  // Optionally init git if not already a repo
  const git = new GitOperations(projectRoot);
  if (!(await git.isRepo())) {
    const initGit = await adapter.confirm(
      "No git repo found. Initialize one and commit the .bender/ state?",
      true,
    );
    if (initGit) {
      await git.init();
      await git.commitAll("chore: add bender project analysis");
      adapter.success("Git repository initialized.");
    }
  }

  adapter.header("Analysis Complete");
  adapter.success("Brief:         .bender/brief.md");
  adapter.success("Architecture:  .bender/architecture.md");
  if (parsed.conventions) adapter.success("Conventions:   .bender/conventions.md");
  if (parsed.schema) adapter.success("Schema:        .bender/schema.sql");
  adapter.info("Run `bender plan` to plan your next change, or `bender bend` (`npm run bend` in local dev) to launch the dashboard.");
  adapter.cleanup();
}
