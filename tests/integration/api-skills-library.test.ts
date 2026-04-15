import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server as HttpServer } from "node:http";

async function reserveFreePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to reserve free port")));
        return;
      }
      const port = address.port;
      server.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
  });
}

describe("api skills catalog + library extension", () => {
  let tempProject = "";
  let tempBenderHome = "";
  let importSourceSkillDir = "";
  let server: HttpServer | null = null;
  let baseUrl = "";

  beforeAll(async () => {
    tempProject = await mkdtemp(join(tmpdir(), "bender-api-skills-project-"));
    tempBenderHome = await mkdtemp(join(tmpdir(), "bender-api-skills-home-"));
    importSourceSkillDir = await mkdtemp(join(tmpdir(), "bender-api-skills-source-"));

    process.env.BENDER_HOME_DIR = tempBenderHome;

    // Seed curated registry cache to keep tests deterministic/offline-safe.
    const cacheDir = join(tempBenderHome, "skills-cache");
    await mkdir(cacheDir, { recursive: true });
    await writeFile(
      join(cacheDir, "registry.json"),
      JSON.stringify({
        fetchedAt: Date.now(),
        skills: [
          {
            name: "seed-curated-skill",
            description: "Seed curated skill for integration tests",
            size: 123,
          },
        ],
      }),
      "utf-8",
    );

    await mkdir(join(importSourceSkillDir, "references"), { recursive: true });
    await writeFile(join(importSourceSkillDir, "SKILL.md"), "# imported-source\n", "utf-8");
    await writeFile(join(importSourceSkillDir, "references", "guide.md"), "hello", "utf-8");

    const { startServer } = await import("../../src/cli/server.js");
    const port = await reserveFreePort();
    server = await startServer(tempProject, port);
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    if (server?.listening) {
      await new Promise<void>((resolve, reject) => {
        server?.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    }
    if (tempProject) {
      await rm(tempProject, { recursive: true, force: true });
    }
    if (tempBenderHome) {
      await rm(tempBenderHome, { recursive: true, force: true });
    }
    if (importSourceSkillDir) {
      await rm(importSourceSkillDir, { recursive: true, force: true });
    }
    delete process.env.BENDER_HOME_DIR;
  });

  it("returns catalog with summary and runtime curated pool metadata", async () => {
    const res = await fetch(`${baseUrl}/api/skills/catalog`);
    expect(res.ok).toBe(true);
    const body = await res.json() as {
      skills?: Array<{ name?: string; source?: string }>;
      summary?: {
        total?: number;
        curated?: number;
        user?: number;
        project?: number;
        runtimeCuratedPool?: number;
      };
    };

    expect(Array.isArray(body.skills)).toBe(true);
    expect(typeof body.summary?.total).toBe("number");
    expect(typeof body.summary?.curated).toBe("number");
    expect(typeof body.summary?.user).toBe("number");
    expect(typeof body.summary?.project).toBe("number");
    expect(typeof body.summary?.runtimeCuratedPool).toBe("number");
    expect((body.summary?.runtimeCuratedPool ?? 0) > 0).toBe(true);
  });

  it("creates project/user skill packages and exposes them in catalog", async () => {
    const projectCreateRes = await fetch(`${baseUrl}/api/skills/library/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scope: "project",
        name: "API Contract QA",
        description: "Contract checks and schema drift detection",
      }),
    });
    expect(projectCreateRes.ok).toBe(true);
    const projectCreateBody = await projectCreateRes.json() as { name?: string; path?: string; scope?: string };
    expect(projectCreateBody.scope).toBe("project");
    expect(projectCreateBody.name).toBe("api-contract-qa");
    expect(existsSync(join(tempProject, ".bender", "skills", "api-contract-qa", "SKILL.md"))).toBe(true);

    const projectSkillContent = await readFile(join(tempProject, ".bender", "skills", "api-contract-qa", "SKILL.md"), "utf-8");
    expect(projectSkillContent).toContain("Contract checks and schema drift detection");

    const userCreateRes = await fetch(`${baseUrl}/api/skills/library/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scope: "user",
        name: "Global Team Skill",
      }),
    });
    expect(userCreateRes.ok).toBe(true);
    const userCreateBody = await userCreateRes.json() as { name?: string; scope?: string };
    expect(userCreateBody.scope).toBe("user");
    expect(userCreateBody.name).toBe("global-team-skill");
    expect(existsSync(join(tempBenderHome, "skills", "global-team-skill", "SKILL.md"))).toBe(true);

    const catalogRes = await fetch(`${baseUrl}/api/skills/catalog`);
    expect(catalogRes.ok).toBe(true);
    const catalogBody = await catalogRes.json() as {
      skills?: Array<{
        name: string;
        source: "curated" | "user" | "project";
        defaultPinnedRoles: string[];
        runtimeBaselineRoles: string[];
        defaultRuntimeEnabled: boolean;
      }>;
    };

    const projectSkill = (catalogBody.skills ?? []).find((skill) => skill.name === "api-contract-qa");
    const userSkill = (catalogBody.skills ?? []).find((skill) => skill.name === "global-team-skill");

    expect(projectSkill?.source).toBe("project");
    expect(userSkill?.source).toBe("user");
    expect(Array.isArray(projectSkill?.defaultPinnedRoles)).toBe(true);
    expect(Array.isArray(projectSkill?.runtimeBaselineRoles)).toBe(true);
    expect(projectSkill?.defaultRuntimeEnabled).toBe(false);
  });

  it("imports skill packages and returns expected validation errors for duplicate/invalid requests", async () => {
    const importRes = await fetch(`${baseUrl}/api/skills/library/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scope: "project",
        sourcePath: importSourceSkillDir,
        name: "imported-skill-bundle",
      }),
    });
    expect(importRes.ok).toBe(true);
    const importBody = await importRes.json() as { name?: string; scope?: string };
    expect(importBody.scope).toBe("project");
    expect(importBody.name).toBe("imported-skill-bundle");
    expect(existsSync(join(tempProject, ".bender", "skills", "imported-skill-bundle", "SKILL.md"))).toBe(true);
    expect(existsSync(join(tempProject, ".bender", "skills", "imported-skill-bundle", "references", "guide.md"))).toBe(true);

    const duplicateImportRes = await fetch(`${baseUrl}/api/skills/library/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scope: "project",
        sourcePath: importSourceSkillDir,
        name: "imported-skill-bundle",
      }),
    });
    expect(duplicateImportRes.status).toBe(409);
    const duplicateBody = await duplicateImportRes.json() as { error?: string };
    expect(duplicateBody.error).toContain("already exists");

    const missingSourceRes = await fetch(`${baseUrl}/api/skills/library/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scope: "project",
      }),
    });
    expect(missingSourceRes.status).toBe(400);
    const missingSourceBody = await missingSourceRes.json() as { error?: string };
    expect(missingSourceBody.error).toContain("sourcePath is required");
  });
});

describe("api skills library project scope validation without selected project", () => {
  let tempBenderHome = "";
  let importSourceSkillDir = "";
  let server: HttpServer | null = null;
  let baseUrl = "";

  beforeAll(async () => {
    vi.resetModules();

    tempBenderHome = await mkdtemp(join(tmpdir(), "bender-api-skills-home-noproject-"));
    importSourceSkillDir = await mkdtemp(join(tmpdir(), "bender-api-skills-source-noproject-"));

    process.env.BENDER_HOME_DIR = tempBenderHome;

    await mkdir(join(importSourceSkillDir, "references"), { recursive: true });
    await writeFile(join(importSourceSkillDir, "SKILL.md"), "# imported-source\n", "utf-8");
    await writeFile(join(importSourceSkillDir, "references", "guide.md"), "hello", "utf-8");

    const cacheDir = join(tempBenderHome, "skills-cache");
    await mkdir(cacheDir, { recursive: true });
    await writeFile(
      join(cacheDir, "registry.json"),
      JSON.stringify({
        fetchedAt: Date.now(),
        skills: [],
      }),
      "utf-8",
    );

    const { startServer } = await import("../../src/cli/server.js");
    const port = await reserveFreePort();
    server = await startServer(undefined, port);
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    if (server?.listening) {
      await new Promise<void>((resolve, reject) => {
        server?.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    }
    if (tempBenderHome) {
      await rm(tempBenderHome, { recursive: true, force: true });
    }
    if (importSourceSkillDir) {
      await rm(importSourceSkillDir, { recursive: true, force: true });
    }
    delete process.env.BENDER_HOME_DIR;
  });

  it("rejects project scope create/import requests with no project selected", async () => {
    const createRes = await fetch(`${baseUrl}/api/skills/library/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scope: "project",
        name: "no-project-skill",
      }),
    });
    expect(createRes.status).toBe(400);
    const createBody = await createRes.json() as { error?: string };
    expect(createBody.error).toBe("Project scope requires an open project");

    const importRes = await fetch(`${baseUrl}/api/skills/library/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scope: "project",
        sourcePath: importSourceSkillDir,
        name: "no-project-import",
      }),
    });
    expect(importRes.status).toBe(400);
    const importBody = await importRes.json() as { error?: string };
    expect(importBody.error).toBe("Project scope requires an open project");
  });
});
