import { readEffectiveConfig, writeConfig } from "../state/config.js";
import { StateManager } from "../state/manager.js";
import { createModelSet } from "../llm/provider.js";
import { getModelForTier } from "../llm/provider.js";
import {
  scanCodebase,
  analyzeCodebase,
  parseAnalysisOutput,
  type AnalysisResult,
} from "../roles/analyzer.js";
import { GitOperations } from "../git/operations.js";
import { terminalAdapter, type UIAdapter } from "./adapter.js";
import { createRoleRuntime, type RoleRuntime } from "../llm/runtime.js";
import { getEffectiveAgentForRole } from "../state/agents.js";
import { createLogger, logError, makeAdapterSink, toLoggerOptions } from "../logger.js";

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
  const logger = createLogger(
    "analyze",
    projectRoot,
    makeAdapterSink(adapter),
    toLoggerOptions(config.logging),
  );
  const startTime = Date.now();
  logger.info("Starting analysis");

  let models;
  try {
    models = createModelSet(config);
  } catch (err: unknown) {
    logError(logger, "Failed to initialize LLM provider for analyze", err);
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
    logError(logger, "Codebase scan failed during analyze", err, { projectRoot });
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
        capabilityPolicy: analyzerAgent.capabilityPolicy,
        modelTier: analyzerAgent.modelTier,
        systemPromptAddition: analyzerAgent.systemPromptAddition,
      },
      undefined,
      logger,
    );
  } catch (err: unknown) {
    logError(logger, "Failed to initialize runtime for analyze", err, {
      role: "analyzer",
      projectRoot,
    });
    adapter.error(`Failed to initialize MCP/skills runtime: ${(err as Error).message}`);
    adapter.cleanup();
    return;
  }

  // Use the strong model — analysis is a one-shot expensive operation
  let rawOutput: string;
  let streamedChars = 0;
  try {
    adapter.info(`Using agent: ${analyzerAgent.name} (${analyzerAgent.modelTier})`);
    const writeChunk = adapter.streamWriter();
    rawOutput = await analyzeCodebase(
      getModelForTier(models, analyzerAgent.modelTier),
      projectRoot,
      summary,
      (chunk) => {
        streamedChars += chunk.length;
        writeChunk(chunk);
      },
      runtime,
    );
  } catch (err: unknown) {
    logError(logger, "Analyzer role execution failed", err, {
      role: "analyzer",
      agentName: analyzerAgent.name,
      modelTier: analyzerAgent.modelTier,
    });
    adapter.error(`Analysis failed: ${(err as Error).message}`);
    adapter.cleanup();
    return;
  } finally {
    await runtime.close();
  }

  const normalizedOutput = rawOutput.trim();
  if (!normalizedOutput) {
    adapter.error("Analysis failed: analyzer returned an empty response.");
    adapter.error("This usually means the active model/provider did not return usable text. Check provider settings and retry.");
    adapter.cleanup();
    return;
  }

  if (streamedChars === 0) {
    adapter.info("Analyzer completed without streamed chunks; showing output preview:");
    adapter.info(`${normalizedOutput.slice(0, 600)}${normalizedOutput.length > 600 ? "…" : ""}`);
  }

  let parsed: AnalysisResult;
  try {
    parsed = parseAnalysisOutput(rawOutput);
  } catch (err: unknown) {
    logError(logger, "Failed to parse analyzer output", err, {
      outputPreview: normalizedOutput.slice(0, 1000),
      outputChars: normalizedOutput.length,
    });
    adapter.error(`Analysis failed: ${(err as Error).message}`);
    adapter.cleanup();
    return;
  }

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
  if (parsed.apiContracts) await state.writeApiContracts(parsed.apiContracts);

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

  logger.info("Analysis complete", {
    elapsedMs: Date.now() - startTime,
    hasBrief: true,
    hasConventions: !!parsed.conventions,
    hasSchema: !!parsed.schema,
    hasApiContracts: !!parsed.apiContracts,
  });

  adapter.header("Analysis Complete");
  adapter.success("Brief:         .bender/brief.md");
  adapter.success("Architecture:  .bender/architecture.md");
  if (parsed.conventions) adapter.success("Conventions:   .bender/conventions.md");
  if (parsed.schema) adapter.success("Schema:        .bender/schema.sql");
  if (parsed.apiContracts) adapter.success("API Contracts: .bender/api-contracts/routes.yaml");
  adapter.info("Run `bender plan` to plan your next change, or `bender bend` (`npm run bend` in local dev) to launch the dashboard.");
  adapter.cleanup();
}
