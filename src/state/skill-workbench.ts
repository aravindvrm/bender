import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export interface SkillEvalCase {
  id: string;
  prompt: string;
  notes?: string;
}

export interface SkillEvalRun {
  id: string;
  skillId: string;
  prompt: string;
  withSkill: boolean;
  role: "analyzer" | "architect" | "planner" | "implementer" | "reviewer";
  modelTier: "fast" | "default" | "strong";
  output: string;
  createdAt: number;
  pass?: boolean;
  feedback?: string;
}

export interface SkillWorkbench {
  skillId: string;
  cases: SkillEvalCase[];
  runs: SkillEvalRun[];
}

interface SkillWorkbenchStore {
  workbenches: Record<string, SkillWorkbench>;
}

const STORE_PATH = join(homedir(), ".bender", "skill-workbench.json");

async function readStore(): Promise<SkillWorkbenchStore> {
  if (!existsSync(STORE_PATH)) return { workbenches: {} };
  try {
    const raw = await readFile(STORE_PATH, "utf-8");
    const parsed = JSON.parse(raw) as SkillWorkbenchStore;
    return parsed && typeof parsed === "object" && parsed.workbenches ? parsed : { workbenches: {} };
  } catch {
    return { workbenches: {} };
  }
}

async function writeStore(store: SkillWorkbenchStore): Promise<void> {
  const dir = dirname(STORE_PATH);
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  await writeFile(STORE_PATH, JSON.stringify(store, null, 2), "utf-8");
}

export async function getSkillWorkbench(skillId: string): Promise<SkillWorkbench> {
  const store = await readStore();
  const existing = store.workbenches[skillId];
  return existing ?? { skillId, cases: [], runs: [] };
}

export async function setSkillEvalCases(skillId: string, cases: SkillEvalCase[]): Promise<SkillWorkbench> {
  const store = await readStore();
  const current = store.workbenches[skillId] ?? { skillId, cases: [], runs: [] };
  const next: SkillWorkbench = {
    ...current,
    cases: cases
      .map((c) => ({
        id: c.id,
        prompt: c.prompt.trim(),
        notes: c.notes?.trim() || undefined,
      }))
      .filter((c) => c.id.trim() && c.prompt.trim()),
  };
  store.workbenches[skillId] = next;
  await writeStore(store);
  return next;
}

export async function appendSkillEvalRun(run: SkillEvalRun): Promise<SkillWorkbench> {
  const store = await readStore();
  const current = store.workbenches[run.skillId] ?? { skillId: run.skillId, cases: [], runs: [] };
  const next: SkillWorkbench = {
    ...current,
    runs: [run, ...current.runs].slice(0, 200),
  };
  store.workbenches[run.skillId] = next;
  await writeStore(store);
  return next;
}

export async function setSkillEvalRunFeedback(
  skillId: string,
  runId: string,
  feedback: { pass?: boolean; feedback?: string },
): Promise<SkillWorkbench> {
  const store = await readStore();
  const current = store.workbenches[skillId] ?? { skillId, cases: [], runs: [] };
  const runs = current.runs.map((r) => {
    if (r.id !== runId) return r;
    return {
      ...r,
      pass: feedback.pass,
      feedback: feedback.feedback?.trim() || undefined,
    };
  });
  const next: SkillWorkbench = { ...current, runs };
  store.workbenches[skillId] = next;
  await writeStore(store);
  return next;
}
