import { create } from "zustand";
import { persist } from "zustand/middleware";
import { clearTabSession } from "@/lib/tabManager";

const ACCESS_TOKEN_STORAGE_KEY = "agent_token";
const AUTH_STORAGE_KEY = "agent-auth-storage";
let inMemoryAgentToken: string | null = null;

function safeStorageGet(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeStorageSet(key: string, value: string) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(key, value);
  } catch {
    // Ignore storage failures and keep session in memory.
  }
}

function safeStorageRemove(key: string) {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(key);
  } catch {
    // Ignore storage failures and keep cleanup best-effort.
  }
}

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

  const directToken = safeStorageGet(ACCESS_TOKEN_STORAGE_KEY);
  if (directToken) return directToken;

  if (inMemoryAgentToken) return inMemoryAgentToken;

  const persistedToken = readPersistedAgentAuthState()?.token ?? null;
  if (persistedToken) {
    safeStorageSet(ACCESS_TOKEN_STORAGE_KEY, persistedToken);
    inMemoryAgentToken = persistedToken;
    syncAccessTokenCookie(persistedToken);
  }

  return persistedToken;
}

export function clearStoredAgentAuth() {
  if (typeof window === "undefined") return;
  inMemoryAgentToken = null;
  safeStorageRemove(ACCESS_TOKEN_STORAGE_KEY);
  safeStorageRemove(AUTH_STORAGE_KEY);
  syncAccessTokenCookie(null);
  clearTabSession();
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
        inMemoryAgentToken = token;
        safeStorageSet(ACCESS_TOKEN_STORAGE_KEY, token);
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