import { simpleGit, type SimpleGit } from "simple-git";
import { existsSync } from "node:fs";
import { join } from "node:path";

export class GitOperations {
  private git: SimpleGit;

  constructor(private projectRoot: string) {
    this.git = simpleGit(projectRoot);
  }

  async isRepo(): Promise<boolean> {
    return existsSync(join(this.projectRoot, ".git"));
  }

  async init(): Promise<void> {
    if (!(await this.isRepo())) {
      await this.git.init();
    }
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
    return this.git.revparse(["--abbrev-ref", "HEAD"]);
  }

  async log(count: number = 10): Promise<{ hash: string; message: string; date: string }[]> {
    const log = await this.git.log({ maxCount: count });
    return log.all.map((entry) => ({
      hash: entry.hash.slice(0, 7),
      message: entry.message,
      date: entry.date,
    }));
  }

  async hasChanges(): Promise<boolean> {
    const status = await this.git.status();
    return !status.isClean();
  }

  async stageAll(): Promise<void> {
    await this.git.add("-A");
  }
}
