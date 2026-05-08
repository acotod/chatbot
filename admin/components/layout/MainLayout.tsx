"use client";

import { useEffect, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { getStoredAccessToken, useAuthStore } from "@/store/auth";
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
  const token = useAuthStore((state) => state.token);
  const isClient = useSyncExternalStore(
    subscribeToClientSnapshot,
    getClientSnapshot,
    getServerSnapshot
  );
  const hasAccessToken = isClient && Boolean(token || getStoredAccessToken());

  useEffect(() => {
    if (!isClient || hasAccessToken) return;
    router.replace("/login");
  }, [hasAccessToken, isClient, router]);

  if (!isClient || !hasAccessToken) {
    return <div className="min-h-screen bg-slate-50" />;
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
