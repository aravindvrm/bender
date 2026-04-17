import { useState, useEffect, useCallback } from "react";

const API_BASE = "/api";

export interface ProjectState {
  initialized: boolean;
  projectRoot: string | null;
  brief: string | null;
  architecture: string | null;
  conventions: string | null;
  schema: string | null;
  decisions: { name: string; content: string }[];
  currentTasks: string | null;
  completedTasks: { name: string; content: string }[];
  taskAgents?: Record<string, string>;
  taskGitHubLinks?: Record<string, {
    repoFullName?: string;
    issueNumber?: number;
    issueUrl?: string;
    branchName?: string;
    prNumber?: number;
    prUrl?: string;
    lastSyncedAt?: number;
  }>;
  apiContracts: string | null;
  flows: string | null;
  config: {
    llm: {
      provider: string;
      models: {
        fast: string | { provider: string; model: string };
        default: string | { provider: string; model: string };
        strong: string | { provider: string; model: string };
      };
    };
    stack: { framework: string; database: string; orm: string; auth: string; styling: string; language: string };
  };
  git: {
    branch: string;
    clean: boolean;
    recentCommits: { hash: string; message: string; date: string }[];
  } | null;
}

export interface ProjectEntry {
  path: string;
  name: string;
  lastOpened: string;
}

const API_TIMEOUT_MS = 15_000;

async function fetchWithTimeout(url: string, init?: RequestInit, timeoutMs = API_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } catch (err) {
    if ((err as Error)?.name === "AbortError") {
      throw new Error(`Request timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function readApiError(res: Response, fallback: string): Promise<string> {
  const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
  if (contentType.includes("application/json")) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    if (body.error?.trim()) return body.error.trim();
  }
  const text = (await res.text().catch(() => "")).trim();
  if (text) return text.slice(0, 300);
  return fallback;
}

export async function saveConfig(updates: Record<string, unknown>): Promise<void> {
  const res = await fetchWithTimeout(`${API_BASE}/config`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(updates),
  });
  if (!res.ok) {
    throw new Error(await readApiError(res, "Save failed"));
  }
}

export async function selectProject(path: string): Promise<void> {
  const res = await fetchWithTimeout(`${API_BASE}/project/select`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  }, API_TIMEOUT_MS);
  if (!res.ok) {
    throw new Error(await readApiError(res, `Failed to select project (${res.status})`));
  }
}

export async function openProject(path: string): Promise<void> {
  const res = await fetchWithTimeout(`${API_BASE}/project/open`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  }, API_TIMEOUT_MS);
  if (!res.ok) {
    throw new Error(await readApiError(res, `Failed to open project (${res.status})`));
  }
}

export async function removeProject(path: string): Promise<void> {
  await fetch(`${API_BASE}/projects/${encodeURIComponent(path)}`, { method: "DELETE" });
}

export async function fetchProjects(): Promise<ProjectEntry[]> {
  const res = await fetch(`${API_BASE}/projects`);
  if (!res.ok) return [];
  return res.json();
}

export function useProjectState() {
  const [state, setState] = useState<ProjectState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetchWithTimeout(`${API_BASE}/state`);
      if (!res.ok) {
        throw new Error(await readApiError(res, `Failed to load project state (${res.status})`));
      }
      const data = await res.json();
      setState(data);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 5000);
    return () => clearInterval(interval);
  }, [refresh]);

  return { state, loading, error, refresh };
}
