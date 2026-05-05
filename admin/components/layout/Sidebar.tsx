"use client";

import { authApi, tenantApi } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/store/auth";
import {
  Bell,
  Building2,
  CalendarDays,
  ChevronDown,
  CreditCard,
  GitBranch,
  LayoutDashboard,
  LogOut,
  MessageCircle,
  Settings,
  Users,
  ClipboardList,
  ScrollText,
  ShieldCheck,
  Webhook,
  Plug,
  Variable,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

const NAV_ITEMS = [
  { icon: LayoutDashboard, label: "Dashboard", href: "/dashboard" },
  { icon: MessageCircle, label: "Conversaciones", href: "/conversaciones" },
  { icon: ClipboardList, label: "Solicitudes", href: "/solicitudes" },
  { icon: CalendarDays, label: "Agenda", href: "/agenda" },
  { icon: Users, label: "Agentes", href: "/agentes" },
  { icon: Settings, label: "Configuración", href: "/configuracion" },
  { icon: CreditCard, label: "Facturación", href: "/facturacion" },
  { icon: ScrollText, label: "Auditoría", href: "/auditoria" },
  { icon: ShieldCheck, label: "Roles", href: "/roles" },
  { icon: Building2, label: "Tenants", href: "/tenants" },
  { icon: Plug, label: "Integraciones", href: "/integraciones" },
  { icon: Variable, label: "Variables", href: "/variables" },
  { icon: GitBranch, label: "Flujos", href: "/flujos" },
  { icon: Webhook, label: "WABA Flujos", href: "/waba-flujos" },
];

export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const { logout, tenantSlug, superAdmin, permissions, setTenantSlug } = useAuthStore();

  const [tenants, setTenants] = useState<{ slug: string; nombre: string }[]>([]);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Fetch tenant list for superAdmins
  useEffect(() => {
    if (!superAdmin) return;
    tenantApi.list().then((res) => {
      const data = (res.data as { slug: string; nombre: string }[]) ?? [];
      setTenants(data);
    }).catch(() => {});
  }, [superAdmin]);

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
    try {
      const refreshToken =
        typeof window !== "undefined"
          ? localStorage.getItem("admin_refresh_token") ?? undefined
          : undefined;
      await authApi.logout(refreshToken);
    } catch {
      // Best effort: even if API logout fails, clear client auth state.
    } finally {
      logout();
      router.push("/login");
    }
  }

  // Filter nav items based on permissions
  const filteredNavItems = NAV_ITEMS.filter((item) => {
    return true;
  });

  return (
    <aside className="w-64 bg-white border-r border-slate-200 flex flex-col h-screen sticky top-0">
      {/* Logo */}
      <div className="h-16 flex items-center px-6 border-b border-slate-200">
        <div className="w-8 h-8 rounded-lg bg-blue-600 flex items-center justify-center mr-3">
          <MessageCircle className="w-4 h-4 text-white" />
        </div>
        <span className="text-slate-900 font-semibold text-lg">Zentra Bot</span>
      </div>

      {/* Tenant selector — only visible to superAdmin */}
      {superAdmin && (
        <div className="px-3 py-2 border-b border-slate-100" ref={dropdownRef}>
          <button
            onClick={() => setDropdownOpen((o) => !o)}
            className="w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg bg-slate-50 hover:bg-slate-100 text-sm text-slate-700 transition"
          >
            <span className="flex items-center gap-2 min-w-0">
              <Building2 size={14} className="text-slate-400 shrink-0" />
              <span className="truncate">{tenantSlug || "Seleccionar empresa"}</span>
            </span>
            <ChevronDown size={14} className={cn("text-slate-400 shrink-0 transition-transform", dropdownOpen && "rotate-180")} />
          </button>
          {dropdownOpen && (
            <div className="mt-1 bg-white border border-slate-200 rounded-lg shadow-md overflow-hidden z-50">
              {tenants.length === 0 && (
                <p className="px-3 py-2 text-xs text-slate-400">Sin tenants</p>
              )}
              {tenants.map((t) => (
                <button
                  key={t.slug}
                  onClick={() => { setTenantSlug(t.slug); setDropdownOpen(false); }}
                  className={cn(
                    "w-full text-left px-3 py-2 text-sm hover:bg-blue-50 transition",
                    tenantSlug === t.slug ? "text-blue-700 font-semibold bg-blue-50" : "text-slate-700"
                  )}
                >
                  {t.nombre ?? t.slug}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      <nav className="flex-1 min-h-0 px-3 py-4 overflow-y-auto space-y-0.5">
        {filteredNavItems.map((item) => {
          const active = pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center gap-3 px-3 py-2 rounded-xl text-sm font-medium transition-all",
                active
                  ? "bg-blue-50 text-blue-700"
                  : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
              )}
            >
              <item.icon
                className={cn(
                  "w-4.5 h-4.5",
                  active ? "text-blue-600" : "text-slate-400"
                )}
                size={18}
              />
              {item.label}
              {item.label === "Solicitudes" && (
                <span className="ml-auto bg-red-100 text-red-600 text-xs font-semibold px-2 py-0.5 rounded-full">
                  3
                </span>
              )}
            </Link>
          );
        })}
      </nav>

      {/* Bottom */}
      <div className="px-3 py-4 border-t border-slate-100 space-y-1">
        <button className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm text-slate-500 hover:bg-slate-100 hover:text-slate-900 transition">
          <Bell size={18} className="text-slate-400" />
          Notificaciones
        </button>
        <button
          onClick={handleLogout}
          className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm text-slate-500 hover:bg-red-50 hover:text-red-600 transition"
        >
          <LogOut size={18} className="text-slate-400" />
          Cerrar sesión
        </button>
      </div>
    </aside>
  );
}
