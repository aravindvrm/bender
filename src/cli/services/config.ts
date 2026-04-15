import { readGlobalConfig, writeGlobalConfig } from "../../state/config.js";

const MASK = "••••••••";

function maskSecret(value?: string): string | undefined {
  return value && value.trim() ? MASK : value;
}

function maskConfigSecrets(config: Awaited<ReturnType<typeof readGlobalConfig>>) {
  const maskedProviders = Object.fromEntries(
    Object.entries(config.providers ?? {}).map(([provider, entry]) => [
      provider,
      { ...entry, apiKey: maskSecret(entry.apiKey) },
    ]),
  );

  const maskedServers = (config.mcp?.servers ?? []).map((server) => ({
    ...server,
    authorizationToken: maskSecret(server.authorizationToken),
    headers: server.headers
      ? Object.fromEntries(
          Object.entries(server.headers).map(([key, value]) => [key, maskSecret(value) ?? value]),
        )
      : server.headers,
  }));

  return {
    ...config,
    llm: {
      ...config.llm,
      apiKey: maskSecret(config.llm.apiKey),
    },
    providers: maskedProviders,
    mcp: {
      ...config.mcp,
      servers: maskedServers,
    },
  };
}

export async function getGlobalConfig(projectRoot: string | null): Promise<Record<string, unknown>> {
  const config = await readGlobalConfig();
  return {
    scope: "global",
    projectRoot,
    ...maskConfigSecrets(config),
  };
}

export async function updateGlobalConfig(updates: Record<string, unknown>): Promise<void> {
  const current = await readGlobalConfig();

  const typedUpdates = updates as Partial<typeof current>;

  const mergedProviders: { [k: string]: { apiKey?: string } } = { ...current.providers };
  if (typedUpdates.providers) {
    for (const [name, providerConfig] of Object.entries(typedUpdates.providers)) {
      if (providerConfig.apiKey && providerConfig.apiKey !== MASK) {
        mergedProviders[name] = { apiKey: providerConfig.apiKey };
      } else if (!providerConfig.apiKey) {
        mergedProviders[name] = { apiKey: undefined };
      }
    }
  }

  const mergedMcpServers = (() => {
    const incoming = typedUpdates.mcp?.servers;
    if (!incoming) return current.mcp?.servers ?? [];

    return incoming.map((server, index) => {
      const existing = current.mcp?.servers?.[index];

      const mergedHeaders = (() => {
        if (!server.headers) return existing?.headers;
        const mapped = Object.fromEntries(
          Object.entries(server.headers).map(([key, value]) => {
            if (value === MASK) return [key, existing?.headers?.[key] ?? ""];
            return [key, value];
          }),
        );
        const cleaned = Object.fromEntries(
          Object.entries(mapped).filter(([, value]) => String(value).trim() !== ""),
        );
        return Object.keys(cleaned).length > 0 ? cleaned : undefined;
      })();

      return {
        ...existing,
        ...server,
        authorizationToken:
          server.authorizationToken === MASK
            ? existing?.authorizationToken
            : (server.authorizationToken || undefined),
        headers: mergedHeaders,
      };
    });
  })();

  const nextConfig = {
    ...current,
    ...typedUpdates,
    llm: {
      ...current.llm,
      ...typedUpdates.llm,
      apiKey: typedUpdates.llm?.apiKey && typedUpdates.llm.apiKey !== MASK
        ? typedUpdates.llm.apiKey
        : current.llm.apiKey,
      models: { ...current.llm.models, ...typedUpdates.llm?.models },
    },
    providers: mergedProviders,
    mcp: {
      ...current.mcp,
      ...typedUpdates.mcp,
      servers: mergedMcpServers,
    },
    skills: {
      ...current.skills,
      ...typedUpdates.skills,
      paths: typedUpdates.skills?.paths ?? current.skills?.paths,
      maxChars: typedUpdates.skills?.maxChars ?? current.skills?.maxChars,
    },
    stack: { ...current.stack, ...typedUpdates.stack },
    deploy: { ...current.deploy, ...typedUpdates.deploy },
    test: { ...current.test, ...typedUpdates.test },
    reanalyze: { ...current.reanalyze, ...typedUpdates.reanalyze },
    logging: { ...current.logging, ...typedUpdates.logging },
    security: {
      ...current.security,
      ...typedUpdates.security,
      terminalExec: {
        ...current.security?.terminalExec,
        ...typedUpdates.security?.terminalExec,
      },
    },
  };

  await writeGlobalConfig(nextConfig);
}
