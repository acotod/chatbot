"use client";

import { useEffect, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { usePathname } from "next/navigation";
import { getStoredAccessToken, useAuthStore } from "@/store/auth";
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
  const token = useAuthStore((state) => state.token);
  const isClient = useSyncExternalStore(
    subscribeToClientSnapshot,
    getClientSnapshot,
    getServerSnapshot
  );
  const hasAccessToken = isClient && Boolean(token || getStoredAccessToken());
  const hasAgentAccessToken = isClient && Boolean(getStoredAgentAccessToken());
  const allowAgentSharedDashboard = pathname === "/dashboard" && hasAgentAccessToken;

  useEffect(() => {
    if (!isClient || hasAccessToken || allowAgentSharedDashboard) return;
    router.replace("/login");
  }, [hasAccessToken, isClient, allowAgentSharedDashboard, router]);

  if (!isClient || (!hasAccessToken && !allowAgentSharedDashboard)) {
    return <div className="min-h-screen bg-slate-50" />;
  }

  if (allowAgentSharedDashboard && !hasAccessToken) {
    return <main className="min-h-screen bg-slate-50 p-6">{children}</main>;
  }

  return (
    <div className="flex h-screen bg-slate-50 overflow-hidden">
      <Sidebar />
      <div className="flex-1 flex flex-col min-w-0">
        <Header />
        <main className="flex-1 overflow-y-auto p-6">{children}</main>
      </div>
    </div>
  );
}
