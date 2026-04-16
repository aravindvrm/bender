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

describe("api contract baseline", () => {
  let tempWorkspace = "";
  let tempBenderHome = "";
  let server: HttpServer | null = null;
  let baseUrl = "";

  beforeAll(async () => {
    tempWorkspace = await mkdtemp(join(tmpdir(), "bender-api-contract-"));
    tempBenderHome = await mkdtemp(join(tmpdir(), "bender-home-contract-"));
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
    if (tempWorkspace) {
      await rm(tempWorkspace, { recursive: true, force: true });
    }
    if (tempBenderHome) {
      await rm(tempBenderHome, { recursive: true, force: true });
    }
    delete process.env.BENDER_HOME_DIR;
  });

  it("preserves /api/project and /api/projects shape", async () => {
    const projectRes = await fetch(`${baseUrl}/api/project`);
    expect(projectRes.ok).toBe(true);
    const projectBody = await projectRes.json() as { path?: string | null };
    expect(Object.prototype.hasOwnProperty.call(projectBody, "path")).toBe(true);
    expect(projectBody.path ?? null).toBe(null);

    const projectsRes = await fetch(`${baseUrl}/api/projects`);
    expect(projectsRes.ok).toBe(true);
    const projects = await projectsRes.json() as unknown;
    expect(Array.isArray(projects)).toBe(true);
  });

  it("masks secrets in /api/config responses", async () => {
    const saveRes = await fetch(`${baseUrl}/api/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        llm: {
          provider: "openai",
          models: { fast: "gpt-4o-mini", default: "gpt-4o", strong: "gpt-4o" },
        },
        providers: {
          openai: { apiKey: "sk-test-openai-key" },
        },
      }),
    });
    expect(saveRes.ok).toBe(true);

    const getRes = await fetch(`${baseUrl}/api/config`);
    expect(getRes.ok).toBe(true);
    const body = await getRes.json() as {
      providers?: Record<string, { apiKey?: string }>;
      llm?: { apiKey?: string };
    };
    expect(body.providers?.openai?.apiKey).toBe("••••••••");
    if (body.llm?.apiKey) {
      expect(body.llm.apiKey).toBe("••••••••");
    }
  });

  it("preserves /api/project/open and /api/project/select behavior", async () => {
    const openTarget = join(tempWorkspace, "project-a");
    const openRes = await fetch(`${baseUrl}/api/project/open`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: openTarget }),
    });
    expect(openRes.ok).toBe(true);
    const openBody = await openRes.json() as { ok?: boolean; path?: string };
    expect(openBody.ok).toBe(true);
    expect(openBody.path).toBe(openTarget);

    const projectRes = await fetch(`${baseUrl}/api/project`);
    const projectBody = await projectRes.json() as { path?: string | null };
    expect(projectBody.path).toBe(openTarget);

    const badSelect = await fetch(`${baseUrl}/api/project/select`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: join(tempWorkspace, "missing-dir") }),
    });
    expect(badSelect.status).toBe(400);
    const badBody = await badSelect.json() as { error?: string };
    expect(badBody.error).toBe("Directory does not exist");
  });

  it("applies /api/config writes to active project scope", async () => {
    const projectPath = join(tempWorkspace, "project-scope-config");
    const openRes = await fetch(`${baseUrl}/api/project/open`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: projectPath }),
    });
    expect(openRes.ok).toBe(true);

    const saveRes = await fetch(`${baseUrl}/api/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        llm: {
          provider: "openai-compatible",
          models: { fast: "local-model", default: "local-model", strong: "local-model" },
        },
        providers: {
          "openai-compatible": { baseUrl: "http://localhost:1234/v1" },
        },
      }),
    });
    expect(saveRes.ok).toBe(true);
    const saveBody = await saveRes.json() as { scope?: string };
    expect(saveBody.scope).toBe("project");

    const stateRes = await fetch(`${baseUrl}/api/state`);
    expect(stateRes.ok).toBe(true);
    const stateBody = await stateRes.json() as { config?: { llm?: { provider?: string } } };
    expect(stateBody.config?.llm?.provider).toBe("openai-compatible");
  });

  it("preserves /api/terminal/exec validation and output shape", async () => {
    await fetch(`${baseUrl}/api/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        security: {
          terminalExec: {
            enabled: true,
            requireDangerousConfirmation: true,
          },
        },
      }),
    });

    const missingCommandRes = await fetch(`${baseUrl}/api/terminal/exec`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(missingCommandRes.status).toBe(400);
    const missingBody = await missingCommandRes.json() as { error?: string };
    expect(missingBody.error).toBe("command is required");

    const tooLongRes = await fetch(`${baseUrl}/api/terminal/exec`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "x".repeat(513) }),
    });
    expect(tooLongRes.status).toBe(400);
    const tooLongBody = await tooLongRes.json() as { error?: string };
    expect(tooLongBody.error).toBe("command too long");

    const runRes = await fetch(`${baseUrl}/api/terminal/exec`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "node -e \"process.stdout.write('ok')\"" }),
    });
    expect(runRes.ok).toBe(true);
    const runBody = await runRes.json() as { stdout?: string; stderr?: string; exitCode?: number };
    expect(typeof runBody.stdout).toBe("string");
    expect(typeof runBody.stderr).toBe("string");
    expect(typeof runBody.exitCode).toBe("number");
    expect(runBody.stdout).toContain("ok");
    expect(runBody.exitCode).toBe(0);
  });

  it("requires confirmation for dangerous terminal commands and supports security disable", async () => {
    await fetch(`${baseUrl}/api/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        security: {
          terminalExec: {
            enabled: true,
            requireDangerousConfirmation: true,
          },
        },
      }),
    });

    const dangerousRes = await fetch(`${baseUrl}/api/terminal/exec`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "echo rm -rf" }),
    });
    expect(dangerousRes.status).toBe(400);
    const dangerousBody = await dangerousRes.json() as { error?: string };
    expect(dangerousBody.error).toContain("confirmDangerous=true");

    const dangerousConfirmedRes = await fetch(`${baseUrl}/api/terminal/exec`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "echo rm -rf", confirmDangerous: true }),
    });
    expect(dangerousConfirmedRes.ok).toBe(true);
    const dangerousConfirmedBody = await dangerousConfirmedRes.json() as { stdout?: string };
    expect(dangerousConfirmedBody.stdout).toContain("rm -rf");

    const configDisableRes = await fetch(`${baseUrl}/api/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        security: {
          terminalExec: {
            enabled: false,
          },
        },
      }),
    });
    expect(configDisableRes.ok).toBe(true);

    const disabledRes = await fetch(`${baseUrl}/api/terminal/exec`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "echo hello" }),
    });
    expect(disabledRes.status).toBe(403);
    const disabledBody = await disabledRes.json() as { error?: string };
    expect(disabledBody.error).toContain("disabled");
  });
});
