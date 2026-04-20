import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server as HttpServer } from "node:http";
import { parseTaskPlan } from "../../src/cli/implement.js";

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

describe("api /tasks/append", () => {
  let tempProject = "";
  let tempBenderHome = "";
  let server: HttpServer | null = null;
  let baseUrl = "";

  beforeAll(async () => {
    tempProject = await mkdtemp(join(tmpdir(), "bender-api-append-"));
    tempBenderHome = await mkdtemp(join(tmpdir(), "bender-home-"));
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

  it("appends parser-compatible tasks and increments ids", async () => {
    const first = await fetch(`${baseUrl}/api/tasks/append`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Fix test audit issue",
        description: "Address missing integration checks",
      }),
    });
    expect(first.ok).toBe(true);
    const firstBody = (await first.json()) as { ok?: boolean; taskId?: string };
    expect(firstBody.ok).toBe(true);
    expect(firstBody.taskId).toBe("task-1");

    const second = await fetch(`${baseUrl}/api/tasks/append`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Harden CI step",
        description: "Stabilize flaky pipeline path",
      }),
    });
    expect(second.ok).toBe(true);
    const secondBody = (await second.json()) as { ok?: boolean; taskId?: string };
    expect(secondBody.ok).toBe(true);
    expect(secondBody.taskId).toBe("task-2");

    const taskPlanPath = join(tempProject, ".bender", "tasks", "current.md");
    const taskPlanJsonPath = join(tempProject, ".bender", "tasks", "current.json");
    expect(existsSync(taskPlanPath)).toBe(true);
    expect(existsSync(taskPlanJsonPath)).toBe(true);
    const markdown = await readFile(taskPlanPath, "utf-8");

    const parsed = parseTaskPlan(markdown);
    expect(parsed).toHaveLength(2);
    expect(parsed.map((t) => t.id)).toEqual(["task-1", "task-2"]);
    expect(parsed[0]?.title).toBe("Fix test audit issue");
    expect(parsed[1]?.title).toBe("Harden CI step");
  });

  it("supports description-only task creation and optional implementer assignment", async () => {
    const createRes = await fetch(`${baseUrl}/api/tasks/append`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        description: "Audit auth token rotation and enforce expiry checks in middleware and background jobs.",
        agentId: "default-implementer",
      }),
    });
    expect(createRes.ok).toBe(true);
    const createBody = (await createRes.json()) as {
      ok?: boolean;
      taskId?: string;
      assignments?: Record<string, string> | null;
    };
    expect(createBody.ok).toBe(true);
    expect(createBody.taskId).toBe("task-3");
    expect(createBody.assignments?.["task-3"]).toBe("default-implementer");

    const taskPlanPath = join(tempProject, ".bender", "tasks", "current.md");
    const markdown = await readFile(taskPlanPath, "utf-8");
    const parsed = parseTaskPlan(markdown);
    expect(parsed).toHaveLength(3);
    expect(parsed[2]?.title).toContain("Audit auth token rotation");
  });
});
