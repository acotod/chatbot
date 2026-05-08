"use client";

import { agentAuthApi } from "@/lib/agentApi";
import { useAgentAuthStore } from "@/store/agentAuth";
import axios from "axios";
import { MessageCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

type AgentLoginPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

type AgentLoginScreenProps = {
  reason: string | null;
  nextPath: string;
};

function resolveAgentNextPath(next: string | undefined): string {
  if (next === "/dashboard") return "/dashboard";
  if (next === "/agente/perfil") return "/agente/perfil";
  if (next === "/agente/dashboard") return "/agente/dashboard";
  return "/dashboard";
}

function getAuthErrorMessage(error: unknown): string {
  if (!axios.isAxiosError(error)) {
    return "No se pudo iniciar sesión. Intenta nuevamente.";
  }

  const status = error.response?.status;
  if (status === 400 || status === 401) {
    return "Tenant, email o contraseña incorrectos.";
  }
  if (status === 403) {
    return "Tu acceso de agente está inactivo. Contactá al administrador.";
  }
  if (status === 429) {
    return "Demasiados intentos seguidos. Esperá unos minutos antes de volver a intentar.";
  }

  return String(error.response?.data?.error || "No se pudo iniciar sesión. Intenta nuevamente.");
}

export default async function AgentLoginPage({ searchParams }: AgentLoginPageProps) {
  const resolvedSearchParams = searchParams ? await searchParams : undefined;
  const reasonValue = resolvedSearchParams?.reason;
  const reason = Array.isArray(reasonValue) ? reasonValue[0] : reasonValue;
  const nextValue = resolvedSearchParams?.next;
  const nextRaw = Array.isArray(nextValue) ? nextValue[0] : nextValue;
  const nextPath = resolveAgentNextPath(nextRaw);

  return <AgentLoginScreen reason={reason ?? null} nextPath={nextPath} />;
}

function AgentLoginScreen({ reason, nextPath }: AgentLoginScreenProps) {
  const router = useRouter();
  const { setToken } = useAgentAuthStore();
  const [tenantSlug, setTenantSlug] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [infoMessage, setInfoMessage] = useState("");
  const [deliveryChannels, setDeliveryChannels] = useState<string[]>([]);
  const [resetPreview, setResetPreview] = useState<{ resetUrl?: string; expiresAt?: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [forgotLoading, setForgotLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setInfoMessage("");
    setDeliveryChannels([]);
    setLoading(true);
    try {
      const res = await agentAuthApi.login(tenantSlug.trim().toLowerCase(), email.trim().toLowerCase(), password);
      setToken(res.data.accessToken);
      router.replace(nextPath);
    } catch (err) {
      setError(getAuthErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  async function handleForgotPassword() {
    setError("");
    setInfoMessage("");
    setDeliveryChannels([]);
    setResetPreview(null);

    if (!tenantSlug.trim() || !email.trim()) {
      setError("Ingresá tenant y email para solicitar el restablecimiento.");
      return;
    }

    setForgotLoading(true);
    try {
      const res = await agentAuthApi.forgotPassword(tenantSlug.trim().toLowerCase(), email.trim().toLowerCase());
      setInfoMessage(res.data.message);
      setDeliveryChannels(Array.isArray(res.data.deliveryChannels) ? res.data.deliveryChannels : []);
      if (res.data.resetUrl) {
        setResetPreview({ resetUrl: res.data.resetUrl, expiresAt: res.data.expiresAt });
      }
    } catch (err) {
      setError(getAuthErrorMessage(err));
    } finally {
      setForgotLoading(false);
    }
  }

  return (
    <div className="relative min-h-screen overflow-hidden bg-gradient-to-br from-slate-100 via-cyan-50 to-slate-100 flex items-center justify-center p-4">
      <div className="pointer-events-none absolute -top-24 -left-24 h-64 w-64 rounded-full bg-cyan-200/30 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-24 -right-24 h-64 w-64 rounded-full bg-slate-300/30 blur-3xl" />

      <div className="relative bg-white rounded-3xl shadow-xl border border-slate-200/80 w-full max-w-md p-8 sm:p-9">
        <div className="flex items-center gap-3 mb-9">
          <div className="w-11 h-11 rounded-2xl bg-cyan-600 flex items-center justify-center shadow-sm shadow-cyan-200">
            <MessageCircle className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight text-slate-900">Zentra Bot</h1>
            <p className="text-xs text-slate-500">Acceso de agente</p>
          </div>
        </div>

        <h2 className="text-3xl font-semibold tracking-tight text-slate-900 mb-2">
          Ingreso operativo
        </h2>
        <p className="text-slate-600 text-base mb-7">
          Entrá con tu tenant, email y contraseña para ver tu perfil único.
        </p>

        {reason === "expired" && (
          <div className="mb-4 px-4 py-3 bg-amber-50 border border-amber-200 rounded-xl text-amber-700 text-sm">
            Tu sesión de agente expiró. Iniciá sesión nuevamente.
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4.5">
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-slate-700">Tenant</label>
            <input
              type="text"
              value={tenantSlug}
              onChange={(e) => setTenantSlug(e.target.value)}
              placeholder="global-med"
              required
              className="px-4 py-3 rounded-xl border border-slate-200 bg-white text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500/30 focus:border-cyan-500 transition-all"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-slate-700">Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="agente@empresa.com"
              required
              className="px-4 py-3 rounded-xl border border-slate-200 bg-white text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500/30 focus:border-cyan-500 transition-all"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-slate-700">Contraseña</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              required
              className="px-4 py-3 rounded-xl border border-slate-200 bg-white text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500/30 focus:border-cyan-500 transition-all"
            />
          </div>

          {error && (
            <div className="px-4 py-3 bg-red-50 border border-red-200 rounded-xl text-red-600 text-sm">
              {error}
            </div>
          )}

          {infoMessage && (
            <div className="px-4 py-3 bg-cyan-50 border border-cyan-200 rounded-xl text-cyan-700 text-sm">
              <p>{infoMessage}</p>
              {deliveryChannels.length > 0 && (
                <p className="mt-2 text-xs text-cyan-700/80">
                  Enviado por: {deliveryChannels.join(", ")}
                </p>
              )}
              {resetPreview?.resetUrl && (
                <div className="mt-2 space-y-1">
                  <button
                    type="button"
                    onClick={() => router.push(resetPreview.resetUrl!)}
                    className="font-medium underline underline-offset-2"
                  >
                    Abrir enlace de restablecimiento
                  </button>
                  {resetPreview.expiresAt && (
                    <p className="text-xs text-cyan-700/80">
                      Expira: {new Date(resetPreview.expiresAt).toLocaleString("es-ES")}
                    </p>
                  )}
                </div>
              )}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full py-3.5 bg-cyan-600 hover:bg-cyan-700 text-white font-medium rounded-xl transition-all shadow-sm shadow-cyan-100 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? "Ingresando..." : "Entrar como agente"}
          </button>

          <button
            type="button"
            onClick={handleForgotPassword}
            disabled={forgotLoading}
            className="w-full text-sm font-medium text-cyan-700 hover:text-cyan-800 transition disabled:opacity-50"
          >
            {forgotLoading ? "Generando enlace..." : "Olvidé mi contraseña"}
          </button>
        </form>
      </div>
    </div>
  );
}