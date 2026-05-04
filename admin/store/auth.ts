import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Permission } from "@/lib/permissions";

// Module-level refresh timer handle
let _proactiveRefreshTimer: ReturnType<typeof setTimeout> | null = null;

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
        localStorage.setItem("admin_token", token);
        // Sync to cookie so Next.js middleware can read it (server-side)
        if (typeof document !== "undefined") {
          document.cookie = `admin_token=${token}; path=/; SameSite=Strict; max-age=${60 * 60 * 8}`;
        }
        const tokenExpiresAt = expiresIn ? Date.now() + expiresIn * 1000 : null;
        set({ token, tokenExpiresAt });
      },
      setRefreshToken: (token) => {
        if (token) {
          localStorage.setItem("admin_refresh_token", token);
        } else {
          localStorage.removeItem("admin_refresh_token");
        }
        set({ refreshToken: token });
      },
      setTenantSlug: (tenantSlug) => set({ tenantSlug }),
      setPermissions: (superAdmin, permissions) => set({ superAdmin, permissions }),
      logout: () => {
        localStorage.removeItem("admin_token");
        localStorage.removeItem("admin_refresh_token");
        localStorage.removeItem("auth-storage");
        // Clear cookie so middleware redirects to /login immediately
        if (typeof document !== "undefined") {
          document.cookie = "admin_token=; path=/; SameSite=Strict; max-age=0";
        }
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
