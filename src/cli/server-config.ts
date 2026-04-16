export const DEFAULT_API_PORT = 3142;

function parsePort(raw: string | undefined): number | null {
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return null;
  if (parsed <= 0 || parsed > 65535) return null;
  return parsed;
}

export function resolveServerPort(explicitPort?: number): number {
  if (Number.isFinite(explicitPort)) {
    const normalized = Math.floor(Number(explicitPort));
    if (normalized > 0 && normalized <= 65535) return normalized;
  }

  const fromBenderPort = parsePort(process.env.BENDER_PORT);
  if (fromBenderPort) return fromBenderPort;

  const fromPort = parsePort(process.env.PORT);
  if (fromPort) return fromPort;

  return DEFAULT_API_PORT;
}

export function isPortExplicitlyConfigured(): boolean {
  return parsePort(process.env.BENDER_PORT) !== null || parsePort(process.env.PORT) !== null;
}
