/**
 * Decodes the JWT stored in localStorage and returns the current admin user's
 * basic identity: adminUserId, email, superAdmin, tenantId.
 * No network request — pure client-side decode of the already-validated token.
 */
export interface Me {
  adminUserId: number;
  email: string;
  superAdmin: boolean;
  tenantId: string | null;
}

function parseJwt(token: string): Record<string, unknown> | null {
  try {
    const base64 = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(base64));
  } catch {
    return null;
  }
}

export function getMe(): Me | null {
  if (typeof window === "undefined") return null;
  const token = localStorage.getItem("admin_token");
  if (!token) return null;
  const payload = parseJwt(token);
  if (!payload) return null;
  return {
    adminUserId: payload.adminUserId as number,
    email: payload.email as string,
    superAdmin: Boolean(payload.superAdmin),
    tenantId: (payload.tenantId as string | null) ?? null,
  };
}
