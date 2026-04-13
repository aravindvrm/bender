import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TempHomeContext {
  home: string;
  restore: () => Promise<void>;
}

export async function createTempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

export async function withTempHome(): Promise<TempHomeContext> {
  const previousHome = process.env.HOME;
  const home = await createTempDir("bender-home-");
  process.env.HOME = home;

  return {
    home,
    restore: async () => {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      await rm(home, { recursive: true, force: true });
    },
  };
}

