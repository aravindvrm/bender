import { simpleGit, type SimpleGit } from "simple-git";

interface GitOperationsOptions {
  timeoutMs?: number;
}

export class GitOperations {
  private git: SimpleGit;

  constructor(private projectRoot: string, options?: GitOperationsOptions) {
    const timeoutMs = typeof options?.timeoutMs === "number" && Number.isFinite(options.timeoutMs)
      ? Math.max(250, Math.floor(options.timeoutMs))
      : null;
    this.git = simpleGit(projectRoot, timeoutMs ? { timeout: { block: timeoutMs } } : undefined);
  }

  async isRepo(): Promise<boolean> {
    try {
      const output = await this.git.revparse(["--is-inside-work-tree"]);
      return output.trim() === "true";
    } catch {
      return false;
    }
  }

  async init(force = false): Promise<void> {
    if (force || !(await this.isRepo())) {
      await this.git.init();
    }
  }

  async getRemotes(): Promise<{ name: string; fetch: string; push: string }[]> {
    try {
      const remotes = await this.git.getRemotes(true);
      return remotes.map((remote) => ({
        name: remote.name,
        fetch: remote.refs.fetch ?? "",
        push: remote.refs.push ?? "",
      }));
    } catch {
      const raw = await this.git.raw(["remote", "-v"]).catch(() => "");
      const map = new Map<string, { name: string; fetch: string; push: string }>();
      for (const line of raw.split("\n")) {
        const match = line.trim().match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/);
        if (!match) continue;
        const name = match[1];
        const url = match[2];
        const kind = match[3];
        const current = map.get(name) ?? { name, fetch: "", push: "" };
        if (kind === "fetch") current.fetch = url;
        if (kind === "push") current.push = url;
        map.set(name, current);
      }
      return [...map.values()];
    }
  }

  async setRemote(name: string, url: string): Promise<void> {
    const remotes = await this.git.getRemotes(false);
    const exists = remotes.some((r) => r.name === name);
    if (exists) {
      await this.git.remote(["set-url", name, url]);
      return;
    }
    await this.git.addRemote(name, url);
  }

  async commitAll(message: string): Promise<string> {
    await this.git.add("-A");
    const result = await this.git.commit(message);
    return result.commit;
  }

  async commitFiles(files: string[], message: string): Promise<string> {
    await this.git.add(files);
    const result = await this.git.commit(message);
    return result.commit;
  }

  async getDiff(staged?: boolean): Promise<string> {
    if (staged) {
      return this.git.diff(["--cached"]);
    }
    return this.git.diff();
  }

  async getDiffRange(range: string): Promise<string> {
    return this.git.diff([range]);
  }

  async getDiffWithArgs(args: string[]): Promise<string> {
    return this.git.diff(args);
  }

  async getCommitPatch(ref: string): Promise<string> {
    return this.git.show([ref, "--format=", "--patch"]);
  }

  async getDiffStat(): Promise<string> {
    return this.git.diff(["--stat"]);
  }

  async getStatus(): Promise<{ modified: string[]; added: string[]; deleted: string[]; untracked: string[] }> {
    const status = await this.git.status();
    return {
      modified: status.modified,
      added: status.created,
      deleted: status.deleted,
      untracked: status.not_added,
    };
  }

  async createBranch(name: string): Promise<void> {
    await this.git.checkoutLocalBranch(name);
  }

  async getCurrentBranch(): Promise<string> {
    try {
      const branch = await this.git.revparse(["--abbrev-ref", "HEAD"]);
      return branch.trim() || "HEAD";
    } catch {
      const status = await this.git.status();
      return status.current || "HEAD";
    }
  }

  async log(count: number = 10): Promise<{ hash: string; message: string; date: string }[]> {
    const log = await this.git.log({ maxCount: count });
    return log.all.map((entry) => ({
      hash: entry.hash.slice(0, 7),
      message: entry.message,
      date: entry.date,
    }));
  }

  async hasChanges(includeUntracked = true): Promise<boolean> {
    const status = includeUntracked
      ? await this.git.status()
      : await this.git.status(["--untracked-files=no"]);
    return !status.isClean();
  }

  async getRepoState(): Promise<{
    branch: string;
    clean: boolean;
    ahead: number;
    behind: number;
    staged: string[];
    modified: string[];
    deleted: string[];
    untracked: string[];
    remotes: { name: string; fetch: string; push: string }[];
  }> {
    const status = await this.git.status();
    return {
      branch: status.current || "HEAD",
      clean: status.isClean(),
      ahead: status.ahead,
      behind: status.behind,
      staged: status.staged,
      modified: status.modified,
      deleted: status.deleted,
      untracked: status.not_added,
      remotes: await this.getRemotes(),
    };
  }

  async stageAll(): Promise<void> {
    await this.git.add("-A");
  }

  async stageFile(path: string): Promise<void> {
    await this.git.add(path);
  }

  async unstageFile(path: string): Promise<void> {
    await this.git.raw(["restore", "--staged", "--", path]);
  }

  async discardFile(path: string): Promise<void> {
    await this.git.raw(["restore", "--", path]);
  }

  async getBranches(): Promise<{ current: string; all: string[] }> {
    const branches = await this.git.branchLocal();
    return {
      current: branches.current || "",
      all: branches.all,
    };
  }

  async checkoutBranch(name: string, create = false): Promise<void> {
    if (create) {
      await this.git.checkoutLocalBranch(name);
      return;
    }
    await this.git.checkout(name);
  }

  async fetch(): Promise<void> {
    await this.git.fetch();
  }

  async pull(remote = "origin", branch?: string): Promise<void> {
    if (branch) {
      await this.git.pull(remote, branch);
      return;
    }
    await this.git.pull();
  }

  async push(remote = "origin", branch?: string): Promise<void> {
    if (branch) {
      await this.git.push(remote, branch);
      return;
    }
    await this.git.push();
  }
}
