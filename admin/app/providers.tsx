"use client";

import { authApi } from "@/lib/api";
import { getStoredAgentAccessToken, useAgentAuthStore } from "@/store/agentAuth";
import { getStoredAccessToken, getStoredRefreshToken, useAuthStore } from "@/store/auth";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

const INACTIVITY_TIMEOUT_MS = 3 * 60 * 1000;
const INACTIVITY_CHECK_INTERVAL_MS = 5000;

function isPublicPage(pathname: string) {
  return pathname === "/facebook/data-deletion" || pathname.startsWith("/facebook/data-deletion/");
}

function SessionSecurityGuard() {
  const pathname = usePathname();
  const router = useRouter();
  const { token, refreshToken, tokenExpiresAt, logout } = useAuthStore();
  const agentLogout = useAgentAuthStore((state) => state.logout);
  const lastActivityAtRef = useRef<number>(0);
  const handledReloadGuardRef = useRef(false);
  const hasAccessToken = Boolean(token || getStoredAccessToken());
  const hasAgentAccessToken = Boolean(getStoredAgentAccessToken());
  const isAgentOnSharedRoute = ["/dashboard", "/conversaciones", "/solicitudes", "/agenda", "/contactos", "/agente/conversaciones"].includes(pathname) && hasAgentAccessToken;
  const effectiveRefreshToken = refreshToken ?? getStoredRefreshToken();

  useEffect(() => {
    if (handledReloadGuardRef.current) return;
    handledReloadGuardRef.current = true;

    if (typeof window === "undefined") return;

    const navEntries = window.performance.getEntriesByType("navigation");
    const navType = (navEntries[0] as PerformanceNavigationTiming | undefined)?.type;
    if (navType !== "reload") return;

    const currentPathname = window.location.pathname;

    if (isPublicPage(currentPathname)) return;

    // Explicit security behavior requested: hard refresh forces a fresh login.
    logout();
    agentLogout();

    if (currentPathname.startsWith("/portal")) return;

    if (currentPathname.startsWith("/agente")) {
      if (!currentPathname.startsWith("/agente/login")) {
        router.replace("/agente/login?reason=reload");
      }
      return;
    }

    if (!currentPathname.startsWith("/login")) {
      router.replace("/login?reason=reload");
    }
  }, [agentLogout, logout, router]);

  useEffect(() => {
    if (pathname.startsWith("/login") || pathname.startsWith("/portal") || pathname.startsWith("/agente") || isPublicPage(pathname)) return;
    if (hasAccessToken || isAgentOnSharedRoute) return;

    logout();
    router.replace("/login");
  }, [hasAccessToken, isAgentOnSharedRoute, logout, pathname, router]);

  useEffect(() => {
    if (!hasAccessToken || pathname.startsWith("/login") || pathname.startsWith("/agente") || isAgentOnSharedRoute || isPublicPage(pathname)) return;

    const now = Date.now();
    if (tokenExpiresAt && now >= tokenExpiresAt) {
      logout();
      router.replace("/login?reason=expired");
      return;
    }
  }, [hasAccessToken, tokenExpiresAt, pathname, isAgentOnSharedRoute, logout, router]);

  useEffect(() => {
    // CRITICAL: Do not run inactivity checks on login/auth pages to prevent logout loops
    const isAuthPage = 
      pathname === "/login" || 
      pathname?.startsWith("/login/") ||
      pathname === "/portal" ||
      pathname?.startsWith("/portal/") ||
      pathname === "/agente/login" ||
      pathname?.startsWith("/agente/login/") ||
      pathname === "/agente/register" ||
      pathname?.startsWith("/agente/register/") ||
      isPublicPage(pathname);
    
    if (!hasAccessToken || isAuthPage || isAgentOnSharedRoute) return;

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
  }, [hasAccessToken, effectiveRefreshToken, tokenExpiresAt, pathname, isAgentOnSharedRoute, logout, router]);

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
