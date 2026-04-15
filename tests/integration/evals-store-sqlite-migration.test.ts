import { afterEach, describe, expect, it } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createTempDir } from "../helpers/temp-env.js";
import { EvalsStore } from "../../src/state/evals.js";
import { getBenderDir } from "../../src/state/config.js";

describe("EvalsStore sqlite migration", () => {
  const cleanupPaths: string[] = [];

  afterEach(async () => {
    for (const path of cleanupPaths) {
      await rm(path, { recursive: true, force: true });
    }
    cleanupPaths.length = 0;
  });

  it("imports legacy eval json files into sqlite and keeps data available", async () => {
    const projectRoot = await createTempDir("bender-evals-sqlite-migrate-");
    cleanupPaths.push(projectRoot);

    const benderDir = getBenderDir(projectRoot);
    const evalsDir = join(benderDir, "evals");
    const runsDir = join(evalsDir, "runs");
    const tasksRunsDir = join(runsDir, "tasks");

    await mkdir(tasksRunsDir, { recursive: true });
    await writeFile(join(evalsDir, "tasks.json"), JSON.stringify([
      {
        id: "task-1",
        name: "Task One",
        prompt: "Do thing",
        createdAt: 1,
        updatedAt: 2,
      },
    ], null, 2), "utf-8");
    await writeFile(join(evalsDir, "configs.json"), JSON.stringify([], null, 2), "utf-8");
    await writeFile(join(evalsDir, "suites.json"), JSON.stringify([], null, 2), "utf-8");
    await writeFile(join(runsDir, "compare-index.json"), JSON.stringify([], null, 2), "utf-8");
    await writeFile(join(runsDir, "suite-index.json"), JSON.stringify([], null, 2), "utf-8");

    const store = new EvalsStore(projectRoot);
    await store.init();

    const dbPath = join(benderDir, "bender.db");
    expect(existsSync(dbPath)).toBe(true);

    const tasks = await store.listTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.id).toBe("task-1");

    // Delete legacy file and ensure sqlite-backed reads still work.
    await rm(join(evalsDir, "tasks.json"), { force: true });
    const tasksAfterDelete = await store.listTasks();
    expect(tasksAfterDelete).toHaveLength(1);
    expect(tasksAfterDelete[0]?.name).toBe("Task One");
  });
});

