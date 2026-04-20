import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StateManager } from "../../src/state/manager.js";
import { createBenderChatTools } from "../../src/cli/services/chat.js";

const tempDirs: string[] = [];

async function makeProjectRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bender-chat-tools-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    await rm(dir, { recursive: true, force: true });
  }
});

describe("chat bender tools", () => {
  it("supports task list/add/update/delete actions", async () => {
    const projectRoot = await makeProjectRoot();
    const state = new StateManager(projectRoot);
    await state.init();
    await state.writeCurrentTaskPlan({
      version: 1,
      generatedAt: new Date().toISOString(),
      tasks: [],
    });

    const tools = createBenderChatTools(projectRoot) as Record<string, { execute?: (input: unknown) => Promise<unknown> }>;
    expect(typeof tools.bender_run_analyze?.execute).toBe("function");

    const listBefore = await tools.bender_list_tasks.execute?.({});
    expect((listBefore as { count?: number }).count).toBe(0);

    const added = await tools.bender_add_task.execute?.({
      title: "Set up chat command runner",
      description: "Wire tool calls to task services",
      acceptanceCriteria: ["Task updates persist in canonical plan"],
    }) as { taskId?: string };
    expect(added.taskId).toBe("task-1");

    const listAfterAdd = await tools.bender_list_tasks.execute?.({}) as {
      count?: number;
      tasks?: Array<{ id: string; title: string; status: string }>;
    };
    expect(listAfterAdd.count).toBe(1);
    expect(listAfterAdd.tasks?.[0]?.title).toContain("Set up chat command runner");

    const updated = await tools.bender_update_task.execute?.({
      taskId: "task-1",
      title: "Update chat command runner",
      status: "in_progress",
    }) as { updated?: { title?: string; status?: string } };
    expect(updated.updated?.title).toBe("Update chat command runner");
    expect(updated.updated?.status).toBe("in_progress");

    const deleted = await tools.bender_delete_task.execute?.({
      taskId: "task-1",
    }) as { deletedTaskIds?: string[] };
    expect(deleted.deletedTaskIds).toEqual(["task-1"]);

    const listAfterDelete = await tools.bender_list_tasks.execute?.({}) as { count?: number };
    expect(listAfterDelete.count).toBe(0);
  });
});
