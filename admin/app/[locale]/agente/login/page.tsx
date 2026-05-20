"use client";

import { agentAuthApi, type AgentLoginResponse } from "@/lib/agentApi";
import { useAgentAuthStore } from "@/store/agentAuth";
import axios from "axios";
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
      <div className="relative min-h-screen overflow-hidden bg-gradient-to-br from-[#0A0F14] via-[#0D2B3E] to-[#0A0F14] flex items-center justify-center p-4">
        <div className="pointer-events-none absolute -top-24 -left-24 h-64 w-64 rounded-full bg-[#00BFAE]/20 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-24 -right-24 h-64 w-64 rounded-full bg-[#39E6D2]/14 blur-3xl" />

        <div className="relative zentra-surface rounded-3xl w-full max-w-md p-8 sm:p-9">
          <div className="flex items-center gap-3 mb-9">
            <img
              src="/branding/zentra-bot-logo.svg"
              alt="Zentra Bot"
              className="h-10 w-auto"
            />
            <div>
              <h1 className="text-xl font-bold tracking-tight text-[#EAFBFF]">{t("title")}</h1>
              <p className="text-xs text-[#97B6C3]">{t("subtitle")}</p>
            </div>
          </div>

          <h2 className="text-3xl font-semibold tracking-tight text-[#EAFBFF] mb-2">
            {t("tenantSelectHeading")}
          </h2>
          <p className="text-[#B6D0D9] text-base mb-7">
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
                className="w-full px-4 py-4 bg-[#0D2B3E]/70 hover:bg-[#0D2B3E]/90 border border-[#39E6D2]/22 rounded-xl transition-all text-left disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <div className="font-semibold text-[#EAFBFF]">{tenant.tenantNombre}</div>
                <div className="text-xs text-[#97B6C3] mt-1">{tenant.tenantSlug}</div>
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
            className="w-full mt-6 py-2 text-sm text-[#39E6D2] hover:text-[#6FF5E8] transition font-medium"
          >
            {t("backToLogin")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="relative min-h-screen overflow-hidden bg-gradient-to-br from-[#0A0F14] via-[#0D2B3E] to-[#0A0F14] flex items-center justify-center p-4">
      <div className="pointer-events-none absolute -top-24 -left-24 h-64 w-64 rounded-full bg-[#00BFAE]/20 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-24 -right-24 h-64 w-64 rounded-full bg-[#39E6D2]/14 blur-3xl" />

      <div className="relative zentra-surface rounded-3xl w-full max-w-md p-8 sm:p-9">
        <div className="flex items-center gap-3 mb-9">
          <img
            src="/branding/zentra-bot-logo.svg"
            alt="Zentra Bot"
            className="h-10 w-auto"
          />
          <div>
            <h1 className="text-xl font-bold tracking-tight text-[#EAFBFF]">{t("title")}</h1>
            <p className="text-xs text-[#97B6C3]">{t("subtitle")}</p>
          </div>
        </div>

        <h2 className="text-3xl font-semibold tracking-tight text-[#EAFBFF] mb-2">
          {t("heading")}
        </h2>
        <p className="text-[#B6D0D9] text-base mb-7">
          {t("description")}
        </p>

        {reason === "expired" && (
          <div className="mb-4 px-4 py-3 bg-amber-50 border border-amber-200 rounded-xl text-amber-700 text-sm">
            {t("sessionExpired")}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4.5">
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-[#CBE7EF]">{t("emailLabel")}</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={t("emailPlaceholder")}
              required
              className="px-4 py-3 rounded-xl border border-[#39E6D2]/20 bg-[#0D2B3E]/72 text-[#EAFBFF] placeholder:text-[#97B6C3] text-sm focus:outline-none focus:ring-2 focus:ring-[#00BFAE]/30 focus:border-[#39E6D2] transition-all"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-[#CBE7EF]">{t("passwordLabel")}</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={t("passwordPlaceholder")}
              required
              className="px-4 py-3 rounded-xl border border-[#39E6D2]/20 bg-[#0D2B3E]/72 text-[#EAFBFF] placeholder:text-[#97B6C3] text-sm focus:outline-none focus:ring-2 focus:ring-[#00BFAE]/30 focus:border-[#39E6D2] transition-all"
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
            className="w-full py-3.5 bg-gradient-to-r from-[#00BFAE] to-[#39E6D2] hover:brightness-105 text-[#063743] font-medium rounded-xl transition-all disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? t("submitting") : t("submit")}
          </button>

          <button
            type="button"
            onClick={handleForgotPassword}
            disabled={forgotLoading}
            className="w-full text-sm font-medium text-[#39E6D2] hover:text-[#6FF5E8] transition disabled:opacity-50"
          >
            {forgotLoading ? t("forgotPasswordLoading") : t("forgotPassword")}
          </button>
        </form>
      </div>
    </div>
  );
}