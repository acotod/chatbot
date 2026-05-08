import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { clearTabSession } from "@/lib/tabManager";

const ACCESS_TOKEN_STORAGE_KEY = "agent_token";
const AUTH_STORAGE_KEY = "agent-auth-storage";
let inMemoryAgentToken: string | null = null;

function safeSessionStorageGet(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSessionStorageSet(key: string, value: string) {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.setItem(key, value);
  } catch {
    // Ignore storage failures and keep session in memory.
  }
}

function safeSessionStorageRemove(key: string) {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.removeItem(key);
  } catch {
    // Ignore storage failures and keep cleanup best-effort.
  }
}

type PersistedAgentAuthState = {
  token?: string | null;
};

function readPersistedAgentAuthState(): PersistedAgentAuthState | null {
  if (typeof window === "undefined") return null;

  try {
    const raw = sessionStorage.getItem(AUTH_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { state?: PersistedAgentAuthState };
    return parsed?.state ?? null;
  } catch {
    return null;
  }
}

export function getStoredAgentAccessToken(): string | null {
  if (typeof window === "undefined") return null;

  const directToken = safeSessionStorageGet(ACCESS_TOKEN_STORAGE_KEY);
  if (directToken) return directToken;

  if (inMemoryAgentToken) return inMemoryAgentToken;

  const persistedToken = readPersistedAgentAuthState()?.token ?? null;
  if (persistedToken) {
    safeSessionStorageSet(ACCESS_TOKEN_STORAGE_KEY, persistedToken);
    inMemoryAgentToken = persistedToken;
  }

  return persistedToken;
}

export function clearStoredAgentAuth() {
  if (typeof window === "undefined") return;
  inMemoryAgentToken = null;
  safeSessionStorageRemove(ACCESS_TOKEN_STORAGE_KEY);
  safeSessionStorageRemove(AUTH_STORAGE_KEY);
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
        safeSessionStorageSet(ACCESS_TOKEN_STORAGE_KEY, token);
        set({ token, tokenExpiresAt: parseJwtExpToUnixMs(token) });
      },
      logout: () => {
        clearStoredAgentAuth();
        set({ token: null, tokenExpiresAt: null });
      },
    }),
    {
      name: AUTH_STORAGE_KEY,
      storage: createJSONStorage(() => (typeof window === "undefined" ? undefined : sessionStorage)),
      partialize: (s) => ({
        token: s.token,
        tokenExpiresAt: s.tokenExpiresAt,
      }),
    }
  )
);