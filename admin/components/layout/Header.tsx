"use client";

import { tenantApi } from "@/lib/api";
import { agentAuthApi } from "@/lib/agentApi";
import { useNotifications } from "@/hooks/useNotifications";
import { getMe } from "@/lib/useMe";
import { getStoredAgentAccessToken } from "@/store/agentAuth";
import { getStoredAccessToken, useAuthStore } from "@/store/auth";
import { useQuery } from "@tanstack/react-query";
import { Bell, Search } from "lucide-react";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

function subscribeToClientSnapshot() {
  return () => {};
}

function getClientSnapshot() {
  return true;
}

function getServerSnapshot() {
  return false;
}

interface TenantOption {
  id: string;
  slug: string;
  nombre?: unknown;
  logoUrl?: string;
}

function normalizeTenantName(nombre: unknown, slug: string): string {
  if (typeof nombre === "string" && nombre.trim()) return nombre;
  if (nombre && typeof nombre === "object" && "text" in (nombre as Record<string, unknown>)) {
    const text = (nombre as Record<string, unknown>).text;
    if (typeof text === "string" && text.trim()) return text;
  }
  return slug;
}

const TITLES: Record<string, string> = {
  "/dashboard": "Dashboard",
  "/conversaciones": "Conversaciones",
  "/solicitudes": "Solicitudes",
  "/agenda": "Agenda",
  "/agentes": "Agentes",
  "/configuracion": "Configuración",
  "/facturacion": "Facturación",
  "/tenants": "Empresas",
};

