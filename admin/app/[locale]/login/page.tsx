"use client";

import { API_BASE, authApi } from "@/lib/api";
import { checkFacebookLoginStatus, getFacebookAccessToken } from "@/lib/facebookAuth";
import { addLog, initGlobalErrorLogger } from "@/lib/errorLogger";
import { buildPermissionSet, normalizePermissions, type Permission } from "@/lib/permissions";
import { scheduleProactiveRefresh, useAuthStore } from "@/store/auth";
import { DebugPanel } from "@/components/DebugPanel";
import axios from "axios";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { getStoredRefreshToken } from "@/store/auth";
import { useCurrentLocale } from "@/lib/i18n/client";

type AuthResponse = {
  accessToken: string;
  refreshToken?: string;
  expiresIn: number;
  superAdmin: boolean;
};

type FacebookStatusResponse = {
  status: "connected" | "not_authorized" | "unknown";
  authResponse?: {
    accessToken?: string;
  };
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
  { href: "/usuarios-admin", permission: "MANAGE_USERS" },
  { href: "/tenants", permission: "MANAGE_TENANTS" },
  { href: "/integraciones", permission: "MANAGE_TENANTS" },
  { href: "/variables", permission: "EDIT_FLUJOS" },
  { href: "/waba-flujos", permission: "VIEW_FLUJOS" },
  { href: "/webhooks", permission: "MANAGE_WEBHOOKS" },
  { href: "/sandbox", permission: "VIEW_SANDBOX" },
];

function resolvePostLoginRoute(superAdmin: boolean, permissions: Permission[]): string {
  if (superAdmin) return "/dashboard";
  const permissionSet = buildPermissionSet(permissions);
  return LOGIN_REDIRECT_ORDER.find((item) => permissionSet.has(item.permission))?.href ?? "/login";
}

