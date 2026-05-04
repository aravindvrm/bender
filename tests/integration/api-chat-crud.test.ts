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
  archived?: boolean;
}

describe("api chat CRUD", () => {
  let tempWorkspace = "";
  let tempBenderHome = "";
  let benderServer: HttpServer | null = null;
  let baseUrl = "";
  let projectPath = "";
  let secondProjectPath = "";

  beforeAll(async () => {
    tempWorkspace = await mkdtemp(join(tmpdir(), "bender-chat-crud-"));
    tempBenderHome = await mkdtemp(join(tmpdir(), "bender-chat-crud-home-"));
    process.env.BENDER_HOME_DIR = tempBenderHome;

    const { startServer } = await import("../../src/cli/server.js");
    const port = await reserveFreePort();
    benderServer = await startServer(undefined, port);
    baseUrl = `http://127.0.0.1:${port}`;

    projectPath = join(tempWorkspace, "project");
    secondProjectPath = join(tempWorkspace, "project-2");
    await mkdir(projectPath, { recursive: true });
    await mkdir(secondProjectPath, { recursive: true });
    const openRes = await fetch(`${baseUrl}/api/project/open`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: projectPath }),
    });
    expect(openRes.ok).toBe(true);
  });

  afterAll(async () => {
    await closeServer(benderServer);
    if (tempWorkspace) await rm(tempWorkspace, { recursive: true, force: true });
    if (tempBenderHome) await rm(tempBenderHome, { recursive: true, force: true });
    delete process.env.BENDER_HOME_DIR;
  });

  it("GET /api/chat/threads returns empty array initially", async () => {
    const res = await fetch(`${baseUrl}/api/chat/threads`);
    expect(res.ok).toBe(true);
    const body = await res.json() as { threads: Thread[] };
    expect(Array.isArray(body.threads)).toBe(true);
    expect(body.threads).toHaveLength(0);
  });

  it("POST /api/chat/threads creates a thread", async () => {
    const res = await fetch(`${baseUrl}/api/chat/threads`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Test thread" }),
    });
    expect(res.ok).toBe(true);
    const body = await res.json() as { thread: Thread };
    expect(body.thread.id).toBeTruthy();
    expect(body.thread.title).toBe("Test thread");
  });

  it("GET /api/chat/threads lists created threads", async () => {
    const res = await fetch(`${baseUrl}/api/chat/threads`);
    expect(res.ok).toBe(true);
    const body = await res.json() as { threads: Thread[] };
    expect(body.threads.length).toBeGreaterThanOrEqual(1);
    expect(body.threads[0]?.title).toBe("Test thread");
  });

  it("PATCH /api/chat/threads/:id renames a thread", async () => {
    const listRes = await fetch(`${baseUrl}/api/chat/threads`);
    const { threads } = await listRes.json() as { threads: Thread[] };
    const id = threads[0]?.id;
    expect(id).toBeTruthy();

    const patchRes = await fetch(`${baseUrl}/api/chat/threads/${encodeURIComponent(id!)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Renamed thread" }),
    });
    expect(patchRes.ok).toBe(true);
    const body = await patchRes.json() as { thread: Thread };
    expect(body.thread.title).toBe("Renamed thread");
    expect(body.thread.id).toBe(id);
  });

  it("PATCH /api/chat/threads/:id archives a thread", async () => {
    const listRes = await fetch(`${baseUrl}/api/chat/threads`);
    const { threads } = await listRes.json() as { threads: Thread[] };
    const id = threads[0]?.id;

    const patchRes = await fetch(`${baseUrl}/api/chat/threads/${encodeURIComponent(id!)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archived: true }),
    });
    expect(patchRes.ok).toBe(true);
    const body = await patchRes.json() as { thread: Thread };
    expect(body.thread.archived).toBe(true);

    // Without includeArchived the thread should be hidden
    const listHidden = await fetch(`${baseUrl}/api/chat/threads`);
    const hiddenBody = await listHidden.json() as { threads: Thread[] };
    expect(hiddenBody.threads.every((t) => t.id !== id)).toBe(true);

    // With includeArchived=true it should appear
    const listAll = await fetch(`${baseUrl}/api/chat/threads?includeArchived=true`);
    const allBody = await listAll.json() as { threads: Thread[] };
    expect(allBody.threads.some((t) => t.id === id)).toBe(true);
  });

  it("PATCH /api/chat/threads/:id restores an archived thread", async () => {
    const listRes = await fetch(`${baseUrl}/api/chat/threads?includeArchived=true`);
    const { threads } = await listRes.json() as { threads: Thread[] };
    const archived = threads.find((t) => t.archived);
    expect(archived).toBeTruthy();

    const patchRes = await fetch(`${baseUrl}/api/chat/threads/${encodeURIComponent(archived!.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archived: false }),
    });
    expect(patchRes.ok).toBe(true);
    const body = await patchRes.json() as { thread: Thread };
    expect(body.thread.archived).toBe(false);
  });

  it("DELETE /api/chat/threads/:id removes thread and its messages", async () => {
    // Create a second thread to delete
    const createRes = await fetch(`${baseUrl}/api/chat/threads`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Thread to delete" }),
    });
    const { thread } = await createRes.json() as { thread: Thread };

    const deleteRes = await fetch(`${baseUrl}/api/chat/threads/${encodeURIComponent(thread.id)}`, {
      method: "DELETE",
    });
    expect(deleteRes.status).toBe(204);

    // Should no longer appear in list
    const listRes = await fetch(`${baseUrl}/api/chat/threads`);
    const { threads } = await listRes.json() as { threads: Thread[] };
    expect(threads.every((t) => t.id !== thread.id)).toBe(true);
  });

  it("DELETE /api/chat/threads/:id returns 404 for unknown thread", async () => {
    const res = await fetch(`${baseUrl}/api/chat/threads/nonexistent-id`, {
      method: "DELETE",
    });
    expect(res.status).toBe(404);
  });

  it("GET /api/chat/threads/:id/messages returns empty array for new thread", async () => {
    const createRes = await fetch(`${baseUrl}/api/chat/threads`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Empty thread" }),
    });
    const { thread } = await createRes.json() as { thread: Thread };

    const res = await fetch(`${baseUrl}/api/chat/threads/${encodeURIComponent(thread.id)}/messages`);
    expect(res.ok).toBe(true);
    const body = await res.json() as { messages: unknown[] };
    expect(Array.isArray(body.messages)).toBe(true);
    expect(body.messages).toHaveLength(0);
  });

  it("returns thread-not-found when using a thread id from another project scope", async () => {
    const createRes = await fetch(`${baseUrl}/api/chat/threads`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Scoped thread" }),
    });
    expect(createRes.ok).toBe(true);
    const created = await createRes.json() as { thread: Thread };
    expect(created.thread.id).toBeTruthy();

    const switchRes = await fetch(`${baseUrl}/api/project/open`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: secondProjectPath }),
    });
    expect(switchRes.ok).toBe(true);

    const staleRead = await fetch(`${baseUrl}/api/chat/threads/${encodeURIComponent(created.thread.id)}/messages`);
    expect(staleRead.status).toBe(404);
    const staleBody = await staleRead.json() as { error?: string };
    expect(staleBody.error).toMatch(/Thread not found/i);
  });
});
