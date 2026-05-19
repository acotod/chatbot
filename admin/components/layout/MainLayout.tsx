"use client";

import { useEffect, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { usePathname } from "next/navigation";
import { getStoredAccessToken } from "@/store/auth";
import { getStoredAgentAccessToken } from "@/store/agentAuth";
import { Sidebar } from "./Sidebar";
import { Header } from "./Header";

function subscribeToClientSnapshot() {
  return () => {};
}

function getClientSnapshot() {
  return true;
}

function getServerSnapshot() {
  return false;
}

export default function MainLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const isClient = useSyncExternalStore(
    subscribeToClientSnapshot,
    getClientSnapshot,
    getServerSnapshot
  );
  const hasAccessToken = isClient && Boolean(getStoredAccessToken());
  const hasAgentAccessToken = isClient && Boolean(getStoredAgentAccessToken());
  const allowAgentSharedRoute = [
    "/dashboard",
    "/solicitudes",
    "/agenda",
    "/contactos",
    "/agente/perfil",
    "/agente/security",
  ].includes(pathname) && hasAgentAccessToken;

  useEffect(() => {
    if (!isClient) return;
    // Allow access if admin token OR agent on shared route
    if (hasAccessToken || allowAgentSharedRoute) return;
    // If agent token exists but can't access this route, redirect to agent login
    if (hasAgentAccessToken) {
      router.replace("/agente/login");
      return;
    }
    // Otherwise redirect to admin login
    router.replace("/login");
  }, [hasAccessToken, hasAgentAccessToken, isClient, allowAgentSharedRoute, router]);

  if (!isClient || (!hasAccessToken && !allowAgentSharedRoute)) {
    return <div className="min-h-screen bg-[#0a0f14]" />;
  }

  return (
    <div className="relative flex h-screen overflow-hidden text-[#e6f5f9]">
      <div className="pointer-events-none absolute -left-36 -top-36 h-96 w-96 rounded-full bg-[#00BFAE]/12 blur-3xl" />
      <div className="pointer-events-none absolute -right-28 top-12 h-80 w-80 rounded-full bg-[#39E6D2]/10 blur-3xl" />
      <Sidebar />
      <div className="relative z-10 flex min-w-0 flex-1 flex-col">
        <Header />
        <main className="flex-1 overflow-y-auto p-6">{children}</main>
      </div>
    </div>
  );
}
