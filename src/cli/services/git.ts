import { platform as osPlatform } from "node:os";
import { spawn } from "node:child_process";
import { simpleGit } from "simple-git";
import { GitOperations } from "../../git/operations.js";

interface RepoStateSnapshot {
  branch: string | null;
  clean: boolean;
  ahead: number;
  behind: number;
  staged: string[];
  modified: string[];
  deleted: string[];
  untracked: string[];
  remotes: { name: string; fetch: string; push: string }[];
}

export interface GitIdentity {
  name: string;
  email: string;
  nameScope: "local" | "global" | "unset";
  emailScope: "local" | "global" | "unset";
  credentialHelper: string;
  credentialHelperScope: "local" | "global" | "unset";
  platform: string;
}

export class GitServiceError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function emptyRepoState(overrides: Partial<RepoStateSnapshot> = {}): RepoStateSnapshot {
  return {
    branch: null,
    clean: false,
    ahead: 0,
    behind: 0,
    staged: [],
    modified: [],
    deleted: [],
    untracked: [],
    remotes: [],
    ...overrides,
  };
}

async function readGitConfigValue(projectRoot: string, key: string, global = false): Promise<string | null> {
  const git = simpleGit(projectRoot);
  const args = ["config"];
  if (global) args.push("--global");
  args.push("--get", key);
  const value = await git.raw(args).catch(() => "");
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

async function setGitConfigValue(projectRoot: string, key: string, value: string, global = false): Promise<void> {
  const git = simpleGit(projectRoot);
  const args = ["config"];
  if (global) args.push("--global");
  args.push(key, value);
  await git.raw(args);
}

async function approveGitHubCredential(projectRoot: string, username: string, token: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("git", ["credential", "approve"], {
      cwd: projectRoot,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(stderr.trim() || `git credential approve exited with code ${code}`));
      }
    });

    child.stdin.write("protocol=https\n");
    child.stdin.write("host=github.com\n");
    child.stdin.write(`username=${username}\n`);
    child.stdin.write(`password=${token}\n\n`);
    child.stdin.end();
  });
}

function defaultCredentialHelper(): string {
  if (osPlatform() === "darwin") return "osxkeychain";
  if (osPlatform() === "win32") return "manager-core";
  return "cache --timeout=7200";
}

async function requireRepo(projectRoot: string): Promise<GitOperations> {
  const gitOps = new GitOperations(projectRoot);
  if (!(await gitOps.isRepo())) {
    throw new GitServiceError(400, "Not a git repository");
  }
  return gitOps;
}

export async function getGitRepoState(projectRoot: string): Promise<{ isRepo: boolean } & RepoStateSnapshot & { error?: string }> {
  const gitOps = new GitOperations(projectRoot);
  const isRepo = await gitOps.isRepo();
  if (!isRepo) {
    return {
      isRepo: false,
      ...emptyRepoState({ clean: true }),
    };
  }

  try {
    const repo = await gitOps.getRepoState();
    return { isRepo: true, ...repo };
  } catch (err) {
    const rawMessage = (err as Error).message;
    const message = rawMessage.includes("did not match the expected pattern")
      ? "Git metadata could not be parsed. Reinitialize Git to repair this repository."
      : rawMessage;
    const likelyNotRepo = /not a git repository/i.test(message);
    return {
      isRepo: !likelyNotRepo,
      ...emptyRepoState(),
      error: message,
    };
  }
}

export async function initGitRepo(projectRoot: string, force: boolean): Promise<{ ok: true } & RepoStateSnapshot> {
  const gitOps = new GitOperations(projectRoot);
  await gitOps.init(force);
  const repo = await gitOps.getRepoState().catch(() => emptyRepoState());
  return { ok: true, ...repo };
}

export async function setGitRemote(projectRoot: string, input: { name?: string; url?: string }): Promise<{ ok: true } & RepoStateSnapshot> {
  const remoteName = (input.name ?? "origin").trim();
  const remoteUrl = (input.url ?? "").trim();
  if (!remoteName) throw new GitServiceError(400, "name is required");
  if (!remoteUrl) throw new GitServiceError(400, "url is required");

  const gitOps = await requireRepo(projectRoot);
  await gitOps.setRemote(remoteName, remoteUrl);
  const repo = await gitOps.getRepoState().catch(() => emptyRepoState());
  return { ok: true, ...repo };
}