export default function LoginPage() {
  const locale = useCurrentLocale();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [facebookLoading, setFacebookLoading] = useState(false);

  const { setToken, setPermissions, setRefreshToken, setTenantSlug } = useAuthStore();
  const router = useRouter();
  const queryClient = useQueryClient();

  const withLocale = (path: string): string => {
    if (locale === "es") return path;
    if (path === "/") return `/${locale}`;
    return `/${locale}${path}`;
  };

  const facebookAppId = String(process.env.NEXT_PUBLIC_FACEBOOK_APP_ID || "").trim();

  const copy = locale === "en"
    ? {
        genericError: "Could not sign in. Please try again.",
        invalidCredentials: "Incorrect credentials. Verify your email and password.",
        noAccess: "Your account has no access to this panel. Contact an administrator.",
        locked: "Account temporarily locked due to multiple failed attempts. Try again in a few minutes.",
        tooManyAttempts: "Too many attempts. Wait a few minutes and try again.",
        unavailable: "Authentication service is temporarily unavailable. Contact support.",
        logoSubtitle: "Admin panel",
        title: "Welcome back",
        subtitle: "Enter your credentials to continue",
        emailLabel: "Email",
        emailPlaceholder: "admin@clinic.com",
        passwordLabel: "Password",
        loggingIn: "Signing in...",
        signIn: "Sign in",
        or: "or",
        continueWithFacebook: "Continue with Facebook",
        facebookInProgress: "Connecting with Facebook...",
        footer: "Zentra Bot · Admin panel for intelligent conversations",
      }
    : {
        genericError: "No se pudo iniciar sesión. Intenta nuevamente.",
        invalidCredentials: "Credenciales incorrectas. Verificá tu email y contraseña.",
        noAccess: "Tu cuenta no tiene acceso al panel. Contactá al administrador.",
        locked: "Cuenta temporalmente bloqueada por múltiples intentos fallidos. Intenta en unos minutos.",
        tooManyAttempts: "Demasiados intentos seguidos. Esperá unos minutos antes de volver a intentar.",
        unavailable: "Servicio de autenticación no disponible temporalmente. Contactá al soporte.",
        logoSubtitle: "Panel administrativo",
        title: "Bienvenido de vuelta",
        subtitle: "Ingresá tus credenciales para continuar",
        emailLabel: "Correo electrónico",
        emailPlaceholder: "admin@clinica.com",
        passwordLabel: "Contraseña",
        loggingIn: "Iniciando sesión...",
        signIn: "Iniciar sesión",
        or: "o",
        continueWithFacebook: "Continuar con Facebook",
        facebookInProgress: "Conectando con Facebook...",
        footer: "Zentra Bot · Panel administrativo de conversaciones inteligentes",
      };

  // Initialize error logger on mount
  useEffect(() => {
    initGlobalErrorLogger();
    addLog({
      level: "info",
      source: "custom",
      message: "Login page mounted",
      details: { socialLoginEnabled: true },
    });
  }, []);

  function extractFacebookToken(response: FacebookStatusResponse): string | null {
    const token = response.authResponse?.accessToken;
    if (response.status === "connected" && token) return token;
    return null;
  }

  function getAuthErrorMessage(error: unknown): string {
    if (!axios.isAxiosError(error)) {
      return copy.genericError;
    }

    const status = error.response?.status;
    if (status === 400 || status === 401) {
      return copy.invalidCredentials;
    }
    if (status === 403) {
      return copy.noAccess;
    }
    if (status === 423) {
      return copy.locked;
    }
    if (status === 429) {
      return copy.tooManyAttempts;
    }
    if (status === 503) {
      return copy.unavailable;
    }

    return String(error.response?.data?.error || copy.genericError);
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
      const r = await axios.post(`${API_BASE}/auth/refresh`, { refreshToken: rt });
      setToken(r.data.accessToken, r.data.expiresIn);
      scheduleProactiveRefresh(r.data.expiresIn ?? 900, async () => {});
    });
    router.push(withLocale(targetRoute));
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

  async function statusChangeCallback(response: FacebookStatusResponse) {
    const knownToken = extractFacebookToken(response);
    const accessToken = knownToken || (await getFacebookAccessToken(facebookAppId));
    const res = await authApi.loginWithFacebook(accessToken);
    await applyAuthSession(res.data);
  }

  async function checkLoginState() {
    if (!facebookAppId) {
      setError(copy.unavailable);
      return;
    }

    setError("");
    setFacebookLoading(true);
    try {
      const response = await checkFacebookLoginStatus(facebookAppId);
      await statusChangeCallback(response);
    } catch (error) {
      const errorMsg = getAuthErrorMessage(error);
      setError(errorMsg);
      addLog({
        level: "error",
        source: "custom",
        message: "Facebook login failed",
        details: {
          error: error instanceof Error ? error.message : String(error),
        },
      });
    } finally {
      setFacebookLoading(false);
    }
  }

  return (
    <div className="relative min-h-screen overflow-hidden bg-gradient-to-br from-slate-100 via-blue-50 to-slate-100 flex items-center justify-center p-4">
      <div className="pointer-events-none absolute -top-24 -left-24 h-64 w-64 rounded-full bg-blue-200/30 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-24 -right-24 h-64 w-64 rounded-full bg-slate-300/30 blur-3xl" />

      <div className="relative bg-white rounded-3xl shadow-xl border border-slate-200/80 w-full max-w-md p-8 sm:p-9">
        {/* Logo */}
        <div className="flex items-center gap-3 mb-9">
          <img
            src="/branding/zentra-bot-logo.svg"
            alt="Zentra Bot"
            className="h-10 w-auto"
          />
          <div>
            <p className="text-xs text-slate-500">{copy.logoSubtitle}</p>
          </div>
        </div>

        <h2 className="text-3xl font-semibold tracking-tight text-slate-900 mb-2">
          {copy.title}
        </h2>
        <p className="text-slate-600 text-base mb-7">
          {copy.subtitle}
        </p>

        <form onSubmit={handleSubmit} className="space-y-4.5">
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-slate-700">{copy.emailLabel}</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={copy.emailPlaceholder}
              required
              className="px-4 py-3 rounded-xl border border-slate-200 bg-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500 transition-all"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-slate-700">
              {copy.passwordLabel}
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
            disabled={loading || facebookLoading}
            className="w-full py-3.5 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-xl transition-all shadow-sm shadow-blue-100 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? copy.loggingIn : copy.signIn}
          </button>

          <div className="relative py-1">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-slate-200" />
            </div>
            <div className="relative flex justify-center text-xs uppercase">
              <span className="bg-white px-2 text-slate-500">{copy.or}</span>
            </div>
          </div>

          <button
            type="button"
            onClick={checkLoginState}
            disabled={loading || facebookLoading}
            className="w-full py-3.5 bg-[#1877F2] hover:bg-[#166fe5] text-white font-medium rounded-xl transition-all shadow-sm shadow-blue-100 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {facebookLoading ? copy.facebookInProgress : copy.continueWithFacebook}
          </button>
        </form>

        <p className="mt-7 text-center text-xs text-slate-500">
          {copy.footer}
        </p>
      </div>

      <DebugPanel />
    </div>
  );
}
