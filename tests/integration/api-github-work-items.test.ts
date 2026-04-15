import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

describe("api github work-items routes", () => {
  let tempProject = "";
  let tempBenderHome = "";
  let server: HttpServer | null = null;
  let baseUrl = "";

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
    delete process.env.BENDER_HOME_DIR;
  });

  it("rejects work-item routes when no project is selected", async () => {
    vi.resetModules();
    tempBenderHome = await mkdtemp(join(tmpdir(), "bender-home-gh-work-items-none-"));
    process.env.BENDER_HOME_DIR = tempBenderHome;

    const { startServer } = await import("../../src/cli/server.js");
    const port = await reserveFreePort();
    server = await startServer(undefined, port);
    baseUrl = `http://127.0.0.1:${port}`;

    const response = await fetch(`${baseUrl}/api/github/work-items`);
    expect(response.status).toBe(400);
    const body = await response.json() as { error?: string };
    expect(body.error).toBe("No project selected");

    await new Promise<void>((resolve, reject) => {
      server?.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    server = null;
    await rm(tempBenderHome, { recursive: true, force: true });
    tempBenderHome = "";
    delete process.env.BENDER_HOME_DIR;
  });

  it("returns actionable error when project has no linked repo", async () => {
    vi.resetModules();
    tempProject = await mkdtemp(join(tmpdir(), "bender-gh-work-items-project-"));
    tempBenderHome = await mkdtemp(join(tmpdir(), "bender-home-gh-work-items-project-"));
    process.env.BENDER_HOME_DIR = tempBenderHome;
    await writeFile(join(tempBenderHome, "github-session.json"), JSON.stringify({ accessToken: "fake-token" }), "utf-8");

    const { startServer } = await import("../../src/cli/server.js");
    const port = await reserveFreePort();
    server = await startServer(tempProject, port);
    baseUrl = `http://127.0.0.1:${port}`;

    const response = await fetch(`${baseUrl}/api/github/work-items`);
    expect(response.status).toBe(400);
    const body = await response.json() as { error?: string };
    expect(body.error).toContain("Set linked repo first");

    await new Promise<void>((resolve, reject) => {
      server?.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    server = null;
    await rm(tempProject, { recursive: true, force: true });
    await rm(tempBenderHome, { recursive: true, force: true });
    tempProject = "";
    tempBenderHome = "";
    delete process.env.BENDER_HOME_DIR;
  });

  it("imports accepted candidates into the current task plan", async () => {
    vi.resetModules();
    tempProject = await mkdtemp(join(tmpdir(), "bender-gh-work-items-import-"));
    tempBenderHome = await mkdtemp(join(tmpdir(), "bender-home-gh-work-items-import-"));
    process.env.BENDER_HOME_DIR = tempBenderHome;

    const { startServer } = await import("../../src/cli/server.js");
    const port = await reserveFreePort();
    server = await startServer(tempProject, port);
    baseUrl = `http://127.0.0.1:${port}`;

    const seedTask = await fetch(`${baseUrl}/api/tasks/append`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Seed task",
        description: "Initial task so repo can be inferred from links",
      }),
    });
    expect(seedTask.ok).toBe(true);

    const linkSeedTask = await fetch(`${baseUrl}/api/tasks/links/1`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repoFullName: "acme/repo",
        issueNumber: 1,
        issueUrl: "https://github.com/acme/repo/issues/1",
      }),
    });
    expect(linkSeedTask.ok).toBe(true);

    const importResponse = await fetch(`${baseUrl}/api/github/work-items/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        candidates: [{
          id: "candidate-2",
          sourceType: "issue",
          sourceIssueNumber: 2,
          sourceIssueUrl: "https://github.com/acme/repo/issues/2",
          sourceTitle: "Implement import flow",
          repoFullName: "acme/repo",
          title: "Implement issue import",
          description: "Add review-driven import flow.",
          dependencies: "1",
          acceptanceCriteria: "Imported tasks linked to source issue",
          suggestedFiles: ["src/cli/services/github-work-items.ts"],
        }],
      }),
    });

    expect(importResponse.ok).toBe(true);
    const importBody = await importResponse.json() as {
      imported?: Array<{ candidateId: string; taskId: number; issueNumber: number }>;
    };
    expect(importBody.imported).toEqual([
      { candidateId: "candidate-2", taskId: 2, issueNumber: 2 },
    ]);

    const linksResponse = await fetch(`${baseUrl}/api/tasks/links`);
    expect(linksResponse.ok).toBe(true);
    const linksBody = await linksResponse.json() as {
      links?: Record<string, { issueNumber?: number; repoFullName?: string }>;
    };
    expect(linksBody.links?.["2"]?.repoFullName).toBe("acme/repo");
    expect(linksBody.links?.["2"]?.issueNumber).toBe(2);

    const stateResponse = await fetch(`${baseUrl}/api/state`);
    expect(stateResponse.ok).toBe(true);
    const stateBody = await stateResponse.json() as { currentTasks?: string | null };
    expect(stateBody.currentTasks ?? "").toContain("### Task 2: Implement issue import");

    await new Promise<void>((resolve, reject) => {
      server?.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    server = null;
    await rm(tempProject, { recursive: true, force: true });
    await rm(tempBenderHome, { recursive: true, force: true });
    tempProject = "";
    tempBenderHome = "";
    delete process.env.BENDER_HOME_DIR;
  });
});

