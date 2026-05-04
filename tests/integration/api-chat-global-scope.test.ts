import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server as HttpServer } from "node:http";

async function reserveFreePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close(() => reject(new Error("Failed to reserve port")));
        return;
      }
      const port = addr.port;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

async function closeServer(server: HttpServer | null): Promise<void> {
  if (!server?.listening) return;
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
}

interface Thread {
  id: string;
  title: string;
}

describe("api chat global scope isolation", () => {
  let tempWorkspace = "";
  let tempBenderHome = "";
  let benderServer: HttpServer | null = null;
  let baseUrl = "";
  let projectPath = "";

  beforeAll(async () => {
    tempWorkspace = await mkdtemp(join(tmpdir(), "bender-chat-global-"));
    tempBenderHome = await mkdtemp(join(tmpdir(), "bender-chat-global-home-"));
    process.env.BENDER_HOME_DIR = tempBenderHome;

    const { startServer } = await import("../../src/cli/server.js");
    const port = await reserveFreePort();
    benderServer = await startServer(undefined, port);
    baseUrl = `http://127.0.0.1:${port}`;

    projectPath = join(tempWorkspace, "project");
    await mkdir(projectPath, { recursive: true });
  });

  afterAll(async () => {
    await closeServer(benderServer);
    if (tempWorkspace) await rm(tempWorkspace, { recursive: true, force: true });
    if (tempBenderHome) await rm(tempBenderHome, { recursive: true, force: true });
    delete process.env.BENDER_HOME_DIR;
  });

  it("keeps global threads isolated from project threads after opening a project", async () => {
    const globalCreate = await fetch(`${baseUrl}/api/chat/threads`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Global thread" }),
    });
    expect(globalCreate.ok).toBe(true);
    const globalBody = await globalCreate.json() as { thread: Thread };
    expect(globalBody.thread.id).toBeTruthy();

    const globalList = await fetch(`${baseUrl}/api/chat/threads`);
    const globalListBody = await globalList.json() as { threads: Thread[] };
    expect(globalListBody.threads.some((thread) => thread.id === globalBody.thread.id)).toBe(true);

    const openProject = await fetch(`${baseUrl}/api/project/open`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: projectPath }),
    });
    expect(openProject.ok).toBe(true);

    const projectThreads = await fetch(`${baseUrl}/api/chat/threads`);
    const projectThreadsBody = await projectThreads.json() as { threads: Thread[] };
    expect(projectThreadsBody.threads.some((thread) => thread.id === globalBody.thread.id)).toBe(false);

    const staleGlobalRead = await fetch(`${baseUrl}/api/chat/threads/${encodeURIComponent(globalBody.thread.id)}/messages`);
    expect(staleGlobalRead.status).toBe(404);
    const staleError = await staleGlobalRead.json() as { error?: string };
    expect(staleError.error).toMatch(/Thread not found/i);
  });
});