export function Header() {
  const pathname = usePathname();
  const { tenantSlug, setTenantSlug } = useAuthStore();
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const notificationsRef = useRef<HTMLDivElement | null>(null);
  const isClient = useSyncExternalStore(
    subscribeToClientSnapshot,
    getClientSnapshot,
    getServerSnapshot
  );
  const hasAccessToken = isClient && Boolean(getStoredAccessToken());
  const hasAgentAccessToken = isClient && Boolean(getStoredAgentAccessToken());
  const isAgentSession = hasAgentAccessToken && !hasAccessToken;
  const apiBase = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:3200";
  const sessionEmail = isClient ? (getMe()?.email ?? null) : null;

  const { data: agentProfile } = useQuery({
    queryKey: ["agent-header-profile"],
    queryFn: () => agentAuthApi.me().then((r) => r.data),
    enabled: isAgentSession,
    staleTime: 60_000,
  });

  const { data: tenants = [] } = useQuery<TenantOption[]>({
    queryKey: ["tenants", "header"],
    queryFn: async () => {
      const res = await tenantApi.list();
      return Array.isArray(res.data) ? res.data : [];
    },
    enabled: hasAccessToken,
    staleTime: 60_000,
  });

  useEffect(() => {
    if (tenants.length === 0) return;
    const hasSelectedTenant = tenants.some(
      (tenant: { slug: string }) => tenant.slug === tenantSlug
    );
    if (!tenantSlug || !hasSelectedTenant) {
      setTenantSlug(tenants[0].slug);
    }
  // setTenantSlug is a stable Zustand action — omitting it from deps prevents render loops
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantSlug, tenants]);

  const title =
    Object.entries(TITLES).find(([k]) => pathname.startsWith(k))?.[1] ??
    "Zentra Bot";

  const selectedTenant = tenants.find((tenant) => tenant.slug === tenantSlug);
  const selectedTenantName = selectedTenant
    ? normalizeTenantName(selectedTenant.nombre, selectedTenant.slug)
    : null;
  const tenantDisplayName = isAgentSession
    ? (agentProfile?.tenantNombre || agentProfile?.tenantSlug || "Agente")
    : (selectedTenantName || selectedTenant?.slug || tenantSlug || "Admin");
  const tenantLogoSrc = selectedTenant?.logoUrl
    ? selectedTenant.logoUrl.startsWith("http")
      ? selectedTenant.logoUrl
      : `${apiBase}${selectedTenant.logoUrl}`
    : null;
  const identityEmail = isAgentSession
    ? (agentProfile?.email ?? "Sesion de agente")
    : (sessionEmail ?? "Sin sesión");
  const identityInitial = isAgentSession
    ? ((agentProfile?.nombre || "Agente").charAt(0).toUpperCase())
    : tenantDisplayName.charAt(0).toUpperCase();
  const {
    notifications,
    unreadCount,
    isLoading: isLoadingNotifications,
    markAsRead,
    markAllAsRead,
    isMarkingAll,
  } = useNotifications(tenantSlug || null, selectedTenant?.id ?? null);

  useEffect(() => {
    if (!notificationsOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!notificationsRef.current) return;
      if (!notificationsRef.current.contains(event.target as Node)) {
        setNotificationsOpen(false);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [notificationsOpen]);

  return (
    <header className="h-16 bg-white border-b border-slate-200 flex items-center justify-between px-6 shrink-0">
      <h1 className="text-slate-900 font-semibold text-lg">{title}</h1>

      <div className="flex items-center gap-3">
        {/* Tenant selector */}
        {!isAgentSession && (
        <div className="hidden sm:block">
          <select
            value={tenantSlug}
            onChange={(e) => setTenantSlug(e.target.value)}
            className="px-3 py-2 rounded-xl bg-slate-50 border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/30 min-w-44"
          >
            {tenants.length === 0 && <option value="">Sin empresas</option>}
            {tenants.map((tenant) => (
              <option key={tenant.id} value={tenant.slug}>
                {`${normalizeTenantName(tenant.nombre, tenant.slug)} (${tenant.slug})`}
              </option>
            ))}
          </select>
        </div>
        )}

        {/* Search */}
        {!isAgentSession && (
        <div className="relative hidden md:block">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <input
            placeholder="Buscar..."
            className="pl-9 pr-4 py-2 rounded-xl bg-slate-50 border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/30 w-56"
          />
        </div>
        )}

        {/* Notifications */}
        {!isAgentSession && (
        <div className="relative" ref={notificationsRef}>
          <button
            type="button"
            onClick={() => setNotificationsOpen((v) => !v)}
            title="Notificaciones"
            className="relative p-2 rounded-xl bg-slate-50 border border-slate-200 hover:bg-slate-100"
          >
            <Bell className="w-5 h-5 text-slate-600" />
            {unreadCount > 0 && (
              <span className="absolute -top-1 -right-1 min-w-5 h-5 px-1 rounded-full bg-red-600 text-white text-[10px] font-semibold flex items-center justify-center">
                {unreadCount > 99 ? "99+" : unreadCount}
              </span>
            )}
            <span className="sr-only">Notificaciones</span>
          </button>

          {notificationsOpen && (
            <div className="absolute right-0 mt-2 w-96 max-w-[calc(100vw-2rem)] rounded-2xl border border-slate-200 bg-white shadow-lg z-40 overflow-hidden">
              <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
                <div>
                  <p className="text-sm font-semibold text-slate-900">Notificaciones</p>
                  <p className="text-xs text-slate-500">{unreadCount} sin leer</p>
                </div>
                <button
                  type="button"
                  onClick={() => markAllAsRead()}
                  disabled={isMarkingAll || unreadCount === 0}
                  className="text-xs text-blue-700 disabled:text-slate-400"
                >
                  Marcar todas
                </button>
              </div>

              <div className="max-h-96 overflow-y-auto">
                {isLoadingNotifications && (
                  <div className="px-4 py-6 text-sm text-slate-500">Cargando notificaciones...</div>
                )}

                {!isLoadingNotifications && notifications.length === 0 && (
                  <div className="px-4 py-6 text-sm text-slate-500">No hay notificaciones.</div>
                )}

                {!isLoadingNotifications && notifications.map((item) => (
                  <div
                    key={item.id}
                    className={`px-4 py-3 border-b border-slate-100 ${item.readAt ? "bg-white" : "bg-blue-50/50"}`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-slate-900 truncate">{item.title}</p>
                        <p className="text-xs text-slate-600 mt-1 break-words">{item.message}</p>
                        <p className="text-[11px] text-slate-400 mt-1">
                          {new Date(item.createdAt).toLocaleString("es-CR")}
                        </p>
                      </div>
                      {!item.readAt && (
                        <button
                          type="button"
                          onClick={() => markAsRead(item.id)}
                          className="text-xs text-blue-700 whitespace-nowrap"
                        >
                          Marcar leída
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
        )}

        {/* Tenant identity */}
        <div className="flex items-center gap-2 pl-3 border-l border-slate-200">
          {!isAgentSession && tenantLogoSrc ? (
            <img
              src={tenantLogoSrc}
              alt={`Logo ${tenantDisplayName}`}
              className="w-8 h-8 rounded-full object-cover border border-slate-200"
            />
          ) : (
            <div className="w-8 h-8 rounded-full bg-blue-600 flex items-center justify-center text-white text-sm font-semibold">
              {identityInitial}
            </div>
          )}
          <div className="hidden md:flex flex-col leading-tight">
            <span className="text-sm text-slate-700">{tenantDisplayName}</span>
            <span className="text-xs text-slate-500">{identityEmail}</span>
          </div>
        </div>
      </div>
    </header>
  );
}
