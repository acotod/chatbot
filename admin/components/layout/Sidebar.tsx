"use client";

import { authApi, solicitudesApi, tenantApi } from "@/lib/api";
import { agentAuthApi } from "@/lib/agentApi";
import { addLog } from "@/lib/errorLogger";
import { buildPermissionSet, normalizePermissions, type Permission } from "@/lib/permissions";
import {
  filterAuthorizedNavItems,
  resolveAuthorizedFallback,
  resolveBlockedPathRedirect,
} from "@/lib/sidebarAccess";
import { cn } from "@/lib/utils";
import { useTranslations } from "@/lib/i18n/client";
import { useCurrentLocale } from "@/lib/i18n/client";
import { getStoredAccessToken, getStoredRefreshToken, useAuthStore } from "@/store/auth";
import { getStoredAgentAccessToken, useAgentAuthStore } from "@/store/agentAuth";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BarChart3,
  Building2,
  CalendarDays,
  ChevronDown,
  CreditCard,
  LayoutDashboard,
  LogOut,
  MessageCircle,
  UserCircle2,
  Settings,
  Users,
  ClipboardList,
  ScrollText,
  ShieldCheck,
  Webhook,
  Plug,
  TestTube2,
  Variable,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

function subscribeToClientSnapshot() {
  return () => {};
}

function getClientSnapshot() {
  return true;
}

function getServerSnapshot() {
  return false;
}

const NAV_ITEMS: Array<{
  icon: React.ComponentType<{ size?: number; className?: string }>;
  labelKey: string;
  href: string;
  permission?: Permission;
  permissions?: Permission[];
  superAdminOnly?: boolean;
}> = [
  { icon: LayoutDashboard, labelKey: "nav.dashboard", href: "/dashboard", permission: "VIEW_DASHBOARD" },
  { icon: MessageCircle, labelKey: "nav.conversations", href: "/conversaciones", permission: "VIEW_CONVERSACIONES" },
  { icon: ClipboardList, labelKey: "nav.requests", href: "/solicitudes", permission: "VIEW_SOLICITUDES" },
  { icon: BarChart3, labelKey: "nav.reports", href: "/reportes", permission: "VIEW_METRICS" },
  { icon: CalendarDays, labelKey: "nav.agenda", href: "/agenda", permission: "VIEW_AGENDA" },
  { icon: Users, labelKey: "nav.agents", href: "/agentes", permission: "VIEW_AGENTES" },
  { icon: UserCircle2, labelKey: "nav.contacts", href: "/contactos", permission: "VIEW_CRM" },
  { icon: Settings, labelKey: "nav.settings", href: "/configuracion", permission: "MANAGE_TENANTS" },
  { icon: ShieldCheck, labelKey: "nav.security", href: "/security" },
  { icon: CreditCard, labelKey: "nav.billing", href: "/facturacion", superAdminOnly: true },
  { icon: ScrollText, labelKey: "nav.audit", href: "/auditoria", permission: "VIEW_AUDITORIA" },
  { icon: ShieldCheck, labelKey: "nav.roles", href: "/roles", permission: "MANAGE_ROLES" },
  { icon: Users, labelKey: "nav.adminUsers", href: "/usuarios-admin", permissions: ["MANAGE_USERS", "MANAGE_ROLES"] },
  { icon: Building2, labelKey: "nav.companies", href: "/tenants", permission: "MANAGE_TENANTS" },
  { icon: Plug, labelKey: "nav.integrations", href: "/integraciones", permission: "MANAGE_TENANTS" },
  { icon: Variable, labelKey: "nav.variables", href: "/variables", permission: "EDIT_FLUJOS" },
  { icon: Webhook, labelKey: "nav.flows", href: "/waba-flujos", permission: "VIEW_FLUJOS" },
  { icon: Webhook, labelKey: "nav.webhooks", href: "/webhooks", permission: "MANAGE_WEBHOOKS" },
  { icon: TestTube2, labelKey: "nav.sandbox", href: "/sandbox", permission: "VIEW_SANDBOX" },
];

const AGENT_NAV_ITEMS: Array<{
  icon: React.ComponentType<{ size?: number; className?: string }>;
  labelKey: string;
  href: string;
}> = [
  { icon: LayoutDashboard, labelKey: "nav.dashboard", href: "/dashboard" },
  { icon: ClipboardList, labelKey: "nav.requests", href: "/solicitudes" },
  { icon: CalendarDays, labelKey: "nav.agenda", href: "/agenda" },
  { icon: UserCircle2, labelKey: "nav.contacts", href: "/contactos" },
  { icon: ShieldCheck, labelKey: "nav.security", href: "/agente/security" },
];

