import { exec as execCb } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(execCb);
const MAX_COMMAND_LENGTH = 512;
const COMMAND_TIMEOUT_MS = 30_000;
const MAX_BUFFER_BYTES = 512 * 1024;
const DANGEROUS_PATTERNS: RegExp[] = [
  /\brm\s+-rf\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-[^\n]*\bf\b/i,
  /\bdd\s+if=/i,
  /\bmkfs\./i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bkillall\b/i,
  /\bformat\b/i,
  /\bdrop\s+table\b/i,
];

export interface TerminalExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function isDangerousCommand(command: string): boolean {
  return DANGEROUS_PATTERNS.some((pattern) => pattern.test(command));
}

export function validateTerminalCommand(
  command?: string,
): { ok: true; command: string; dangerous: boolean } | { ok: false; status: number; error: string } {
  if (!command || !command.trim()) {
    return { ok: false, status: 400, error: "command is required" };
  }

  const trimmed = command.trim();
  if (trimmed.length > MAX_COMMAND_LENGTH) {
    return { ok: false, status: 400, error: "command too long" };
  }

  return { ok: true, command: trimmed, dangerous: isDangerousCommand(trimmed) };
}

export async function executeTerminalCommand(command: string, projectRoot: string): Promise<TerminalExecResult> {
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: projectRoot,
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER_BYTES,
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
    });
    return { stdout: stdout.trimEnd(), stderr: stderr.trimEnd(), exitCode: 0 };
  } catch (err: unknown) {
    const execErr = err as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: (execErr.stdout ?? "").trimEnd(),
      stderr: (execErr.stderr ?? (err as Error).message).trimEnd(),
      exitCode: execErr.code ?? 1,
    };
  }
}
