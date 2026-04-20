import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Server as HttpServer } from "node:http";

const execFileAsync = promisify(execFile);

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

describe("api workflows", () => {
  let tempProject = "";
  let tempBenderHome = "";
  let server: HttpServer | null = null;
  let baseUrl = "";

  beforeAll(async () => {
    tempProject = await mkdtemp(join(tmpdir(), "bender-api-workflows-"));
    tempBenderHome = await mkdtemp(join(tmpdir(), "bender-home-workflows-"));
    process.env.BENDER_HOME_DIR = tempBenderHome;
    const { startServer } = await import("../../src/cli/server.js");
    const port = await reserveFreePort();
    server = await startServer(tempProject, port);
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    if (server?.listening) {
      await new Promise<void>((resolve, reject) => {
        server?.close((err) => (err ? reject(err) : resolve()));
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

  it("registers built-ins, supports CRUD, and persists runs", async () => {
    const listRes = await fetch(`${baseUrl}/api/workflows`);
    expect(listRes.ok).toBe(true);
    const listBody = (await listRes.json()) as {
      workflows?: Array<{ id?: string; acceptanceCriteria?: string[] }>;
    };
    const workflowIds = (listBody.workflows ?? []).map((workflow) => workflow.id);
    expect(workflowIds).toContain("issue-extract-candidates");
    expect(workflowIds).toContain("task-to-implement");
    expect(workflowIds).toContain("review-current-changes");
    expect(listBody.workflows?.find((workflow) => workflow.id === "task-to-implement")?.acceptanceCriteria?.length).toBeGreaterThan(0);

    const putRes = await fetch(`${baseUrl}/api/workflows/custom-smoke`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Custom Smoke",
        description: "Custom workflow for integration coverage",
        acceptanceCriteria: ["Returns persisted run output"],
        enabled: true,
        steps: [
          {
            id: "p1",
            type: "prompt",
            name: "Prompt",
            config: { template: "hello" },
          },
          {
            id: "r1",
            type: "response",
            name: "Response",
            config: { template: "ok={{input.value}}" },
          },
        ],
      }),
    });
    expect(putRes.ok).toBe(true);
    const putBody = (await putRes.json()) as { workflow?: { id?: string; acceptanceCriteria?: string[] } };
    expect(putBody.workflow?.id).toBe("custom-smoke");
    expect(putBody.workflow?.acceptanceCriteria).toEqual(["Returns persisted run output"]);

    const getRes = await fetch(`${baseUrl}/api/workflows/custom-smoke`);
    expect(getRes.ok).toBe(true);
    const getBody = (await getRes.json()) as { workflow?: { id?: string; steps?: unknown[] } };
    expect(getBody.workflow?.id).toBe("custom-smoke");
    expect(getBody.workflow?.steps?.length).toBe(2);

    const runRes = await fetch(`${baseUrl}/api/workflows/custom-smoke/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: { value: "yes" } }),
    });
    expect(runRes.ok).toBe(true);
    const runBody = (await runRes.json()) as { runId?: string; status?: string; output?: { message?: string } };
    expect(runBody.runId).toBeTruthy();
    expect(runBody.status).toBe("completed");
    expect(runBody.output?.message).toBe("ok=yes");

    const runsRes = await fetch(`${baseUrl}/api/workflow-runs?workflowId=custom-smoke`);
    expect(runsRes.ok).toBe(true);
    const runsBody = (await runsRes.json()) as { runs?: Array<{ id?: string; workflowId?: string }> };
    expect(runsBody.runs?.some((run) => run.id === runBody.runId && run.workflowId === "custom-smoke")).toBe(true);

    const invalidRes = await fetch(`${baseUrl}/api/workflows/invalid`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Invalid",
        steps: [],
      }),
    });
    expect(invalidRes.status).toBe(400);
    const invalidBody = (await invalidRes.json()) as { error?: string };
    expect(invalidBody.error).toContain("steps");
  });

  it("runs the review built-in when repo has no diff", async () => {
    await execFileAsync("git", ["init"], { cwd: tempProject });

    const runRes = await fetch(`${baseUrl}/api/workflows/review-current-changes/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: {} }),
    });
    expect(runRes.ok).toBe(true);
    const runBody = (await runRes.json()) as { status?: string; output?: { status?: string; issueCount?: number } };
    expect(runBody.status).toBe("completed");
    expect(runBody.output?.status).toBe("APPROVED");
    expect(runBody.output?.issueCount).toBe(0);
  });

});
