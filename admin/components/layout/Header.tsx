"use client";

import { tenantApi } from "@/lib/api";
import { getMe } from "@/lib/useMe";
import { useAuthStore } from "@/store/auth";
import { useQuery } from "@tanstack/react-query";
import { Bell, Search } from "lucide-react";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

interface TenantOption {
  id: string;
  slug: string;
  nombre?: string;
  logoUrl?: string;
}

const TITLES: Record<string, string> = {
  "/dashboard": "Dashboard",
  "/conversaciones": "Conversaciones",
  "/solicitudes": "Solicitudes",
  "/agenda": "Agenda",
  "/agentes": "Agentes",
  "/configuracion": "Configuración",
  "/facturacion": "Facturación",
  "/tenants": "Tenants",
};

export function Header() {
  const pathname = usePathname();
  const { tenantSlug, setTenantSlug } = useAuthStore();
  const [mounted, setMounted] = useState(false);
  const [sessionEmail, setSessionEmail] = useState<string | null>(null);
  const apiBase = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:3200";

  useEffect(() => {
    setMounted(true);
    const me = getMe();
    setSessionEmail(me?.email ?? null);
  }, []);

  const { data: tenants = [] } = useQuery<TenantOption[]>({
    queryKey: ["tenants", "header"],
    queryFn: async () => {
      const res = await tenantApi.list();
      return Array.isArray(res.data) ? res.data : [];
    },
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
  const tenantDisplayName =
    selectedTenant?.nombre || selectedTenant?.slug || tenantSlug || "Admin";
  const tenantLogoSrc = selectedTenant?.logoUrl
    ? selectedTenant.logoUrl.startsWith("http")
      ? selectedTenant.logoUrl
      : `${apiBase}${selectedTenant.logoUrl}`
    : null;

  return (
    <header className="h-16 bg-white border-b border-slate-200 flex items-center justify-between px-6 shrink-0">
      <h1 className="text-slate-900 font-semibold text-lg">{title}</h1>

      <div className="flex items-center gap-3">
        {/* Tenant selector */}
        <div className="hidden sm:block">
          <select
            value={tenantSlug}
            onChange={(e) => setTenantSlug(e.target.value)}
            className="px-3 py-2 rounded-xl bg-slate-50 border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/30 min-w-44"
          >
            {tenants.length === 0 && <option value="">Sin tenants</option>}
            {tenants.map((tenant) => (
              <option key={tenant.id} value={tenant.slug}>
                {tenant.nombre ? `${tenant.nombre} (${tenant.slug})` : tenant.slug}
              </option>
            ))}
          </select>
        </div>

        {/* Search */}
        <div className="relative hidden md:block">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <input
            placeholder="Buscar..."
            className="pl-9 pr-4 py-2 rounded-xl bg-slate-50 border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/30 w-56"
          />
        </div>

        {/* Notifications */}
        <button
          type="button"
          disabled
          aria-disabled="true"
          title="Notificaciones: próximamente"
          className="relative p-2 rounded-xl bg-slate-50 cursor-not-allowed"
        >
          <Bell className="w-5 h-5 text-slate-500" />
          <span className="absolute top-1.5 right-1.5 w-2 h-2 bg-red-500 rounded-full" />
          <span className="sr-only">Notificaciones (próximamente)</span>
        </button>

        {/* Tenant identity */}
        <div className="flex items-center gap-2 pl-3 border-l border-slate-200">
          {tenantLogoSrc ? (
            <img
              src={tenantLogoSrc}
              alt={`Logo ${tenantDisplayName}`}
              className="w-8 h-8 rounded-full object-cover border border-slate-200"
            />
          ) : (
            <div className="w-8 h-8 rounded-full bg-blue-600 flex items-center justify-center text-white text-sm font-semibold">
              {tenantDisplayName.charAt(0).toUpperCase()}
            </div>
          )}
          <div className="hidden md:flex flex-col leading-tight">
            <span className="text-sm text-slate-700">{tenantDisplayName}</span>
            <span className="text-xs text-slate-500">{mounted ? (sessionEmail ?? "Sin sesión") : "Sin sesión"}</span>
          </div>
        </div>
      </div>
    </header>
  );
}
