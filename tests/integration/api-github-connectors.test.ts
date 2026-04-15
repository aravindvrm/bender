import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
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

describe("api github + connector lifecycle", () => {
  let tempBenderHome = "";
  let server: HttpServer | null = null;
  let baseUrl = "";

  beforeAll(async () => {
    tempBenderHome = await mkdtemp(join(tmpdir(), "bender-home-github-"));
    process.env.BENDER_HOME_DIR = tempBenderHome;
    delete process.env.GITHUB_APP_CLIENT_ID;
    delete process.env.GITHUB_CLIENT_ID;
    delete process.env.GITHUB_APP_CLIENT_SECRET;
    delete process.env.GITHUB_CLIENT_SECRET;
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

  it("supports github config/status baseline without active session", async () => {
    const initialStatus = await fetch(`${baseUrl}/api/github/auth/status`);
    expect(initialStatus.ok).toBe(true);
    const initialBody = await initialStatus.json() as { configured?: boolean; connected?: boolean };
    expect(initialBody.configured).toBe(false);
    expect(initialBody.connected).toBe(false);

    const putConfig = await fetch(`${baseUrl}/api/github/auth/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientId: "test-client-id",
        clientSecret: "test-client-secret",
      }),
    });
    expect(putConfig.ok).toBe(true);

    const statusAfterConfig = await fetch(`${baseUrl}/api/github/auth/status`);
    const statusBody = await statusAfterConfig.json() as { configured?: boolean; connected?: boolean };
    expect(statusBody.configured).toBe(true);
    expect(statusBody.connected).toBe(false);

    const pollMissingSession = await fetch(`${baseUrl}/api/github/device/poll`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(pollMissingSession.status).toBe(400);
  });

  it("supports connector status checks and rejects unknown connector ids", async () => {
    const statusRes = await fetch(`${baseUrl}/api/connectors/status`);
    expect(statusRes.ok).toBe(true);
    const statusBody = await statusRes.json() as { statuses?: Array<{ id: string; discoveredCapabilities?: string[] }> };
    const statuses = statusBody.statuses ?? [];
    expect(statuses.length).toBeGreaterThanOrEqual(4);
    const github = statuses.find((s) => s.id === "github");
    expect(github?.discoveredCapabilities?.length).toBeGreaterThan(0);

    const unknownRes = await fetch(`${baseUrl}/api/mcp/connectors/not-a-connector`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    expect(unknownRes.status).toBe(404);

    const updateKnown = await fetch(`${baseUrl}/api/mcp/connectors/github`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        enabled: false,
        authorizationToken: "ghp_example_secret",
      }),
    });
    expect(updateKnown.ok).toBe(true);
    const knownBody = await updateKnown.json() as { connector?: { authorizationToken?: string; configured?: boolean } };
    expect(knownBody.connector?.configured).toBe(true);
    expect(knownBody.connector?.authorizationToken).toBe("••••••••");
  });
});

