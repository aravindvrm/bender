import {
  readConfig,
  readEffectiveConfig,
  readGlobalConfig,
  writeConfig,
  writeGlobalConfig,
  type BenderConfig,
} from "../../state/config.js";

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
  if (projectRoot) {
    const config = await readEffectiveConfig(projectRoot);
    return {
      scope: "project",
      projectRoot,
      ...maskConfigSecrets(config),
    };
  }

  const config = await readGlobalConfig();
  return {
    scope: "global",
    projectRoot,
    ...maskConfigSecrets(config),
  };
}

function mergeConfigUpdates(
  current: BenderConfig,
  updates: Record<string, unknown>,
  fallbacks: BenderConfig[] = [],
): BenderConfig {
  const typedUpdates = updates as Partial<typeof current>;

  const mergedProviders: { [k: string]: {
    apiKey?: string;
    baseUrl?: string;
    model?: string;
    supportsTools?: boolean;
    supportsJson?: boolean;
    supportsStreaming?: boolean;
    modelCapabilities?: Record<string, {
      supportsTools?: boolean;
      supportsJson?: boolean;
      supportsStreaming?: boolean;
      endpoint?: string;
      apiStyle?: "chat" | "responses" | "auto";
      errors?: string[];
    }>;
  } } = { ...current.providers };
  if (typedUpdates.providers) {
    for (const [name, providerConfig] of Object.entries(typedUpdates.providers)) {
      if (providerConfig.apiKey && providerConfig.apiKey !== MASK) {
        mergedProviders[name] = {
          ...mergedProviders[name],
          ...providerConfig,
          modelCapabilities: {
            ...(mergedProviders[name]?.modelCapabilities ?? {}),
            ...(providerConfig.modelCapabilities ?? {}),
          },
          apiKey: providerConfig.apiKey,
        };
      } else if (!providerConfig.apiKey) {
        mergedProviders[name] = {
          ...mergedProviders[name],
          ...providerConfig,
          modelCapabilities: {
            ...(mergedProviders[name]?.modelCapabilities ?? {}),
            ...(providerConfig.modelCapabilities ?? {}),
          },
          apiKey: undefined,
        };
      } else {
        const fallbackApiKey = fallbacks
          .map((cfg) => cfg.providers?.[name]?.apiKey)
          .find((value) => typeof value === "string" && value.trim().length > 0);
        mergedProviders[name] = {
          ...mergedProviders[name],
          ...providerConfig,
          modelCapabilities: {
            ...(mergedProviders[name]?.modelCapabilities ?? {}),
            ...(providerConfig.modelCapabilities ?? {}),
          },
          apiKey: mergedProviders[name]?.apiKey ?? fallbackApiKey,
        };
      }
    }
  }

  function findFallbackServers(
    incoming: { id?: string; name?: string; url?: string },
    index: number,
  ) {
    const matches: Array<{
      authorizationToken?: string;
      headers?: Record<string, string>;
    }> = [];
    for (const cfg of fallbacks) {
      const fallbackServers = cfg.mcp?.servers ?? [];
      if (incoming.id) {
        const byId = fallbackServers.find((server) => server.id === incoming.id);
        if (byId) {
          matches.push(byId);
          continue;
        }
      }
      if (incoming.name && incoming.url) {
        const byNameUrl = fallbackServers.find((server) => server.name === incoming.name && server.url === incoming.url);
        if (byNameUrl) {
          matches.push(byNameUrl);
          continue;
        }
      }
      const byIndex = fallbackServers[index];
      if (byIndex) matches.push(byIndex);
    }
    return matches;
  }

  const mergedMcpServers = (() => {
    const incoming = typedUpdates.mcp?.servers;
    if (!incoming) return current.mcp?.servers ?? [];

    return incoming.map((server, index) => {
      const existing = current.mcp?.servers?.[index];
      const fallbackServersForEntry = findFallbackServers(server, index);
      const fallbackServer = fallbackServersForEntry[0];
      const fallbackAuthorizationToken = fallbackServersForEntry
        .map((item) => item.authorizationToken)
        .find((value) => typeof value === "string" && value.trim().length > 0);

      const mergedHeaders = (() => {
        if (!server.headers) return existing?.headers;
        const mapped = Object.fromEntries(
          Object.entries(server.headers).map(([key, value]) => {
            if (value === MASK) {
              const fallbackHeader = fallbackServersForEntry
                .map((item) => item.headers?.[key])
                .find((entry) => typeof entry === "string" && entry.trim().length > 0);
              return [key, existing?.headers?.[key] ?? fallbackHeader ?? ""];
            }
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
            ? (existing?.authorizationToken ?? fallbackAuthorizationToken)
            : (server.authorizationToken || undefined),
        headers: mergedHeaders,
      };
    });
  })();

  return {
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
}

export async function updateGlobalConfig(updates: Record<string, unknown>, projectRoot?: string | null): Promise<void> {
  if (projectRoot) {
    const [current, effective, global] = await Promise.all([
      readConfig(projectRoot),
      readEffectiveConfig(projectRoot),
      readGlobalConfig(),
    ]);
    const nextConfig = mergeConfigUpdates(current, updates, [effective, global]);
    await writeConfig(projectRoot, nextConfig);
    return;
  }

  const current = await readGlobalConfig();
  const nextConfig = mergeConfigUpdates(current, updates, [current]);
  await writeGlobalConfig(nextConfig);
}
