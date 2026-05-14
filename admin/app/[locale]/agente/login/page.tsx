"use client";

import { agentAuthApi, type AgentLoginResponse } from "@/lib/agentApi";
import { useAgentAuthStore } from "@/store/agentAuth";
import axios from "axios";
import { MessageCircle } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";

type AgentLoginPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

type AgentLoginScreenProps = {
  reason: string | null;
  nextPath: string;
};

type TenantOption = {
  tenantId: string;
  tenantSlug: string;
  tenantNombre: string;
  agenteId: number;
};

type AgentLoginDiscoveryResponse = {
  requiresTenantSelection: true;
  email: string;
  tenants: TenantOption[];
};

function isLoginDiscoveryResponse(
  payload: AgentLoginResponse | AgentLoginDiscoveryResponse
): payload is AgentLoginDiscoveryResponse {
  return "requiresTenantSelection" in payload;
}

function resolveAgentNextPath(next: string | undefined): string {
  if (next === "/dashboard") return "/agente/dashboard";
  if (next === "/agente") return "/agente/dashboard";
  if (next === "/agente/perfil") return "/agente/perfil";
  if (next === "/agente/dashboard") return "/agente/dashboard";
  if (next === "/agente/security") return "/agente/security";
  return "/agente/dashboard";
}

function getAuthErrorKey(error: unknown): string {
  if (!axios.isAxiosError(error)) return "errors.generic";
  const status = error.response?.status;
  if (status === 400 || status === 401) return "errors.invalidCredentials";
  if (status === 403) return "errors.inactive";
  if (status === 429) return "errors.tooManyAttempts";
  return "errors.generic";
}

