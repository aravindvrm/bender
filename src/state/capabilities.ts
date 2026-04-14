import type { McpServerConfig } from "./config.js";

export type CapabilityId =
  | "github.repo.read"
  | "github.repo.write"
  | "github.issue.read"
  | "github.issue.write"
  | "github.pr.read"
  | "github.pr.comment"
  | "github.branch.manage"
  | "github.clone"
  | `connector.${string}.use`;

export interface CapabilityPolicy {
  allow?: CapabilityId[];
  deny?: CapabilityId[];
}

export interface CapabilityResolutionInput {
  capabilityPolicy?: CapabilityPolicy;
  /** Backward compatibility path (legacy model). */
  mcpServerIds?: string[];
}

export interface ResolvedCapabilities {
  allow: Set<CapabilityId>;
  deny: Set<CapabilityId>;
}

export interface ConnectorResolution {
  allowedConnectorIds: Set<string>;
  capabilities: ResolvedCapabilities;
}

const GITHUB_CAPABILITIES: CapabilityId[] = [
  "github.repo.read",
  "github.repo.write",
  "github.issue.read",
  "github.issue.write",
  "github.pr.read",
  "github.pr.comment",
  "github.branch.manage",
  "github.clone",
];

export const CONNECTOR_CAPABILITY_MAP: Record<string, CapabilityId[]> = {
  github: [
    "connector.github.use",
    ...GITHUB_CAPABILITIES,
  ],
  figma: ["connector.figma.use"],
  neon: ["connector.neon.use"],
  vercel: ["connector.vercel.use"],
};

function isCapabilityId(value: string): value is CapabilityId {
  return (
    value.startsWith("github.")
    || value.startsWith("connector.")
  );
}

export function normalizeCapabilityPolicy(input: unknown): CapabilityPolicy | undefined {
  if (!input || typeof input !== "object") return undefined;
  const policy = input as Record<string, unknown>;

  const allow = Array.isArray(policy.allow)
    ? [...new Set(policy.allow.filter((v): v is string => typeof v === "string").map((v) => v.trim()).filter(isCapabilityId))]
    : [];
  const deny = Array.isArray(policy.deny)
    ? [...new Set(policy.deny.filter((v): v is string => typeof v === "string").map((v) => v.trim()).filter(isCapabilityId))]
    : [];

  if (allow.length === 0 && deny.length === 0) return undefined;
  return {
    ...(allow.length > 0 ? { allow } : {}),
    ...(deny.length > 0 ? { deny } : {}),
  };
}

function toConnectorCapability(id: string): CapabilityId {
  return `connector.${id}.use`;
}

function deriveLegacyCapabilities(mcpServerIds: string[]): CapabilityId[] {
  const caps: CapabilityId[] = [];
  for (const id of mcpServerIds) {
    const trimmed = id.trim();
    if (!trimmed) continue;
    caps.push(...(CONNECTOR_CAPABILITY_MAP[trimmed] ?? [toConnectorCapability(trimmed)]));
  }
  return [...new Set(caps)];
}

export function resolveCapabilities(input: CapabilityResolutionInput): ResolvedCapabilities {
  const allow = new Set<CapabilityId>();
  const deny = new Set<CapabilityId>();

  const legacy = deriveLegacyCapabilities(input.mcpServerIds ?? []);
  for (const c of legacy) allow.add(c);

  const policy = normalizeCapabilityPolicy(input.capabilityPolicy);
  for (const c of policy?.allow ?? []) allow.add(c);
  for (const c of policy?.deny ?? []) deny.add(c);

  return { allow, deny };
}

function isDenied(
  cap: CapabilityId,
  deny: Set<CapabilityId>,
): boolean {
  if (deny.has(cap)) return true;
  if (cap.startsWith("github.") && deny.has("connector.github.use")) return true;
  return false;
}

export function hasCapability(
  resolved: ResolvedCapabilities,
  cap: CapabilityId,
): boolean {
  if (isDenied(cap, resolved.deny)) return false;
  return resolved.allow.has(cap);
}

export function resolveConnectorAccess(
  input: CapabilityResolutionInput,
  servers: McpServerConfig[],
): ConnectorResolution {
  const capabilities = resolveCapabilities(input);
  const allowedConnectorIds = new Set<string>();

  for (const server of servers) {
    const id = server.id?.trim();
    if (!id) continue;
    const connectorCap = toConnectorCapability(id);
    const allowed = hasCapability(capabilities, connectorCap);
    if (allowed) {
      allowedConnectorIds.add(id);
      continue;
    }
    if (id === "github" && GITHUB_CAPABILITIES.some((c) => hasCapability(capabilities, c))) {
      allowedConnectorIds.add(id);
    }
  }

  return { allowedConnectorIds, capabilities };
}

export function getConnectorCapabilities(connectorId: string): CapabilityId[] {
  return CONNECTOR_CAPABILITY_MAP[connectorId] ?? [toConnectorCapability(connectorId)];
}
