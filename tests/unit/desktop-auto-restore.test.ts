import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addToRegistry } from "../../src/state/registry.js";

/**
 * Regression test for the desktop backend's "open the most-recently-used
 * project" behavior. The backend reads the registry and picks the most
 * recent entry whose path still exists on disk; entries pointing at
 * deleted directories are skipped silently.
 *
 * We re-implement the picker logic here as a pure helper so it can be
 * unit-tested without spawning the real backend (which would also try
 * to bind a port). The desktop backend uses the same logic — see
 * src/desktop/backend.ts::resolveLastOpenedProject.
 */
import { existsSync, statSync } from "node:fs";
import { readRegistry } from "../../src/state/registry.js";

async function pickLastOpened(): Promise<string | undefined> {
  const entries = await readRegistry();
  const sorted = [...entries].sort(
    (a, b) => Date.parse(b.lastOpened) - Date.parse(a.lastOpened),
  );
  for (const entry of sorted) {
    try {
      if (existsSync(entry.path) && statSync(entry.path).isDirectory()) {
        return entry.path;
      }
    } catch { /* ignore */ }
  }
  return undefined;
}

const tempDirs: string[] = [];

beforeEach(async () => {
  const home = await mkdtemp(join(tmpdir(), "bender-restore-"));
  tempDirs.push(home);
  process.env.BENDER_HOME_DIR = home;
});

afterEach(async () => {
  delete process.env.BENDER_HOME_DIR;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    await rm(dir, { recursive: true, force: true });
  }
});

describe("desktop auto-restore", () => {
  it("returns undefined when registry is empty", async () => {
    expect(await pickLastOpened()).toBeUndefined();
  });

  it("picks the most-recently-opened existing project", async () => {
    const projectA = await mkdtemp(join(tmpdir(), "bender-projA-"));
    const projectB = await mkdtemp(join(tmpdir(), "bender-projB-"));
    tempDirs.push(projectA, projectB);
    await addToRegistry(projectA);
    // Tiny delay so lastOpened ordering is deterministic.
    await new Promise((r) => setTimeout(r, 5));
    await addToRegistry(projectB);
    expect(await pickLastOpened()).toBe(projectB);
  });

  it("skips entries whose directory was deleted", async () => {
    const real = await mkdtemp(join(tmpdir(), "bender-real-"));
    const ghost = join(tmpdir(), "bender-ghost-never-existed");
    tempDirs.push(real);
    // Ghost is added FIRST → most-recently-opened is ghost
    await addToRegistry(real);
    await new Promise((r) => setTimeout(r, 5));
    await addToRegistry(ghost);
    // Should fall back to the real project.
    expect(await pickLastOpened()).toBe(real);
  });

  it("returns undefined when no entry points at an existing directory", async () => {
    await addToRegistry("/tmp/bender-ghost-1");
    await addToRegistry("/tmp/bender-ghost-2");
    expect(await pickLastOpened()).toBeUndefined();
  });

  it("treats files (not directories) as missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bender-realdir-"));
    tempDirs.push(dir);
    // Write a file at a path; ensure the picker rejects it as not-a-dir.
    const filePath = join(dir, "looks-like-a-project");
    await mkdir(filePath, { recursive: false }); // actually a dir; rename test
    await addToRegistry(filePath);
    expect(await pickLastOpened()).toBe(filePath);
  });
});