export async function getGitIdentity(projectRoot: string): Promise<GitIdentity> {
  const localName = await readGitConfigValue(projectRoot, "user.name", false);
  const localEmail = await readGitConfigValue(projectRoot, "user.email", false);
  const globalName = await readGitConfigValue(projectRoot, "user.name", true);
  const globalEmail = await readGitConfigValue(projectRoot, "user.email", true);
  const localHelper = await readGitConfigValue(projectRoot, "credential.helper", false);
  const globalHelper = await readGitConfigValue(projectRoot, "credential.helper", true);

  return {
    name: localName ?? globalName ?? "",
    email: localEmail ?? globalEmail ?? "",
    nameScope: localName ? "local" : globalName ? "global" : "unset",
    emailScope: localEmail ? "local" : globalEmail ? "global" : "unset",
    credentialHelper: localHelper ?? globalHelper ?? "",
    credentialHelperScope: localHelper ? "local" : globalHelper ? "global" : "unset",
    platform: osPlatform(),
  };
}

export async function setGitIdentity(
  projectRoot: string,
  input: { name?: string; email?: string; scope?: "local" | "global" },
): Promise<{ ok: true }> {
  const normalizedName = (input.name ?? "").trim();
  const normalizedEmail = (input.email ?? "").trim();
  const targetScope = input.scope === "global" ? "global" : "local";

  if (!normalizedName && !normalizedEmail) {
    throw new GitServiceError(400, "name or email is required");
  }

  if (normalizedName) {
    await setGitConfigValue(projectRoot, "user.name", normalizedName, targetScope === "global");
  }
  if (normalizedEmail) {
    await setGitConfigValue(projectRoot, "user.email", normalizedEmail, targetScope === "global");
  }

  return { ok: true };
}

export async function setGitCredentialHelper(
  projectRoot: string,
  input: { helper?: string; scope?: "local" | "global" },
): Promise<{ ok: true; helper: string; scope: "local" | "global" }> {
  const targetScope = input.scope === "global" ? "global" : "local";
  const normalizedHelper = (input.helper ?? "").trim() || defaultCredentialHelper();
  await setGitConfigValue(projectRoot, "credential.helper", normalizedHelper, targetScope === "global");
  return { ok: true, helper: normalizedHelper, scope: targetScope };
}

export async function storeGitHubCredential(
  projectRoot: string,
  input: { username?: string; token?: string },
): Promise<{ ok: true }> {
  const normalizedUsername = (input.username ?? "").trim();
  const normalizedToken = (input.token ?? "").trim();
  if (!normalizedUsername) throw new GitServiceError(400, "username is required");
  if (!normalizedToken) throw new GitServiceError(400, "token is required");

  const helper = await readGitConfigValue(projectRoot, "credential.helper", false)
    ?? await readGitConfigValue(projectRoot, "credential.helper", true);
  if (!helper) {
    await setGitConfigValue(projectRoot, "credential.helper", defaultCredentialHelper(), false);
  }
  await approveGitHubCredential(projectRoot, normalizedUsername, normalizedToken);
  return { ok: true };
}

export async function listGitBranches(projectRoot: string): Promise<{ current: string; all: string[] }> {
  const gitOps = await requireRepo(projectRoot);
  return await gitOps.getBranches().catch(() => ({ current: "", all: [] }));
}

export async function checkoutGitBranch(
  projectRoot: string,
  input: { branch?: string; create?: boolean },
): Promise<{ ok: true } & RepoStateSnapshot> {
  const nextBranch = (input.branch ?? "").trim();
  if (!nextBranch) throw new GitServiceError(400, "branch is required");
  const gitOps = await requireRepo(projectRoot);
  await gitOps.checkoutBranch(nextBranch, !!input.create);
  const repo = await gitOps.getRepoState();
  return { ok: true, ...repo };
}

