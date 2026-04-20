import { useEffect, useRef, useState } from "react";
import { Field, TextInput, SectionHeader, defaultGitHubRedirectUri } from "./shared";
import type {
  GitHubAuthStatus,
  GitHubAuthConfig,
  GitHubDeviceFlowStart,
  GitHubDeviceFlowPoll,
} from "./types";

export function GitHubSection() {
  const [githubStatus, setGithubStatus] = useState<GitHubAuthStatus | null>(null);
  const [githubConfig, setGithubConfig] = useState<GitHubAuthConfig | null>(null);
  const [githubClientIdInput, setGithubClientIdInput] = useState("");
  const [githubClientSecretInput, setGithubClientSecretInput] = useState("");
  const [githubRedirectUriInput, setGithubRedirectUriInput] = useState(defaultGitHubRedirectUri());
  const [githubDeviceFlow, setGithubDeviceFlow] = useState<GitHubDeviceFlowStart | null>(null);
  const [githubLoading, setGithubLoading] = useState(false);
  const [githubSaving, setGithubSaving] = useState(false);
  const [githubError, setGithubError] = useState<string | null>(null);
  const [githubNotice, setGithubNotice] = useState<string | null>(null);
  const githubPollTimerRef = useRef<number | null>(null);

  useEffect(() => {
    void refreshGitHub();
    return () => clearGitHubAuthPolling();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function clearGitHubAuthPolling() {
    if (githubPollTimerRef.current !== null) {
      window.clearTimeout(githubPollTimerRef.current);
      githubPollTimerRef.current = null;
    }
  }

  async function refreshGitHub() {
    setGithubLoading(true);
    setGithubError(null);
    try {
      const [cfgRes, statusRes] = await Promise.all([
        fetch("/api/github/auth/config"),
        fetch("/api/github/auth/status"),
      ]);
      const cfgBody = await cfgRes.json();
      const statusBody = await statusRes.json();
      if (!cfgRes.ok) throw new Error(cfgBody.error ?? "Failed to load GitHub auth config");
      if (!statusRes.ok) throw new Error(statusBody.error ?? "Failed to load GitHub auth status");
      const cfg = cfgBody as GitHubAuthConfig;
      setGithubConfig(cfg);
      setGithubClientIdInput(cfg.storedClientId || cfg.clientId || "");
      setGithubRedirectUriInput(cfg.redirectUri || defaultGitHubRedirectUri());
      setGithubStatus(statusBody as GitHubAuthStatus);
    } catch (err) {
      setGithubError((err as Error).message);
    } finally {
      setGithubLoading(false);
    }
  }

  function startGitHubDevicePolling(sessionId: string, intervalSec: number) {
    clearGitHubAuthPolling();
    const tick = async () => {
      try {
        const res = await fetch("/api/github/device/poll", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId }),
        });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error ?? "Failed to poll GitHub authorization");
        const poll = body as GitHubDeviceFlowPoll;
        if (poll.status === "connected") {
          setGithubNotice(poll.login ? `Connected as @${poll.login}` : "GitHub connected.");
          setGithubDeviceFlow(null);
          clearGitHubAuthPolling();
          await refreshGitHub();
          return;
        }
        if (poll.status === "pending") {
          const nextSec = Math.max(1, poll.intervalSec ?? intervalSec);
          githubPollTimerRef.current = window.setTimeout(() => void tick(), nextSec * 1000);
          return;
        }
        setGithubNotice(
          poll.status === "denied"
            ? "GitHub authorization was denied."
            : "GitHub device code expired. Start again.",
        );
        setGithubDeviceFlow(null);
        clearGitHubAuthPolling();
      } catch (err) {
        setGithubError((err as Error).message);
        setGithubDeviceFlow(null);
        clearGitHubAuthPolling();
      }
    };
    githubPollTimerRef.current = window.setTimeout(() => void tick(), Math.max(1, intervalSec) * 1000);
  }

  async function handleSaveGitHubConfig() {
    setGithubSaving(true);
    setGithubError(null);
    setGithubNotice(null);
    try {
      const payload: { clientId: string; redirectUri: string; clientSecret?: string } = {
        clientId: githubClientIdInput.trim(),
        redirectUri: githubRedirectUriInput.trim(),
      };
      if (githubClientSecretInput.trim()) {
        payload.clientSecret = githubClientSecretInput.trim();
      }
      const res = await fetch("/api/github/auth/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Failed to save GitHub auth config");
      setGithubClientSecretInput("");
      await refreshGitHub();
      setGithubNotice("GitHub settings saved.");
    } catch (err) {
      setGithubError((err as Error).message);
    } finally {
      setGithubSaving(false);
    }
  }

  async function handleConnectGitHub() {
    setGithubError(null);
    setGithubNotice("Waiting for GitHub authorization...");
    try {
      const res = await fetch("/api/github/device/start", { method: "POST" });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Failed to start GitHub device flow");
      const flow = body as GitHubDeviceFlowStart;
      setGithubDeviceFlow(flow);
      window.open(flow.verificationUriComplete || flow.verificationUri, "_blank", "noopener,noreferrer");
      startGitHubDevicePolling(flow.sessionId, flow.intervalSec);
    } catch (err) {
      setGithubError((err as Error).message);
      setGithubNotice(null);
    }
  }

  async function handleDisconnectGitHub() {
    setGithubError(null);
    setGithubNotice(null);
    clearGitHubAuthPolling();
    try {
      const res = await fetch("/api/github/auth/disconnect", { method: "POST" });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Failed to disconnect GitHub");
      setGithubDeviceFlow(null);
      await refreshGitHub();
      setGithubNotice("Disconnected GitHub session.");
    } catch (err) {
      setGithubError((err as Error).message);
    }
  }

  const githubConnected = !!githubStatus?.connected;
  const githubConfigured = !!githubStatus?.configured;
  const githubClientIdLocked = !!githubConfig?.usingEnvClientId;
  const githubClientSecretLocked = !!githubConfig?.usingEnvClientSecret;

  return (
    <section>
      <SectionHeader
        title="GitHub"
        description="Machine-level GitHub auth config used by project picker and Git workflows."
      />

      <Field label="Connection">
        <div className="space-y-2">
          <p className={`text-xs ${githubConnected ? "text-emerald-400" : "text-zinc-500"}`}>
            {githubConnected ? `Connected${githubStatus?.login ? ` as @${githubStatus.login}` : ""}` : "Not connected"}
          </p>
          {!githubConfigured && (
            <p className="text-xs text-amber-400">
              {githubStatus?.message ?? "Set a GitHub App Client ID to enable device login."}
            </p>
          )}
          {githubDeviceFlow && (
            <div className="rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 space-y-1">
              <p className="text-[11px] text-zinc-500">Device code</p>
              <p className="text-sm text-zinc-200 font-mono">{githubDeviceFlow.userCode}</p>
            </div>
          )}
          <div className="flex gap-2">
            {!githubConnected ? (
              <button
                onClick={() => void handleConnectGitHub()}
                disabled={githubLoading || !githubConfigured}
                className="px-3 py-1.5 rounded-md text-xs border border-zinc-700 text-zinc-300 hover:border-zinc-500 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Connect GitHub
              </button>
            ) : (
              <button
                onClick={() => void handleDisconnectGitHub()}
                disabled={githubLoading}
                className="px-3 py-1.5 rounded-md text-xs border border-zinc-700 text-zinc-300 hover:border-zinc-500 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Disconnect
              </button>
            )}
            <button
              onClick={() => void refreshGitHub()}
              disabled={githubLoading}
              className="px-3 py-1.5 rounded-md text-xs border border-zinc-800 text-zinc-400 hover:border-zinc-600 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Refresh
            </button>
          </div>
        </div>
      </Field>

      <Field label="Client ID">
        <TextInput
          value={githubClientIdInput}
          onChange={setGithubClientIdInput}
          placeholder="GitHub App Client ID"
          mono
        />
        {githubClientIdLocked && <p className="text-[11px] text-zinc-500 mt-1">Using environment value.</p>}
      </Field>

      <Field label="Client Secret">
        <TextInput
          value={githubClientSecretInput}
          onChange={setGithubClientSecretInput}
          placeholder={githubConfig?.clientSecretSet ? "Stored (leave blank to keep unchanged)" : "Optional for OAuth callback flow"}
          password
          mono
        />
        {githubClientSecretLocked && <p className="text-[11px] text-zinc-500 mt-1">Using environment value.</p>}
      </Field>

      <Field label="Redirect URI">
        <TextInput
          value={githubRedirectUriInput}
          onChange={setGithubRedirectUriInput}
          placeholder={defaultGitHubRedirectUri()}
          mono
        />
      </Field>

      {(githubError || githubNotice) && (
        <p className={`text-xs mt-3 ${githubError ? "text-red-400" : "text-zinc-500"}`}>
          {githubError ?? githubNotice}
        </p>
      )}

      <div className="mt-4">
        <button
          onClick={() => void handleSaveGitHubConfig()}
          disabled={githubSaving}
          className="px-3 py-1.5 rounded-md text-xs border border-zinc-700 text-zinc-300 hover:border-zinc-500 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {githubSaving ? "Saving..." : "Save GitHub settings"}
        </button>
      </div>
    </section>
  );
}