function clearAdminAuthPreserveTabSession() {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.removeItem("admin_token");
    sessionStorage.removeItem("admin_refresh_token");
    sessionStorage.removeItem("auth-storage");
  } catch {
    // Best effort cleanup only.
  }
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
  const t = useTranslations("agentLogin");
  const router = useRouter();
  const { setToken } = useAgentAuthStore();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [infoMessage, setInfoMessage] = useState("");
  const [deliveryChannels, setDeliveryChannels] = useState<string[]>([]);
  const [resetPreview, setResetPreview] = useState<{ resetUrl?: string; expiresAt?: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [forgotLoading, setForgotLoading] = useState(false);
  const [tenantOptions, setTenantOptions] = useState<Array<{ tenantId: string; tenantSlug: string; tenantNombre: string; agenteId: number }> | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setInfoMessage("");
    setDeliveryChannels([]);
    setLoading(true);
    try {
      const res = await agentAuthApi.loginNoTenant(email.trim().toLowerCase(), password);
      const payload = res.data as AgentLoginResponse | AgentLoginDiscoveryResponse;

      if (isLoginDiscoveryResponse(payload)) {
        setTenantOptions(payload.tenants || []);
        return;
      }

      // Clear admin tokens without resetting tabId to keep agent JWT tab context valid.
      clearAdminAuthPreserveTabSession();
      setToken(payload.accessToken);
      router.replace(nextPath);
    } catch (err) {
      setError(t(getAuthErrorKey(err)));
    } finally {
      setLoading(false);
    }
  }

  async function handleTenantSelection(tenantSlug: string) {
    setError("");
    setLoading(true);
    try {
      const res = await agentAuthApi.loginWithTenant(tenantSlug, email.trim().toLowerCase(), password);
      // Clear admin tokens without resetting tabId to keep agent JWT tab context valid.
      clearAdminAuthPreserveTabSession();
      setToken(res.data.accessToken);
      router.replace(nextPath);
    } catch (err) {
      setError(t(getAuthErrorKey(err)));
    } finally {
      setLoading(false);
    }
  }

  async function handleForgotPassword() {
    setError("");
    setInfoMessage("");
    setDeliveryChannels([]);
    setResetPreview(null);

    if (!email.trim()) {
      setError(t("forgotPasswordNoEmail"));
      return;
    }

    setForgotLoading(true);
    try {
      setInfoMessage(t("forgotPasswordInfo"));
    } catch (err) {
      setError(t(getAuthErrorKey(err)));
    } finally {
      setForgotLoading(false);
    }
  }

  // Show tenant selector
  if (tenantOptions) {
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
              <h1 className="text-xl font-bold tracking-tight text-slate-900">{t("title")}</h1>
              <p className="text-xs text-slate-500">{t("subtitle")}</p>
            </div>
          </div>

          <h2 className="text-3xl font-semibold tracking-tight text-slate-900 mb-2">
            {t("tenantSelectHeading")}
          </h2>
          <p className="text-slate-600 text-base mb-7">
            {t("tenantSelectDescription")}
          </p>

          {error && (
            <div className="mb-4 px-4 py-3 bg-red-50 border border-red-200 rounded-xl text-red-600 text-sm">
              {error}
            </div>
          )}

          {tenantOptions.length === 0 && (
            <div className="mb-4 px-4 py-3 bg-amber-50 border border-amber-200 rounded-xl text-amber-700 text-sm">
              {t("noTenantsError")}
            </div>
          )}

          <div className="space-y-3">
            {tenantOptions.map((tenant) => (
              <button
                key={tenant.tenantSlug}
                onClick={() => handleTenantSelection(tenant.tenantSlug)}
                disabled={loading}
                className="w-full px-4 py-4 bg-gradient-to-r from-cyan-50 to-slate-50 hover:from-cyan-100 hover:to-slate-100 border border-cyan-200 rounded-xl transition-all text-left disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <div className="font-semibold text-slate-900">{tenant.tenantNombre}</div>
                <div className="text-xs text-slate-500 mt-1">{tenant.tenantSlug}</div>
              </button>
            ))}
          </div>

          <button
            onClick={() => {
              setTenantOptions(null);
              setEmail("");
              setPassword("");
              setError("");
            }}
            className="w-full mt-6 py-2 text-sm text-cyan-700 hover:text-cyan-800 transition font-medium"
          >
            {t("backToLogin")}
          </button>
        </div>
      </div>
    );
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
            <h1 className="text-xl font-bold tracking-tight text-slate-900">{t("title")}</h1>
            <p className="text-xs text-slate-500">{t("subtitle")}</p>
          </div>
        </div>

        <h2 className="text-3xl font-semibold tracking-tight text-slate-900 mb-2">
          {t("heading")}
        </h2>
        <p className="text-slate-600 text-base mb-7">
          {t("description")}
        </p>

        {reason === "expired" && (
          <div className="mb-4 px-4 py-3 bg-amber-50 border border-amber-200 rounded-xl text-amber-700 text-sm">
            {t("sessionExpired")}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4.5">
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-slate-700">{t("emailLabel")}</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={t("emailPlaceholder")}
              required
              className="px-4 py-3 rounded-xl border border-slate-200 bg-white text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500/30 focus:border-cyan-500 transition-all"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-slate-700">{t("passwordLabel")}</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={t("passwordPlaceholder")}
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
                  {t("sentBy")} {deliveryChannels.join(", ")}
                </p>
              )}
              {resetPreview?.resetUrl && (
                <div className="mt-2 space-y-1">
                  <button
                    type="button"
                    onClick={() => router.push(resetPreview.resetUrl!)}
                    className="font-medium underline underline-offset-2"
                  >
                    {t("resetLinkButton")}
                  </button>
                  {resetPreview.expiresAt && (
                    <p className="text-xs text-cyan-700/80">
                      {t("resetExpires")} {new Date(resetPreview.expiresAt).toLocaleString()}
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
            {loading ? t("submitting") : t("submit")}
          </button>

          <button
            type="button"
            onClick={handleForgotPassword}
            disabled={forgotLoading}
            className="w-full text-sm font-medium text-cyan-700 hover:text-cyan-800 transition disabled:opacity-50"
          >
            {forgotLoading ? t("forgotPasswordLoading") : t("forgotPassword")}
          </button>
        </form>
      </div>
    </div>
  );
}