function stripLocalePrefix(pathname: string): string {
  if (pathname === "/en") return "/";
  if (pathname.startsWith("/en/")) return pathname.slice(3);
  if (pathname === "/es") return "/";
  if (pathname.startsWith("/es/")) return pathname.slice(3);
  return pathname;
}

export function Sidebar() {
  const t = useTranslations("common");
  const locale = useCurrentLocale();
  const pathname = usePathname();
  const normalizedPathname = stripLocalePrefix(pathname);
  const router = useRouter();
  const { logout, tenantSlug, superAdmin, permissions, setTenantSlug, setPermissions } = useAuthStore();
  const { logout: logoutAgent } = useAgentAuthStore();
  const isClient = useSyncExternalStore(
    subscribeToClientSnapshot,
    getClientSnapshot,
    getServerSnapshot
  );
  const hasAccessToken = isClient && Boolean(getStoredAccessToken());
  const hasAgentAccessToken = isClient && Boolean(getStoredAgentAccessToken());
  const isAgentSession = hasAgentAccessToken && !hasAccessToken;
  const queryClient = useQueryClient();

  const [tenants, setTenants] = useState<{ slug: string; nombre: string }[]>([]);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const withLocale = (path: string): string => {
    if (locale === "es") return path;
    if (path === "/") return `/${locale}`;
    return `/${locale}${path}`;
  };

  function normalizeTenantName(nombre: unknown, slug: string): string {
    if (typeof nombre === "string" && nombre.trim()) return nombre;
    if (nombre && typeof nombre === "object" && "text" in (nombre as Record<string, unknown>)) {
      const text = (nombre as Record<string, unknown>).text;
      if (typeof text === "string" && text.trim()) return text;
    }
    return slug;
  }

  const { data: meData, isLoading: authMeLoading } = useQuery({
    queryKey: ["auth-me"],
    queryFn: () => authApi.me().then((r) => r.data),
    enabled: hasAccessToken && !isAgentSession,
    staleTime: 60_000,
  });

  useEffect(() => {
    if (!meData) return;
    const normalizedPermissions = normalizePermissions(meData.permissions);

    setPermissions(Boolean(meData.superAdmin), normalizedPermissions);

    if (!meData.superAdmin && !tenantSlug && meData.tenantSlug) {
      setTenantSlug(meData.tenantSlug);
    }
  }, [meData, setPermissions, setTenantSlug, tenantSlug]);

  const permissionSet = useMemo(() => buildPermissionSet(permissions), [permissions]);

  // Fetch tenant list for superAdmins
  useEffect(() => {
    if (!superAdmin || !hasAccessToken) return;
    tenantApi.list().then((res) => {
      const data = (res.data as { slug: string; nombre: string }[]) ?? [];
      setTenants(data);
    }).catch(() => {});
  }, [hasAccessToken, superAdmin]);

  // Close dropdown on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  async function handleLogout() {
    if (isAgentSession) {
      try {
        await agentAuthApi.logout();
      } catch {
        // Best effort.
      } finally {
        queryClient.clear();
        logoutAgent();
        router.push(withLocale("/agente/login"));
      }
      return;
    }

    try {
      const refreshToken = getStoredRefreshToken() ?? undefined;
      if (hasAccessToken || refreshToken) {
        await authApi.logout(refreshToken);
      }
    } catch {
      // Best effort: even if API logout fails, clear client auth state.
    } finally {
      queryClient.clear();
      logout();
      router.push(withLocale("/login"));
    }
  }

  const accessContext = useMemo(
    () => ({ superAdmin, permissionSet }),
    [superAdmin, permissionSet]
  );

  // Filter nav items based on permissions
  const filteredNavItems = useMemo<(typeof NAV_ITEMS)[number][]>(() => {
    if (isAgentSession) return AGENT_NAV_ITEMS;

    return filterAuthorizedNavItems(NAV_ITEMS, accessContext);
  }, [accessContext, isAgentSession, permissionSet, superAdmin]);

  const authorizedFallbackHref = useMemo(
    () => resolveAuthorizedFallback(NAV_ITEMS, accessContext, "/dashboard"),
    [accessContext]
  );

  // Guard: block direct URL access to modules without permission.
  useEffect(() => {
    if (isAgentSession) return;
    if (!superAdmin && authMeLoading && permissionSet.size === 0) return;

    const blockedRoute = resolveBlockedPathRedirect(
      NAV_ITEMS,
      normalizedPathname,
      accessContext,
      "/dashboard"
    );
    if (!blockedRoute.blocked) return;

    const fallback = blockedRoute.fallback ?? authorizedFallbackHref;
    if (superAdmin || permissionSet.size > 0) {
      addLog({
        level: "warn",
        source: "custom",
        message: "Sidebar unauthorized route blocked",
        details: {
          pathname,
          fallback,
          superAdmin,
          permissions: Array.from(permissionSet),
        },
      });
    }
    if (normalizedPathname !== fallback) {
      router.replace(withLocale(fallback));
    }
  }, [
    isAgentSession,
    normalizedPathname,
    pathname,
    superAdmin,
    authMeLoading,
    permissionSet,
    router,
    authorizedFallbackHref,
    accessContext,
    withLocale,
  ]);

  const canViewSolicitudes = superAdmin || permissionSet.has("VIEW_SOLICITUDES");

  const { data: solicitudesPendientesData } = useQuery({
    queryKey: ["sidebar-solicitudes-pendientes", tenantSlug],
    queryFn: () =>
      solicitudesApi
        .list(tenantSlug!, { estado: "open", page: 1, limit: 1 })
        .then((r) => r.data),
    enabled: hasAccessToken && !isAgentSession && !!tenantSlug && canViewSolicitudes,
    staleTime: 30_000,
  });

  const solicitudesPendientes = Number(solicitudesPendientesData?.total ?? 0);

  if (!isClient) {
    return (
      <aside className="zentra-surface w-64 flex flex-col h-screen sticky top-0" />
    );
  }

  return (
    <aside className="zentra-surface w-64 flex flex-col h-screen sticky top-0">
      {/* Logo */}
      <div className="h-16 flex items-center px-6 border-b border-[#E7EEF2]">
        <img
          src="/branding/zentra-bot-logo.svg"
          alt="Zentra Bot"
          className="h-8 w-auto"
        />
      </div>

      {/* Tenant selector — only visible to superAdmin */}
      {superAdmin && !isAgentSession && (
        <div className="px-3 py-2 border-b border-[#E7EEF2]" ref={dropdownRef}>
          <button
            onClick={() => setDropdownOpen((o) => !o)}
            className="w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg bg-[#FFFFFF] hover:bg-[#F4F7F9] text-sm text-[#0D2B3E] transition border border-[#D9E5EB]"
          >
            <span className="flex items-center gap-2 min-w-0">
              <Building2 size={14} className="text-[#00BFAE] shrink-0" />
              <span className="truncate">{tenantSlug || t("selectCompany")}</span>
            </span>
            <ChevronDown size={14} className={cn("text-[#5B6670] shrink-0 transition-transform", dropdownOpen && "rotate-180")} />
          </button>
          {dropdownOpen && (
            <div className="mt-1 bg-[#FFFFFF] border border-[#D9E5EB] rounded-lg shadow-md overflow-hidden z-50">
              {tenants.length === 0 && (
                <p className="px-3 py-2 text-xs text-[#5B6670]">{t("noCompanies")}</p>
              )}
              {tenants.map((t) => (
                <button
                  key={t.slug}
                  onClick={() => { setTenantSlug(t.slug); setDropdownOpen(false); }}
                  className={cn(
                    "w-full text-left px-3 py-2 text-sm hover:bg-[#EEF9F7] transition",
                    tenantSlug === t.slug ? "text-[#0D2B3E] font-semibold bg-[#EEF9F7]" : "text-[#5B6670]"
                  )}
                >
                  {normalizeTenantName((t as { nombre?: unknown }).nombre, t.slug)}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      <nav className="flex-1 min-h-0 px-3 py-4 overflow-y-auto space-y-0.5">
        {filteredNavItems.map((item) => {
          const active = normalizedPathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={withLocale(item.href)}
              className={cn(
                "flex items-center gap-3 px-3 py-2 rounded-xl text-sm font-medium transition-all",
                active
                  ? "bg-[#EEF9F7] text-[#0D2B3E]"
                  : "text-[#5B6670] hover:bg-[#F4F7F9] hover:text-[#0D2B3E]"
              )}
            >
              <item.icon
                className={cn(
                  "w-4.5 h-4.5",
                  active ? "text-[#00BFAE]" : "text-[#7A8792]"
                )}
                size={18}
              />
              {t(item.labelKey)}
              {item.href === "/solicitudes" && !isAgentSession && solicitudesPendientes > 0 && (
                <span className="ml-auto bg-red-100 text-red-600 text-xs font-semibold px-2 py-0.5 rounded-full">
                  {solicitudesPendientes > 99 ? "99+" : solicitudesPendientes}
                </span>
              )}
            </Link>
          );
        })}
      </nav>

      {/* Bottom */}
      <div className="px-3 py-4 border-t border-[#E7EEF2] space-y-1">
        <button
          type="button"
          onClick={handleLogout}
          className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm text-[#5B6670] hover:bg-red-50 hover:text-red-600 transition"
        >
          <LogOut size={18} className="text-[#7A8792]" />
          {t("header.logout")}
        </button>
      </div>
    </aside>
  );
}
