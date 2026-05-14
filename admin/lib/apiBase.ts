function isLocalHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "0.0.0.0";
}

function parseHostname(rawUrl: string): string | null {
  try {
    return new URL(rawUrl).hostname;
  } catch {
    return null;
  }
}

function mapAdminOrAgentHostToApi(hostname: string): string | null {
  const labels = hostname.split(".");
  const roleIndex = labels.findIndex((label) => label === "admin" || label === "agente");
  if (roleIndex === -1) return null;
  labels[roleIndex] = "api";
  return labels.join(".");
}

function resolveApiFromWindow(): string {
  const { hostname, protocol, port, origin } = window.location;

  // Keep local-dev behavior explicit and deterministic.
  if (isLocalHostname(hostname)) {
    return `${protocol}//${hostname}:3200`;
  }

  const mappedApiHost = mapAdminOrAgentHostToApi(hostname);
  if (mappedApiHost) {
    return `${protocol}//${mappedApiHost}${port ? `:${port}` : ""}`;
  }

  // If running custom local domains with a non-standard admin port, assume API at :3200.
  if (port === "3001") {
    return `${protocol}//${hostname}:3200`;
  }

  return origin;
}

export function resolveApiBaseFromEnvOrWindow(envBase: string | undefined): string {
  const trimmedEnvBase = envBase?.trim();

  if (trimmedEnvBase) {
    if (typeof window !== "undefined") {
      const currentHost = window.location.hostname;
      const envHost = parseHostname(trimmedEnvBase);

      // Ignore localhost/loopback API URLs when running on a real remote host.
      if (!(envHost && isLocalHostname(envHost) && !isLocalHostname(currentHost))) {
        return trimmedEnvBase.replace(/\/+$/, "");
      }
    } else {
      return trimmedEnvBase.replace(/\/+$/, "");
    }
  }

  if (typeof window !== "undefined") {
    return resolveApiFromWindow();
  }

  return "http://127.0.0.1:3200";
}
