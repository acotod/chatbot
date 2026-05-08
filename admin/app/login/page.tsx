"use client";

import { authApi } from "@/lib/api";
import { addLog, initGlobalErrorLogger } from "@/lib/errorLogger";
import { buildPermissionSet, normalizePermissions, type Permission } from "@/lib/permissions";
import { scheduleProactiveRefresh, useAuthStore } from "@/store/auth";
import { DebugPanel } from "@/components/DebugPanel";
import axios from "axios";
import { useQueryClient } from "@tanstack/react-query";
import { MessageCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { getStoredRefreshToken } from "@/store/auth";

type AuthResponse = {
  accessToken: string;
  refreshToken?: string;
  expiresIn: number;
  superAdmin: boolean;
};

const LOGIN_REDIRECT_ORDER: Array<{ href: string; permission: Permission }> = [
  { href: "/dashboard", permission: "VIEW_DASHBOARD" },
  { href: "/conversaciones", permission: "VIEW_CONVERSACIONES" },
  { href: "/solicitudes", permission: "VIEW_SOLICITUDES" },
  { href: "/reportes", permission: "VIEW_METRICS" },
  { href: "/agenda", permission: "VIEW_AGENDA" },
  { href: "/agentes", permission: "VIEW_AGENTES" },
  { href: "/contactos", permission: "VIEW_CRM" },
  { href: "/configuracion", permission: "MANAGE_TENANTS" },
  { href: "/auditoria", permission: "VIEW_AUDITORIA" },
  { href: "/roles", permission: "MANAGE_ROLES" },
  { href: "/tenants", permission: "MANAGE_TENANTS" },
  { href: "/integraciones", permission: "MANAGE_TENANTS" },
  { href: "/variables", permission: "EDIT_FLUJOS" },
  { href: "/waba-flujos", permission: "VIEW_FLUJOS" },
  { href: "/webhooks", permission: "EDIT_SOLICITUDES" },
  { href: "/sandbox", permission: "VIEW_SANDBOX" },
];

function resolvePostLoginRoute(superAdmin: boolean, permissions: Permission[]): string {
  if (superAdmin) return "/dashboard";
  const permissionSet = buildPermissionSet(permissions);
  return LOGIN_REDIRECT_ORDER.find((item) => permissionSet.has(item.permission))?.href ?? "/login";
}

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const { setToken, setPermissions, setRefreshToken, setTenantSlug } = useAuthStore();
  const router = useRouter();
  const queryClient = useQueryClient();

  // Initialize error logger on mount
  useEffect(() => {
    initGlobalErrorLogger();
    addLog({
      level: "info",
      source: "custom",
      message: "Login page mounted",
      details: { socialLoginEnabled: false },
    });
  }, []);

  function getAuthErrorMessage(error: unknown): string {
    if (!axios.isAxiosError(error)) {
      return "No se pudo iniciar sesion. Intenta nuevamente.";
    }

    const status = error.response?.status;
    if (status === 400 || status === 401) {
      return "Credenciales incorrectas. Verificá tu email y contraseña.";
    }
    if (status === 403) {
      return "Tu cuenta no tiene acceso al panel. Contactá al administrador.";
    }
    if (status === 423) {
      return "Cuenta temporalmente bloqueada por múltiples intentos fallidos. Intenta en unos minutos.";
    }
    if (status === 429) {
      return "Demasiados intentos seguidos. Esperá unos minutos antes de volver a intentar.";
    }
    if (status === 503) {
      return "Servicio de autenticación no disponible temporalmente. Contactá al soporte.";
    }

    return String(error.response?.data?.error || "No se pudo iniciar sesión. Intenta nuevamente.");
  }

  async function applyAuthSession(response: AuthResponse) {
    // Prevent stale cached data from a previous account leaking into the new session.
    queryClient.clear();

    setToken(response.accessToken, response.expiresIn);
    setRefreshToken(response.refreshToken ?? null);
    setPermissions(Boolean(response.superAdmin), []);

    let targetRoute = "/dashboard";
    try {
      const meResponse = await authApi.me();
      const normalizedPermissions = normalizePermissions(meResponse.data?.permissions);
      const isSuperAdmin = Boolean(meResponse.data?.superAdmin);

      setPermissions(isSuperAdmin, normalizedPermissions);

      const meTenantSlug = String(meResponse.data?.tenantSlug ?? "").trim();
      if (!isSuperAdmin && meTenantSlug) {
        setTenantSlug(meTenantSlug);
      }

      targetRoute = resolvePostLoginRoute(isSuperAdmin, normalizedPermissions);
    } catch {
      // Keep dashboard fallback if /auth/me fails after successful login.
      targetRoute = "/dashboard";
    }

    // Schedule proactive token refresh 2 min before expiry
    scheduleProactiveRefresh(response.expiresIn ?? 900, async () => {
      const rt = getStoredRefreshToken();
      if (!rt) return;
      const { default: axios } = await import("axios");
      const apiBase = process.env.NEXT_PUBLIC_API_URL?.trim() ||
        (typeof window !== "undefined" && window.location.hostname !== "localhost"
          ? `${window.location.protocol}//${window.location.hostname}`
          : "http://127.0.0.1:3200");
      const r = await axios.post(`${apiBase}/auth/refresh`, { refreshToken: rt });
      setToken(r.data.accessToken, r.data.expiresIn);
      scheduleProactiveRefresh(r.data.expiresIn ?? 900, async () => {});
    });
    router.push(targetRoute);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const normalizedEmail = email.trim().toLowerCase();
      addLog({
        level: "info",
        source: "custom",
        message: "Login attempt",
        details: { email: normalizedEmail },
      });
      const res = await authApi.login(normalizedEmail, password);
      await applyAuthSession(res.data);
    } catch (error) {
      const errorMsg = getAuthErrorMessage(error);
      setError(errorMsg);
      addLog({
        level: "error",
        source: "custom",
        message: "Login failed",
        details: {
          error: error instanceof Error ? error.message : String(error),
        },
      });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="relative min-h-screen overflow-hidden bg-gradient-to-br from-slate-100 via-blue-50 to-slate-100 flex items-center justify-center p-4">
      <div className="pointer-events-none absolute -top-24 -left-24 h-64 w-64 rounded-full bg-blue-200/30 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-24 -right-24 h-64 w-64 rounded-full bg-slate-300/30 blur-3xl" />

      <div className="relative bg-white rounded-3xl shadow-xl border border-slate-200/80 w-full max-w-md p-8 sm:p-9">
        {/* Logo */}
        <div className="flex items-center gap-3 mb-9">
          <div className="w-11 h-11 rounded-2xl bg-blue-600 flex items-center justify-center shadow-sm shadow-blue-200">
            <MessageCircle className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight text-slate-900">Zentra Bot</h1>
            <p className="text-xs text-slate-500">Panel administrativo</p>
          </div>
        </div>

        <h2 className="text-3xl font-semibold tracking-tight text-slate-900 mb-2">
          Bienvenido de vuelta
        </h2>
        <p className="text-slate-600 text-base mb-7">
          Ingresá tus credenciales para continuar
        </p>

        <form onSubmit={handleSubmit} className="space-y-4.5">
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-slate-700">Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="admin@clinica.com"
              required
              className="px-4 py-3 rounded-xl border border-slate-200 bg-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500 transition-all"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-slate-700">
              Contraseña
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              required
              className="px-4 py-3 rounded-xl border border-slate-200 bg-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500 transition-all"
            />
          </div>

          {error && (
            <div className="px-4 py-3 bg-red-50 border border-red-200 rounded-xl text-red-600 text-sm">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full py-3.5 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-xl transition-all shadow-sm shadow-blue-100 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? "Iniciando sesión..." : "Iniciar sesión"}
          </button>
        </form>

        <p className="mt-7 text-center text-xs text-slate-500">
          Zentra Bot · Panel administrativo de conversaciones inteligentes
        </p>
      </div>

      <DebugPanel />
    </div>
  );
}
