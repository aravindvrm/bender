import { exec } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { BenderConfig } from "../state/config.js";

const execAsync = promisify(exec);

export interface TestResult {
  passed: boolean;
  output: string;
  error?: string;
  command: string;
}

/**
 * Detect the test command for a project, or use the configured one.
 */
export function detectTestCommand(projectRoot: string, config: BenderConfig): string | null {
  if (config.test.command) {
    return config.test.command;
  }

  // Check package.json for test script
  const pkgPath = join(projectRoot, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      if (pkg.scripts?.test && pkg.scripts.test !== 'echo "Error: no test specified" && exit 1') {
        return "npm test";
      }
    } catch {
      // ignore parse errors
    }
  }

  // Check for common test config files
  const testConfigs: [string, string][] = [
    ["vitest.config.ts", "npx vitest run"],
    ["vitest.config.js", "npx vitest run"],
    ["jest.config.ts", "npx jest"],
    ["jest.config.js", "npx jest"],
    ["jest.config.cjs", "npx jest"],
    ["playwright.config.ts", "npx playwright test"],
  ];

  for (const [configFile, command] of testConfigs) {
    if (existsSync(join(projectRoot, configFile))) {
      return command;
    }
  }

  return null;
}

/**
 * Run the project's test suite and return the result.
 */
export async function runTests(projectRoot: string, config: BenderConfig): Promise<TestResult> {
  const command = detectTestCommand(projectRoot, config);

  if (!command) {
    return {
      passed: true,
      output: "No test command detected. Skipping tests.",
      command: "(none)",
    };
  }

  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: projectRoot,
      timeout: 120_000, // 2 minute timeout
      env: { ...process.env, CI: "true", FORCE_COLOR: "0" },
    });

    return {
      passed: true,
      output: stdout + (stderr ? `\n${stderr}` : ""),
      command,
    };
  } catch (err: unknown) {
    const error = err as { stdout?: string; stderr?: string; message?: string };
    return {
      passed: false,
      output: error.stdout ?? "",
      error: error.stderr ?? error.message ?? "Unknown test error",
      command,
    };
  }
}

/**
 * Run the TypeScript compiler to check for type errors.
 */
export async function runTypeCheck(projectRoot: string): Promise<TestResult> {
  const tsconfigPath = join(projectRoot, "tsconfig.json");
  if (!existsSync(tsconfigPath)) {
    return {
      passed: true,
      output: "No tsconfig.json found. Skipping type check.",
      command: "(none)",
    };
  }

  try {
    const { stdout, stderr } = await execAsync("npx tsc --noEmit", {
      cwd: projectRoot,
      timeout: 60_000,
      env: { ...process.env, FORCE_COLOR: "0" },
    });

    return {
      passed: true,
      output: stdout + (stderr ? `\n${stderr}` : ""),
      command: "npx tsc --noEmit",
    };
  } catch (err: unknown) {
    const error = err as { stdout?: string; stderr?: string; message?: string };
    return {
      passed: false,
      output: error.stdout ?? "",
      error: error.stderr ?? error.message ?? "Unknown type check error",
      command: "npx tsc --noEmit",
    };
  }
}
