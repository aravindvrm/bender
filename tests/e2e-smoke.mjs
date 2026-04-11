/**
 * End-to-end smoke test for bender.
 * Runs the clarifier → architect → planner pipeline non-interactively.
 *
 * Usage: OPENAI_API_KEY=... node tests/e2e-smoke.mjs
 */

import { readConfig, writeConfig } from "../dist/state/config.js";
import { StateManager } from "../dist/state/manager.js";
import { createModelSet, getModelForRole } from "../dist/llm/provider.js";
import { generateClarifyingQuestions, generateBrief } from "../dist/roles/clarifier.js";
import { generateArchitecture } from "../dist/roles/architect.js";
import { generateInitialPlan } from "../dist/roles/planner.js";
import { mkdirSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";

const TEST_DIR = "/tmp/bender-e2e-test";
const PROJECT_DESCRIPTION = "A simple SaaS for freelancers to create and send invoices to clients. Users can sign up, create invoices with line items, send them via email, and track payment status. Basic dashboard showing outstanding and paid invoices.";

async function main() {
  console.log("=== Bender E2E Smoke Test ===\n");

  // Clean up
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });

  // Initialize state
  const state = new StateManager(TEST_DIR);
  await state.init();

  // Write config for OpenAI
  const config = await readConfig(TEST_DIR);
  config.llm.provider = "openai";
  config.llm.models.fast = "gpt-4o-mini";
  config.llm.models.default = "gpt-4o-mini";
  config.llm.models.strong = "gpt-4o-mini";
  await writeConfig(TEST_DIR, config);

  const models = createModelSet(config);

  // Step 1: Clarification
  console.log("--- Step 1: Generating clarifying questions ---\n");
  const clarifierModel = getModelForRole(models, "clarifier");
  const questions = await generateClarifyingQuestions(
    clarifierModel,
    PROJECT_DESCRIPTION,
    null,
    (chunk) => process.stdout.write(chunk),
  );
  console.log("\n");

  // Simulate user answers
  const userAnswers = `
1. Primary users are solo freelancers (designers, developers, consultants). They are somewhat technical.
2. V1 core features: user auth, create/edit invoices with line items, send invoice via email, mark as paid/unpaid. Dashboard showing totals.
3. Deferred: Stripe payment integration, recurring invoices, expense tracking, multi-currency.
4. Key entities: User, Client, Invoice, LineItem.
5. Auth: email/password signup. No roles — each user sees only their own data.
6. No external integrations in v1 except email sending (use Resend).
7. Scale: under 1000 users. Basic postgres is fine.
  `.trim();

  // Step 2: Generate brief
  console.log("--- Step 2: Generating product brief ---\n");
  const brief = await generateBrief(
    clarifierModel,
    PROJECT_DESCRIPTION,
    [
      { role: "assistant", content: questions },
      { role: "user", content: userAnswers },
    ],
    null,
    (chunk) => process.stdout.write(chunk),
  );
  console.log("\n");
  await state.writeBrief(brief);
  console.log("  ✓ Brief saved to .bender/brief.md\n");

  // Step 3: Generate architecture
  console.log("--- Step 3: Generating architecture ---\n");
  const architectModel = getModelForRole(models, "architect");
  const architecture = await generateArchitecture(
    architectModel,
    brief,
    config,
    null,
    (chunk) => process.stdout.write(chunk),
  );
  console.log("\n");
  await state.writeArchitecture(architecture);

  // Extract and save schema
  const schemaMatch = architecture.match(/```sql\n([\s\S]*?)```/);
  if (schemaMatch) {
    await state.writeSchema(schemaMatch[1].trim());
    console.log("  ✓ Schema saved to .bender/schema.sql");
  }

  // Extract and save conventions
  const conventionsMatch = architecture.match(/##\s*Conventions\s*\n([\s\S]*?)(?=\n##|$)/);
  if (conventionsMatch) {
    await state.writeConventions(conventionsMatch[1].trim());
    console.log("  ✓ Conventions saved to .bender/conventions.md");
  }
  console.log("  ✓ Architecture saved to .bender/architecture.md\n");

  // Step 4: Generate task plan
  console.log("--- Step 4: Generating task plan ---\n");
  const plannerModel = getModelForRole(models, "planner");
  const plan = await generateInitialPlan(
    plannerModel,
    brief,
    architecture,
    (chunk) => process.stdout.write(chunk),
  );
  console.log("\n");
  await state.writeCurrentTasks(plan);
  console.log("  ✓ Task plan saved to .bender/tasks/current.md\n");

  // Summary
  console.log("=== Smoke Test Complete ===\n");
  console.log("Generated artifacts in", TEST_DIR + "/.bender/:");
  const { readdirSync } = await import("node:fs");
  const files = readdirSync(join(TEST_DIR, ".bender"));
  for (const f of files) {
    console.log(`  ${f}`);
  }
}

main().catch((err) => {
  console.error("\n\nFATAL:", err.message);
  if (err.message.includes("API key")) {
    console.error("Set OPENAI_API_KEY environment variable.");
  }
  process.exit(1);
});
