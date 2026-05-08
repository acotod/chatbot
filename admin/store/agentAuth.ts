import { create } from "zustand";
import { persist } from "zustand/middleware";

const ACCESS_TOKEN_STORAGE_KEY = "agent_token";
const AUTH_STORAGE_KEY = "agent-auth-storage";

type PersistedAgentAuthState = {
  token?: string | null;
};

function syncAccessTokenCookie(token: string | null) {
  if (typeof document === "undefined" || typeof window === "undefined") return;
  const secureAttr = window.location.protocol === "https:" ? "; Secure" : "";

  if (token) {
    document.cookie = `agent_token=${token}; path=/; SameSite=Strict${secureAttr}; max-age=${60 * 60 * 8}`;
    return;
  }

  document.cookie = `agent_token=; path=/; SameSite=Strict${secureAttr}; max-age=0`;
}

function readPersistedAgentAuthState(): PersistedAgentAuthState | null {
  if (typeof window === "undefined") return null;

  try {
    const raw = localStorage.getItem(AUTH_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { state?: PersistedAgentAuthState };
    return parsed?.state ?? null;
  } catch {
    return null;
  }
}

export function getStoredAgentAccessToken(): string | null {
  if (typeof window === "undefined") return null;

  const directToken = localStorage.getItem(ACCESS_TOKEN_STORAGE_KEY);
  if (directToken) return directToken;

  const persistedToken = readPersistedAgentAuthState()?.token ?? null;
  if (persistedToken) {
    localStorage.setItem(ACCESS_TOKEN_STORAGE_KEY, persistedToken);
    syncAccessTokenCookie(persistedToken);
  }

  return persistedToken;
}

export function clearStoredAgentAuth() {
  if (typeof window === "undefined") return;
  localStorage.removeItem(ACCESS_TOKEN_STORAGE_KEY);
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

interface AgentAuthState {
  token: string | null;
  tokenExpiresAt: number | null;
  setToken: (token: string) => void;
  logout: () => void;
}

export const useAgentAuthStore = create<AgentAuthState>()(
  persist(
    (set) => ({
      token: null,
      tokenExpiresAt: null,
      setToken: (token) => {
        localStorage.setItem(ACCESS_TOKEN_STORAGE_KEY, token);
        syncAccessTokenCookie(token);
        set({ token, tokenExpiresAt: parseJwtExpToUnixMs(token) });
      },
      logout: () => {
        clearStoredAgentAuth();
        set({ token: null, tokenExpiresAt: null });
      },
    }),
    {
      name: AUTH_STORAGE_KEY,
      partialize: (s) => ({
        token: s.token,
        tokenExpiresAt: s.tokenExpiresAt,
      }),
    }
  )
);