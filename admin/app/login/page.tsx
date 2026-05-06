"use client";

import { authApi } from "@/lib/api";
import { addLog, initGlobalErrorLogger } from "@/lib/errorLogger";
import { getFacebookAccessToken } from "@/lib/facebookAuth";
import { getGoogleCredential } from "@/lib/googleAuth";
import { scheduleProactiveRefresh, useAuthStore } from "@/store/auth";
import { DebugPanel } from "@/components/DebugPanel";
import axios from "axios";
import { MessageCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

type AuthResponse = {
  accessToken: string;
  refreshToken?: string;
  expiresIn: number;
  superAdmin: boolean;
};

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [facebookLoading, setFacebookLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);

  const { setToken, setPermissions, setRefreshToken } = useAuthStore();
  const router = useRouter();
  const facebookAppId = process.env.NEXT_PUBLIC_FACEBOOK_APP_ID ?? "";
  const googleClientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ?? "";

  // Initialize error logger on mount
  useEffect(() => {
    initGlobalErrorLogger();
    addLog({
      level: "info",
      source: "custom",
      message: "Login page mounted",
      details: { hasGoogle: !!googleClientId, hasFacebook: !!facebookAppId },
    });
  }, [googleClientId, facebookAppId]);

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
    setToken(response.accessToken, response.expiresIn);
    setRefreshToken(response.refreshToken ?? null);
    setPermissions(Boolean(response.superAdmin), []);
    // Schedule proactive token refresh 2 min before expiry
    scheduleProactiveRefresh(response.expiresIn ?? 900, async () => {
      const rt = localStorage.getItem("admin_refresh_token");
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
    router.push("/dashboard");
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

  async function handleFacebookLogin() {
    setError("");
    setFacebookLoading(true);
    try {
      addLog({
        level: "info",
        source: "custom",
        message: "Facebook login attempt",
      });
      const fbToken = await getFacebookAccessToken(facebookAppId);
      const res = await authApi.loginWithFacebook(fbToken);
      await applyAuthSession(res.data);
    } catch (error) {
      const errorMsg =
        !axios.isAxiosError(error) && error instanceof Error
          ? error.message
          : getAuthErrorMessage(error);
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

  async function handleGoogleLogin() {
    setError("");
    setGoogleLoading(true);
    try {
      addLog({
        level: "info",
        source: "custom",
        message: "Google login attempt",
      });
      const credential = await getGoogleCredential(googleClientId);
      const res = await authApi.loginWithGoogle(credential);
      await applyAuthSession(res.data);
    } catch (error) {
      const errorMsg =
        !axios.isAxiosError(error) && error instanceof Error
          ? error.message
          : getAuthErrorMessage(error);
      setError(errorMsg);
      addLog({
        level: "error",
        source: "custom",
        message: "Google login failed",
        details: {
          error: error instanceof Error ? error.message : String(error),
        },
      });
    } finally {
      setGoogleLoading(false);
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

          <div className="relative flex items-center gap-3 my-1">
            <div className="flex-1 h-px bg-slate-200" />
            <span className="text-xs text-slate-400">o continúa con</span>
            <div className="flex-1 h-px bg-slate-200" />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <button
              type="button"
              onClick={handleGoogleLogin}
              disabled={googleLoading || loading || !googleClientId}
              className="flex items-center justify-center gap-2 py-3 border border-slate-300 hover:border-slate-400 hover:bg-slate-50 text-slate-700 text-sm font-medium rounded-xl transition-all bg-white disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {googleLoading ? (
                <span className="text-xs">Conectando...</span>
              ) : (
                <>
                  <svg className="w-4 h-4 flex-shrink-0" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                    <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
                    <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                    <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/>
                    <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
                  </svg>
                  <span>Google</span>
                </>
              )}
            </button>

            <button
              type="button"
              onClick={handleFacebookLogin}
              disabled={facebookLoading || loading || !facebookAppId}
              className="flex items-center justify-center gap-2 py-3 border border-slate-300 hover:border-slate-400 hover:bg-slate-50 text-slate-700 text-sm font-medium rounded-xl transition-all bg-white disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {facebookLoading ? (
                <span className="text-xs">Conectando...</span>
              ) : (
                <>
                  <svg className="w-4 h-4 flex-shrink-0" viewBox="0 0 24 24" fill="#1877F2" xmlns="http://www.w3.org/2000/svg">
                    <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/>
                  </svg>
                  <span>Facebook</span>
                </>
              )}
            </button>
          </div>

          {(!googleClientId || !facebookAppId) && (
            <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">
              {!googleClientId && !facebookAppId
                ? "Configura NEXT_PUBLIC_GOOGLE_CLIENT_ID y NEXT_PUBLIC_FACEBOOK_APP_ID para habilitar login social."
                : !googleClientId
                ? "Configura NEXT_PUBLIC_GOOGLE_CLIENT_ID para habilitar login con Google."
                : "Configura NEXT_PUBLIC_FACEBOOK_APP_ID para habilitar login con Facebook."}
            </p>
          )}
        </form>

        <p className="mt-7 text-center text-xs text-slate-500">
          Zentra Bot · Panel administrativo de conversaciones inteligentes
        </p>
      </div>

      <DebugPanel />
    </div>
  );
}
