import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Machine/user-level Bender home directory.
 * Can be overridden in tests and local setups via BENDER_HOME_DIR.
 */
export function getBenderHomeDir(): string {
  const override = process.env.BENDER_HOME_DIR?.trim();
  if (override) return override;
  return join(homedir(), ".bender");
}

export function getBenderHomePath(...segments: string[]): string {
  return join(getBenderHomeDir(), ...segments);
}

