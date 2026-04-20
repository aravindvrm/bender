import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateManager } from "../../src/state/manager.js";
import {
  GitHubWorkItemsServiceError,
  importGitHubWorkItems,
  listGitHubWorkItems,
} from "../../src/cli/services/github-work-items.js";

const tempDirs: string[] = [];

async function makeProjectDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
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

describe("github work item service", () => {
  it("lists project-scoped issues and supports unlinked-only filtering", async () => {
    const projectRoot = await makeProjectDir("bender-gh-work-items-list-");
    const state = new StateManager(projectRoot);
    await state.init();
    await state.setTaskGitHubLink("task-1", {
      repoFullName: "acme/repo",
      issueNumber: 42,
    });

    const response = await listGitHubWorkItems(
      projectRoot,
      { unlinkedOnly: true },
      {
        readGitHubSession: async () => ({ accessToken: "gh-test" }),
        githubApi: async (path) => {
          expect(path).toContain("/repos/acme/repo/issues?");
          return [
            {
              number: 42,
              title: "Already linked",
              body: "",
              state: "open",
              html_url: "https://github.com/acme/repo/issues/42",
            },
            {
              number: 43,
              title: "Needs triage",
              body: "Please implement this.",
              state: "open",
              html_url: "https://github.com/acme/repo/issues/43",
              labels: [{ name: "bug" }],
            },
            {
              number: 44,
              title: "PR should be filtered",
              state: "open",
              html_url: "https://github.com/acme/repo/pull/44",
              pull_request: {},
            },
          ];
        },
      },
    );

    expect(response.repoFullName).toBe("acme/repo");
    expect(response.workItems).toHaveLength(1);
    expect(response.workItems[0]?.issueNumber).toBe(43);
    expect(response.workItems[0]?.labels).toEqual(["bug"]);
  });

  it("imports accepted candidates through append + link paths", async () => {
    const projectRoot = await makeProjectDir("bender-gh-work-items-import-");
    const state = new StateManager(projectRoot);
    await state.init();
    await state.writeCurrentTaskPlan({
      version: 1,
      generatedAt: new Date().toISOString(),
      tasks: [{
        id: "task-1",
        title: "Seed task",
        description: "Existing task",
        acceptanceCriteria: ["done"],
        implementerAgentId: "implementer",
        status: "todo",
      }],
    });
    await state.setTaskGitHubLink("task-1", {
      repoFullName: "acme/repo",
      issueNumber: 41,
      issueUrl: "https://github.com/acme/repo/issues/41",
    });

    const imported = await importGitHubWorkItems(projectRoot, {
      candidates: [{
        id: "candidate-77",
        sourceType: "issue",
        sourceIssueNumber: 77,
        sourceIssueUrl: "https://github.com/acme/repo/issues/77",
        sourceTitle: "Fix project settings",
        repoFullName: "acme/repo",
        title: "Implement issue #77",
        description: "Apply project-scoped ingestion updates.",
        dependencies: "1",
        acceptanceCriteria: ["All issue requirements implemented"],
        suggestedFiles: ["src/cli/services/github-work-items.ts"],
      }],
    });

    expect(imported.repoFullName).toBe("acme/repo");
    expect(imported.imported).toEqual([
      {
        candidateId: "candidate-77",
        taskId: "task-2",
        issueNumber: 77,
      },
    ]);

    const plan = await state.readCurrentTaskPlan();
    expect(plan?.tasks).toHaveLength(2);
    expect(plan?.tasks[1]?.title).toBe("Implement issue #77");
    expect(plan?.tasks[1]?.acceptanceCriteria).toContain("All issue requirements implemented");
    expect(plan?.tasks[1]?.acceptanceCriteria).toContain("Dependency context from issue ingestion: 1");

    const links = await state.readTaskGitHubLinks();
    expect(links["task-2"]?.repoFullName).toBe("acme/repo");
    expect(links["task-2"]?.issueNumber).toBe(77);
    expect(links["task-2"]?.issueUrl).toBe("https://github.com/acme/repo/issues/77");
  });

  it("rejects imports targeting a different repo", async () => {
    const projectRoot = await makeProjectDir("bender-gh-work-items-repo-mismatch-");
    const state = new StateManager(projectRoot);
    await state.init();
    await state.setTaskGitHubLink("task-1", {
      repoFullName: "acme/repo",
      issueNumber: 10,
    });

    let thrown: unknown;
    try {
      await importGitHubWorkItems(projectRoot, {
        candidates: [{
          sourceType: "issue",
          sourceIssueNumber: 11,
          sourceIssueUrl: "https://github.com/other/repo/issues/11",
          sourceTitle: "Other repo issue",
          repoFullName: "other/repo",
          title: "Should fail",
        }],
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(GitHubWorkItemsServiceError);
    expect((thrown as GitHubWorkItemsServiceError).status).toBe(400);
    expect((thrown as Error).message).toContain("targets 'other/repo'");
  });
});
