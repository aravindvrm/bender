import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], cwd: string): Promise<CliResult> {
  return new Promise((resolveResult) => {
    const child = spawn("node", ["dist/cli/index.js", ...args], {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("close", (code) => {
      resolveResult({ code: code ?? 1, stdout, stderr });
    });
  });
}

describe("cli harness", () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const distCliPath = join(repoRoot, "dist/cli/index.js");
  let tempProject: string;

  beforeAll(async () => {
    if (!existsSync(distCliPath)) {
      throw new Error("dist/cli/index.js not found. Run `npm run build:cli` before integration tests.");
    }
    tempProject = await mkdtemp(join(tmpdir(), "bender-cli-int-"));
  });

  afterAll(async () => {
    await rm(tempProject, { recursive: true, force: true });
  });

  it("prints top-level help with the bend command", async () => {
    const result = await runCli(["--help"], repoRoot);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("bender");
    expect(result.stdout).toContain("bend");
    expect(result.stdout).toContain("analyze");
  });

  it("prints bend command help", async () => {
    const result = await runCli(["bend", "--help"], repoRoot);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Open the local web dashboard");
  });

  it("handles status on non-initialized projects gracefully", async () => {
    const result = await runCli(["status", "-d", tempProject], repoRoot);
    expect(result.code).toBe(0);
    expect(result.stdout + result.stderr).toContain("No .bender/ directory found");
  });

  it("handles stop when no dashboard is running", async () => {
    const result = await runCli(["stop"], repoRoot);
    expect(result.code).toBe(0);
    const output = result.stdout + result.stderr;
    expect(
      output.includes("No running Bender dashboard process found")
      || output.includes("Stopped process")
      || output.includes("Stopped dashboard process"),
    ).toBe(true);
  });
});
