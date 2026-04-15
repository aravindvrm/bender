/**
 * Deterministic end-to-end smoke test for dashboard server + API surface.
 *
 * This test is offline-safe and uses built artifacts from dist/.
 * It verifies:
 * - Dashboard serves the built web app
 * - Core API state wiring works end-to-end
 * - Skills catalog/library create/import flows persist correctly
 * - Agents and eval configs can reference added skills
 *
 * Usage:
 *   npm run build && node tests/e2e-dashboard.mjs
 */

import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { createServer as createNetServer } from "node:net";
import { fileURLToPath } from "node:url";

async function reserveFreePort() {
  return await new Promise((resolvePort, rejectPort) => {
    const server = createNetServer();
    server.once("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => rejectPort(new Error("Failed to reserve free port")));
        return;
      }
      const port = address.port;
      server.close((err) => {
        if (err) rejectPort(err);
        else resolvePort(port);
      });
    });
  });
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function json(res) {
  try {
    return await res.json();
  } catch {
    return {};
  }
}

async function main() {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const distCli = join(repoRoot, "dist", "cli", "server.js");
  const distWebIndex = join(repoRoot, "dist", "web", "index.html");
  assert(existsSync(distCli), "dist/cli/server.js not found. Run `npm run build` first.");
  assert(existsSync(distWebIndex), "dist/web/index.html not found. Run `npm run build` first.");

  const tempProject = await mkdtemp(join(tmpdir(), "bender-e2e-project-"));
  const tempHome = await mkdtemp(join(tmpdir(), "bender-e2e-home-"));
  const importSource = await mkdtemp(join(tmpdir(), "bender-e2e-skill-source-"));
  process.env.BENDER_HOME_DIR = tempHome;

  let server = null;
  try {
    await mkdir(join(importSource, "references"), { recursive: true });
    await writeFile(join(importSource, "SKILL.md"), "# e2e-imported\n", "utf-8");
    await writeFile(join(importSource, "references", "guide.md"), "reference", "utf-8");

    const { startServer } = await import("../dist/cli/server.js");
    const port = await reserveFreePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    server = await startServer(tempProject, port);

    const indexRes = await fetch(`${baseUrl}/`);
    assert(indexRes.ok, `Expected GET / to succeed, got ${indexRes.status}`);
    const indexHtml = await indexRes.text();
    assert(indexHtml.includes("<!doctype html") || indexHtml.includes("<!DOCTYPE html"), "Dashboard HTML not served");

    const projectRes = await fetch(`${baseUrl}/api/project`);
    assert(projectRes.ok, `Expected GET /api/project to succeed, got ${projectRes.status}`);
    const projectBody = await json(projectRes);
    assert(projectBody.path === tempProject, "Project path mismatch from /api/project");

    const createSkillRes = await fetch(`${baseUrl}/api/skills/library/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scope: "project",
        name: "E2E Dashboard Skill",
        description: "E2E-created skill",
      }),
    });
    const createSkillBody = await json(createSkillRes);
    assert(createSkillRes.ok, `Expected create skill to succeed: ${createSkillBody.error ?? createSkillRes.status}`);

    const duplicateCreateRes = await fetch(`${baseUrl}/api/skills/library/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scope: "project",
        name: "E2E Dashboard Skill",
      }),
    });
    const duplicateCreateBody = await json(duplicateCreateRes);
    assert(duplicateCreateRes.status === 409, `Expected duplicate skill create to fail with 409, got ${duplicateCreateRes.status}: ${duplicateCreateBody.error ?? ""}`);

    const importSkillRes = await fetch(`${baseUrl}/api/skills/library/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scope: "project",
        sourcePath: importSource,
        name: "e2e-imported-skill",
      }),
    });
    const importSkillBody = await json(importSkillRes);
    assert(importSkillRes.ok, `Expected import skill to succeed: ${importSkillBody.error ?? importSkillRes.status}`);

    const catalogRes = await fetch(`${baseUrl}/api/skills/catalog`);
    const catalogBody = await json(catalogRes);
    assert(catalogRes.ok, `Expected catalog to succeed: ${catalogBody.error ?? catalogRes.status}`);
    const skillNames = new Set((catalogBody.skills ?? []).map((s) => s.name));
    assert(skillNames.has("e2e-dashboard-skill"), "Created skill missing from catalog");
    assert(skillNames.has("e2e-imported-skill"), "Imported skill missing from catalog");

    const createAgentRes = await fetch(`${baseUrl}/api/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "e2e-dashboard-agent",
        name: "E2E Dashboard Agent",
        baseRole: "implementer",
        modelTier: "default",
        pinnedSkills: ["e2e-dashboard-skill"],
        mcpServerIds: ["github"],
      }),
    });
    const createAgentBody = await json(createAgentRes);
    assert(createAgentRes.ok, `Expected create agent to succeed: ${createAgentBody.error ?? createAgentRes.status}`);

    const createEvalConfigRes = await fetch(`${baseUrl}/api/evals/configs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "E2E Eval Config",
        role: "implementer",
        modelTier: "default",
        pinnedSkills: ["e2e-imported-skill"],
        mcpServerIds: ["github"],
        enabled: true,
        successMode: "diff-generated",
      }),
    });
    const createEvalConfigBody = await json(createEvalConfigRes);
    assert(createEvalConfigRes.ok, `Expected create eval config to succeed: ${createEvalConfigBody.error ?? createEvalConfigRes.status}`);

    const runAnswerRes = await fetch(`${baseUrl}/api/run/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "missing", answer: "yes" }),
    });
    const runAnswerBody = await json(runAnswerRes);
    assert(runAnswerRes.status === 404, `Expected /api/run/answer missing id to return 404, got ${runAnswerRes.status}: ${runAnswerBody.error ?? ""}`);

    const runPlanMissingFeatureRes = await fetch(`${baseUrl}/api/run/plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const runPlanMissingFeatureBody = await json(runPlanMissingFeatureRes);
    assert(runPlanMissingFeatureRes.status === 400, `Expected /api/run/plan to require feature, got ${runPlanMissingFeatureRes.status}: ${runPlanMissingFeatureBody.error ?? ""}`);

    const fsInspectMissingPathRes = await fetch(`${baseUrl}/api/fs/inspect`);
    const fsInspectMissingPathBody = await json(fsInspectMissingPathRes);
    assert(fsInspectMissingPathRes.status === 400, `Expected /api/fs/inspect missing path to return 400, got ${fsInspectMissingPathRes.status}: ${fsInspectMissingPathBody.error ?? ""}`);

    const badTaskGitHubRes = await fetch(`${baseUrl}/api/tasks/not-a-number/github/issue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const badTaskGitHubBody = await json(badTaskGitHubRes);
    assert(badTaskGitHubRes.status === 400, `Expected non-numeric taskId to return 400, got ${badTaskGitHubRes.status}: ${badTaskGitHubBody.error ?? ""}`);

    assert(existsSync(join(tempProject, ".bender", "skills", "e2e-dashboard-skill", "SKILL.md")), "Created skill file missing");
    assert(existsSync(join(tempProject, ".bender", "skills", "e2e-imported-skill", "SKILL.md")), "Imported skill file missing");

    console.log("E2E_DASHBOARD_SMOKE_OK");
    console.log(`project=${tempProject}`);
    console.log(`skills=${(catalogBody.skills ?? []).length}`);
  } finally {
    if (server?.listening) {
      await new Promise((resolveClose, rejectClose) => {
        server.close((err) => {
          if (err) rejectClose(err);
          else resolveClose();
        });
      });
    }
    await rm(tempProject, { recursive: true, force: true });
    await rm(tempHome, { recursive: true, force: true });
    await rm(importSource, { recursive: true, force: true });
    delete process.env.BENDER_HOME_DIR;
  }
}

main().catch((err) => {
  console.error("E2E_DASHBOARD_SMOKE_FAILED");
  console.error(err?.stack || String(err));
  process.exit(1);
});
