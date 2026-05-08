import { create } from "zustand";
import { persist } from "zustand/middleware";
import { normalizePermissions, type Permission } from "@/lib/permissions";

// Module-level refresh timer handle
let _proactiveRefreshTimer: ReturnType<typeof setTimeout> | null = null;

const ACCESS_TOKEN_STORAGE_KEY = "admin_token";
const REFRESH_TOKEN_STORAGE_KEY = "admin_refresh_token";
const AUTH_STORAGE_KEY = "auth-storage";

type PersistedAuthState = {
  token?: string | null;
  refreshToken?: string | null;
};

function syncAccessTokenCookie(token: string | null) {
  if (typeof document === "undefined" || typeof window === "undefined") return;
  const secureAttr = window.location.protocol === "https:" ? "; Secure" : "";

  if (token) {
    document.cookie = `admin_token=${token}; path=/; SameSite=Strict${secureAttr}; max-age=${60 * 60 * 8}`;
    return;
  }

  document.cookie = `admin_token=; path=/; SameSite=Strict${secureAttr}; max-age=0`;
}

function readPersistedAuthState(): PersistedAuthState | null {
  if (typeof window === "undefined") return null;

  try {
    const raw = localStorage.getItem(AUTH_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { state?: PersistedAuthState };
    return parsed?.state ?? null;
  } catch {
    return null;
  }
}

export function getStoredAccessToken(): string | null {
  if (typeof window === "undefined") return null;

  const directToken = localStorage.getItem(ACCESS_TOKEN_STORAGE_KEY);
  if (directToken) return directToken;

  const persistedToken = readPersistedAuthState()?.token ?? null;
  if (persistedToken) {
    localStorage.setItem(ACCESS_TOKEN_STORAGE_KEY, persistedToken);
    syncAccessTokenCookie(persistedToken);
  }

  return persistedToken;
}

export function getStoredRefreshToken(): string | null {
  if (typeof window === "undefined") return null;

  const directToken = localStorage.getItem(REFRESH_TOKEN_STORAGE_KEY);
  if (directToken) return directToken;

  const persistedToken = readPersistedAuthState()?.refreshToken ?? null;
  if (persistedToken) {
    localStorage.setItem(REFRESH_TOKEN_STORAGE_KEY, persistedToken);
  }

  return persistedToken;
}

export function clearStoredAuth() {
  if (typeof window === "undefined") return;
  localStorage.removeItem(ACCESS_TOKEN_STORAGE_KEY);
  localStorage.removeItem(REFRESH_TOKEN_STORAGE_KEY);
  localStorage.removeItem(AUTH_STORAGE_KEY);
  syncAccessTokenCookie(null);
}

function parseJwtExpToUnixMs(token: string): number | null {
  try {
    const payload = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))) as {
      exp?: number;
    };
    if (typeof payload.exp !== "number") return null;
    return payload.exp * 1000;
  } catch {
    return null;
  }
}

/** Schedule a proactive token refresh ~2 minutes before expiry. */
export function scheduleProactiveRefresh(
  expiresIn: number,
  doRefresh: () => Promise<void>
) {
  if (typeof window === "undefined") return;
  if (_proactiveRefreshTimer) clearTimeout(_proactiveRefreshTimer);
  const delay = Math.max((expiresIn - 120) * 1000, 5000); // refresh 2min early, min 5s
  _proactiveRefreshTimer = setTimeout(async () => {
    try {
      await doRefresh();
    } catch {
      // If proactive refresh fails, the reactive interceptor in api.ts will handle it
    }
  }, delay);
}

interface AuthState {
  token: string | null;
  refreshToken: string | null;
  tokenExpiresAt: number | null; // Unix ms
  tenantSlug: string;
  superAdmin: boolean;
  permissions: Permission[];
  setToken: (token: string, expiresIn?: number) => void;
  setRefreshToken: (token: string | null) => void;
  setTenantSlug: (slug: string) => void;
  setPermissions: (superAdmin: boolean, permissions: Permission[]) => void;
  logout: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      token: null,
      refreshToken: null,
        tokenExpiresAt: null,
      tenantSlug: "",
      superAdmin: false,
      permissions: [],
      setToken: (token, expiresIn) => {
        localStorage.setItem(ACCESS_TOKEN_STORAGE_KEY, token);
        syncAccessTokenCookie(token);
        const tokenExpiresAt = expiresIn
          ? Date.now() + expiresIn * 1000
          : parseJwtExpToUnixMs(token);
        set({ token, tokenExpiresAt });
      },
      setRefreshToken: (token) => {
        if (token) {
          localStorage.setItem(REFRESH_TOKEN_STORAGE_KEY, token);
        } else {
          localStorage.removeItem(REFRESH_TOKEN_STORAGE_KEY);
        }
        set({ refreshToken: token });
      },
      setTenantSlug: (tenantSlug) => set({ tenantSlug }),
      setPermissions: (superAdmin, permissions) =>
        set({ superAdmin, permissions: normalizePermissions(permissions) }),
      logout: () => {
        clearStoredAuth();
        if (_proactiveRefreshTimer) {
          clearTimeout(_proactiveRefreshTimer);
          _proactiveRefreshTimer = null;
        }
        set({ token: null, refreshToken: null, tokenExpiresAt: null, tenantSlug: "", superAdmin: false, permissions: [] });
      },
    }),
    {
      name: "auth-storage",
      partialize: (s) => ({
        token: s.token,
        refreshToken: s.refreshToken,
          tokenExpiresAt: s.tokenExpiresAt,
        tenantSlug: s.tenantSlug,
        superAdmin: s.superAdmin,
        permissions: s.permissions,
      }),
    }
  )
);