export async function stageGit(
  projectRoot: string,
  input: { path?: string; all?: boolean },
): Promise<{ ok: true } & RepoStateSnapshot> {
  const gitOps = await requireRepo(projectRoot);
  if (input.all) {
    await gitOps.stageAll();
  } else if (input.path?.trim()) {
    await gitOps.stageFile(input.path.trim());
  } else {
    throw new GitServiceError(400, "path or all required");
  }
  const repo = await gitOps.getRepoState();
  return { ok: true, ...repo };
}

export async function unstageGit(projectRoot: string, input: { path?: string }): Promise<{ ok: true } & RepoStateSnapshot> {
  const path = (input.path ?? "").trim();
  if (!path) throw new GitServiceError(400, "path is required");
  const gitOps = await requireRepo(projectRoot);
  await gitOps.unstageFile(path);
  const repo = await gitOps.getRepoState();
  return { ok: true, ...repo };
}

export async function discardGit(projectRoot: string, input: { path?: string }): Promise<{ ok: true } & RepoStateSnapshot> {
  const path = (input.path ?? "").trim();
  if (!path) throw new GitServiceError(400, "path is required");
  const gitOps = await requireRepo(projectRoot);
  await gitOps.discardFile(path);
  const repo = await gitOps.getRepoState();
  return { ok: true, ...repo };
}

export async function commitGit(projectRoot: string, input: { message?: string }): Promise<{ ok: true; commit: string } & RepoStateSnapshot> {
  const commitMessage = (input.message ?? "").trim();
  if (!commitMessage) throw new GitServiceError(400, "message is required");
  const gitOps = await requireRepo(projectRoot);
  const hash = await gitOps.commitAll(commitMessage);
  const repo = await gitOps.getRepoState();
  return { ok: true, commit: hash, ...repo };
}

export async function fetchGit(projectRoot: string): Promise<{ ok: true } & RepoStateSnapshot> {
  const gitOps = await requireRepo(projectRoot);
  await gitOps.fetch();
  const repo = await gitOps.getRepoState();
  return { ok: true, ...repo };
}

export async function pullGit(
  projectRoot: string,
  input: { remote?: string; branch?: string },
): Promise<{ ok: true } & RepoStateSnapshot> {
  const gitOps = await requireRepo(projectRoot);
  await gitOps.pull((input.remote ?? "origin").trim() || "origin", input.branch?.trim() || undefined);
  const repo = await gitOps.getRepoState();
  return { ok: true, ...repo };
}

export async function pushGit(
  projectRoot: string,
  input: { remote?: string; branch?: string },
): Promise<{ ok: true } & RepoStateSnapshot> {
  const gitOps = await requireRepo(projectRoot);
  await gitOps.push((input.remote ?? "origin").trim() || "origin", input.branch?.trim() || undefined);
  const repo = await gitOps.getRepoState();
  return { ok: true, ...repo };
}

export async function getGitDiff(
  projectRoot: string,
  commitsQuery: unknown,
): Promise<{ diff: string | null }> {
  const gitOps = new GitOperations(projectRoot);
  if (!(await gitOps.isRepo())) {
    return { diff: null };
  }
  const parsed = Number.parseInt(String(commitsQuery ?? "1"), 10);
  const requestedCommits = Number.isFinite(parsed) && parsed > 0 ? parsed : 1;

  let commitCount = 0;
  try {
    const logWindow = await gitOps.log(Math.max(1, requestedCommits + 1));
    commitCount = logWindow.length;
  } catch {
    commitCount = 0;
  }

  if (commitCount === 0) {
    const diff = await gitOps.getDiff();
    return { diff };
  }

  if (commitCount === 1) {
    const diff = await gitOps.getCommitPatch("HEAD");
    return { diff };
  }

  const maxReachableCommits = commitCount - 1;
  const effectiveCommits = Math.min(requestedCommits, maxReachableCommits);
  const diff = await gitOps.getDiffRange(`HEAD~${effectiveCommits}..HEAD`);
  return { diff };
}
