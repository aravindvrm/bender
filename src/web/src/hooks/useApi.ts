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
  apiContracts: string | null;
  config: {
    llm: { provider: string; models: { fast: string; default: string; strong: string } };
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

export async function saveConfig(updates: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${API_BASE}/config`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(updates),
  });
  if (!res.ok) {
    const body = await res.json();
    throw new Error(body.error ?? "Save failed");
  }
}

export async function selectProject(path: string): Promise<void> {
  const res = await fetch(`${API_BASE}/project/select`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
  if (!res.ok) {
    const body = await res.json();
    throw new Error(body.error ?? "Failed to select project");
  }
}

export async function openProject(path: string): Promise<void> {
  const res = await fetch(`${API_BASE}/project/open`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
  if (!res.ok) {
    const body = await res.json();
    throw new Error(body.error ?? "Failed to open project");
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
      const res = await fetch(`${API_BASE}/state`);
      if (!res.ok) throw new Error(await res.text());
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
