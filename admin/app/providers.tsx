"use client";

import { authApi } from "@/lib/api";
import { getStoredAccessToken, getStoredRefreshToken, useAuthStore } from "@/store/auth";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

const INACTIVITY_TIMEOUT_MS = 3 * 60 * 1000;
const INACTIVITY_CHECK_INTERVAL_MS = 5000;

function SessionSecurityGuard() {
  const pathname = usePathname();
  const router = useRouter();
  const { token, refreshToken, tokenExpiresAt, logout } = useAuthStore();
  const lastActivityAtRef = useRef<number>(0);
  const hasAccessToken = Boolean(token || getStoredAccessToken());
  const effectiveRefreshToken = refreshToken ?? getStoredRefreshToken();

  useEffect(() => {
    if (pathname.startsWith("/login") || pathname.startsWith("/portal") || pathname.startsWith("/agente")) return;
    if (hasAccessToken) return;

    logout();
    router.replace("/login");
  }, [hasAccessToken, logout, pathname, router]);

  useEffect(() => {
    if (!hasAccessToken || pathname.startsWith("/login") || pathname.startsWith("/agente")) return;

    const now = Date.now();
    if (tokenExpiresAt && now >= tokenExpiresAt) {
      logout();
      router.replace("/login?reason=expired");
      return;
    }
  }, [hasAccessToken, tokenExpiresAt, pathname, logout, router]);

  useEffect(() => {
    if (!hasAccessToken || pathname.startsWith("/login") || pathname.startsWith("/agente")) return;

    lastActivityAtRef.current = Date.now();

    const touch = () => {
      lastActivityAtRef.current = Date.now();
    };

    const runLogout = async (reason: "inactive" | "expired") => {
      try {
        if (hasAccessToken || effectiveRefreshToken) {
          await authApi.logout(effectiveRefreshToken ?? undefined);
        }
      } catch {
        // Best effort logout on server, always clear client state.
      } finally {
        logout();
        router.replace(`/login?reason=${reason}`);
      }
    };

    const checkSession = () => {
      const now = Date.now();

      if (tokenExpiresAt && now >= tokenExpiresAt) {
        void runLogout("expired");
        return;
      }

      if (now - lastActivityAtRef.current >= INACTIVITY_TIMEOUT_MS) {
        void runLogout("inactive");
      }
    };

    const events: Array<keyof WindowEventMap> = [
      "mousemove",
      "mousedown",
      "keydown",
      "scroll",
      "touchstart",
      "focus",
    ];

    events.forEach((eventName) => {
      window.addEventListener(eventName, touch, { passive: true });
    });

    const handleVisibility = () => {
      if (!document.hidden) {
        checkSession();
      }
    };

    document.addEventListener("visibilitychange", handleVisibility);

    const intervalId = window.setInterval(checkSession, INACTIVITY_CHECK_INTERVAL_MS);

    return () => {
      window.clearInterval(intervalId);
      events.forEach((eventName) => {
        window.removeEventListener(eventName, touch);
      });
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [hasAccessToken, effectiveRefreshToken, tokenExpiresAt, pathname, logout, router]);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === "admin_token" && !event.newValue) {
        logout();
        if (!pathname.startsWith("/login") && !pathname.startsWith("/agente")) {
          router.replace("/login?reason=signedout");
        }
      }
    };

    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [logout, pathname, router]);

  return null;
}

export function Providers({ children }: { children: React.ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 30_000, retry: 1 },
        },
      })
  );
  return (
    <QueryClientProvider client={client}>
      <SessionSecurityGuard />
      {children}
    </QueryClientProvider>
  );
}
