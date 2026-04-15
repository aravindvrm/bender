import { afterEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { createTempDir } from "../helpers/temp-env.js";
import { LocalProjectDb } from "../../src/state/local-db.js";

describe("LocalProjectDb", () => {
  const cleanupPaths: string[] = [];

  afterEach(async () => {
    for (const path of cleanupPaths) {
      await rm(path, { recursive: true, force: true });
    }
    cleanupPaths.length = 0;
  });

  it("stores kv values and namespaced records in sqlite", async () => {
    const projectRoot = await createTempDir("bender-local-db-");
    cleanupPaths.push(projectRoot);

    const db = LocalProjectDb.forProject(projectRoot);
    await db.init();

    db.setKv("state-file:brief.md", "# Brief");
    expect(db.getKv("state-file:brief.md")).toBe("# Brief");

    db.upsertRecord("state.decision", "001-first.md", { name: "001-first.md", content: "Decision 1" }, {
      createdAt: 10,
      updatedAt: 20,
    });
    db.upsertRecord("state.decision", "002-second.md", { name: "002-second.md", content: "Decision 2" }, {
      createdAt: 30,
      updatedAt: 40,
    });

    const all = db.listRecords<{ name: string }>("state.decision", {
      limit: 10,
      orderBy: "created_at",
      desc: false,
    });
    expect(all.map((item) => item.name)).toEqual(["001-first.md", "002-second.md"]);
    expect(db.countRecords("state.decision")).toBe(2);
  });
});

