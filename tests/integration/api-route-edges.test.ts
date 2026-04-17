import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

interface LogEntry {
  timestamp: string;
  level: "debug" | "info" | "warn" | "error";
  component: string;
  message: string;
  data?: Record<string, unknown>;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForLog(
  baseUrl: string,
  matcher: (entry: LogEntry) => boolean,
  attempts = 25,
): Promise<LogEntry> {
  for (let i = 0; i < attempts; i += 1) {
    const res = await fetch(`${baseUrl}/api/logs?limit=500`);
    if (res.ok) {
      const body = await res.json() as { entries?: LogEntry[] };
      const found = (body.entries ?? []).find(matcher);
      if (found) return found;
    }
    await sleep(60);
  }
  throw new Error("Timed out waiting for structured log entry");
}

describe("api route edge validations (project selected)", () => {
  let tempProject = "";
  let tempBenderHome = "";
  let server: HttpServer | null = null;
  let baseUrl = "";

  beforeAll(async () => {
    tempProject = await mkdtemp(join(tmpdir(), "bender-api-routes-project-"));
    tempBenderHome = await mkdtemp(join(tmpdir(), "bender-api-routes-home-"));
    process.env.BENDER_HOME_DIR = tempBenderHome;

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
    delete process.env.BENDER_HOME_DIR;
  });

  it("validates /api/run payload guards", async () => {
    const answerRes = await fetch(`${baseUrl}/api/run/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "missing", answer: "yes" }),
    });
    expect(answerRes.status).toBe(404);
    const answerBody = await answerRes.json() as { error?: string };
    expect(answerBody.error).toContain("No pending question");

    const planRes = await fetch(`${baseUrl}/api/run/plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(planRes.status).toBe(400);
    const planBody = await planRes.json() as { error?: string };
    expect(planBody.error).toBe("feature is required");
  });

  it("exposes /api/health for desktop readiness checks", async () => {
    const health = await fetch(`${baseUrl}/api/health`);
    expect(health.ok).toBe(true);
    const body = await health.json() as { ok?: boolean };
    expect(body.ok).toBe(true);
  });

  it("persists API request logs with status and path metadata", async () => {
    await mkdir(join(tempProject, ".bender"), { recursive: true });
    const failingRes = await fetch(`${baseUrl}/api/run/plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(failingRes.status).toBe(400);

    const entry = await waitForLog(
      baseUrl,
      (log) => (
        log.component === "api"
        && log.message === "API request completed with client error"
        && log.data?.path === "/api/run/plan"
        && log.data?.statusCode === 400
      ),
    );
    expect(entry.level).toBe("warn");
  });

  it("accepts client diagnostics logs and stores them in project log file", async () => {
    await mkdir(join(tempProject, ".bender"), { recursive: true });
    const marker = `mermaid-parse-${Date.now()}`;
    const postRes = await fetch(`${baseUrl}/api/logs/client`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        component: "mermaid",
        level: "error",
        message: marker,
        data: { section: "architecture" },
      }),
    });
    expect(postRes.ok).toBe(true);

    const entry = await waitForLog(
      baseUrl,
      (log) => (
        log.component === "ui:mermaid"
        && log.message === marker
      ),
    );
    expect(entry.level).toBe("error");
    expect(entry.data?.section).toBe("architecture");
  });

  it("validates /api/fs guardrails", async () => {
    const inspectMissingPath = await fetch(`${baseUrl}/api/fs/inspect`);
    expect(inspectMissingPath.status).toBe(400);
    const inspectBody = await inspectMissingPath.json() as { error?: string };
    expect(inspectBody.error).toBe("path required");

    const browseMissing = await fetch(`${baseUrl}/api/fs/browse?path=${encodeURIComponent(join(tempProject, "missing"))}`);
    expect(browseMissing.status).toBe(400);
    const browseBody = await browseMissing.json() as { error?: string };
    expect(browseBody.error).toBe("Path does not exist");
  });

  it("validates /api/git errors and payload requirements", async () => {
    const branchesBeforeInit = await fetch(`${baseUrl}/api/git/branches`);
    expect(branchesBeforeInit.status).toBe(400);
    const branchesBeforeInitBody = await branchesBeforeInit.json() as { error?: string };
    expect(branchesBeforeInitBody.error).toBe("Not a git repository");

    const initRes = await fetch(`${baseUrl}/api/git/init`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ force: true }),
    });
    expect(initRes.ok).toBe(true);

    const checkoutMissingBranch = await fetch(`${baseUrl}/api/git/checkout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(checkoutMissingBranch.status).toBe(400);
    const checkoutBody = await checkoutMissingBranch.json() as { error?: string };
    expect(checkoutBody.error).toBe("branch is required");

    const stageMissingPath = await fetch(`${baseUrl}/api/git/stage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(stageMissingPath.status).toBe(400);
    const stageBody = await stageMissingPath.json() as { error?: string };
    expect(stageBody.error).toBe("path or all required");

    const commitMissingMessage = await fetch(`${baseUrl}/api/git/commit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(commitMissingMessage.status).toBe(400);
    const commitBody = await commitMissingMessage.json() as { error?: string };
    expect(commitBody.error).toBe("message is required");

    const diffNoHistory = await fetch(`${baseUrl}/api/git/diff?commits=1`);
    expect(diffNoHistory.ok).toBe(true);
    const diffNoHistoryBody = await diffNoHistory.json() as { diff?: string | null };
    expect(typeof diffNoHistoryBody.diff).toBe("string");

    const setIdentity = await fetch(`${baseUrl}/api/git/identity`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Bender Test", email: "bender-test@example.com" }),
    });
    expect(setIdentity.ok).toBe(true);

    const seedFile = join(tempProject, "hello.txt");
    await writeFile(seedFile, "hello from bender\n", "utf-8");

    const stageAll = await fetch(`${baseUrl}/api/git/stage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ all: true }),
    });
    expect(stageAll.ok).toBe(true);

    const commitFirst = await fetch(`${baseUrl}/api/git/commit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "chore: first commit" }),
    });
    expect(commitFirst.ok).toBe(true);

    const diffSingleCommit = await fetch(`${baseUrl}/api/git/diff?commits=1`);
    expect(diffSingleCommit.ok).toBe(true);
    const diffSingleCommitBody = await diffSingleCommit.json() as { diff?: string | null };
    expect(typeof diffSingleCommitBody.diff).toBe("string");
    expect(diffSingleCommitBody.diff).toContain("hello.txt");
  });

  it("returns uninitialized state shape for project without .bender", async () => {
    await rm(join(tempProject, ".bender"), { recursive: true, force: true });
    const stateRes = await fetch(`${baseUrl}/api/state`);
    expect(stateRes.ok).toBe(true);
    const stateBody = await stateRes.json() as { initialized?: boolean; projectRoot?: string | null };
    expect(stateBody.initialized).toBe(false);
    expect(stateBody.projectRoot).toBe(tempProject);
  });
});

describe("api route edge validations (no project selected)", () => {
  let tempBenderHome = "";
  let server: HttpServer | null = null;
  let baseUrl = "";

  beforeAll(async () => {
    vi.resetModules();
    tempBenderHome = await mkdtemp(join(tmpdir(), "bender-api-routes-home-noproject-"));
    process.env.BENDER_HOME_DIR = tempBenderHome;

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
    delete process.env.BENDER_HOME_DIR;
  });

  it("returns no-project state and rejects task GitHub routes", async () => {
    const stateRes = await fetch(`${baseUrl}/api/state`);
    expect(stateRes.ok).toBe(true);
    const stateBody = await stateRes.json() as { initialized?: boolean; projectRoot?: string | null };
    expect(stateBody.initialized).toBe(false);
    expect(stateBody.projectRoot).toBe(null);

    const taskIssueRes = await fetch(`${baseUrl}/api/tasks/1/github/issue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repoFullName: "owner/repo" }),
    });
    expect(taskIssueRes.status).toBe(400);
    const taskIssueBody = await taskIssueRes.json() as { error?: string };
    expect(taskIssueBody.error).toBe("No project selected");
  });
});
