"use client";

import { sandboxApi } from "@/lib/api";
import { buildPermissionSet } from "@/lib/permissions";
import { useAuthStore } from "@/store/auth";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import axios from "axios";
import { Clock3, Play, ShieldCheck, TestTube2, Webhook } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";

type CapabilitiesResponse = {
  ok: boolean;
  sandbox: {
    permission: string;
    runtime: Record<string, boolean>;
    tenantScope: string | null;
  };
};

type SimulationResponse = {
  ok: boolean;
  simulated: {
    tenantId: string;
    phone: string;
    text: string;
    msgId: string;
    correlationId: string;
    conversationId: string | null;
    conversationStatus: string | null;
    outboundMetaMock?: boolean;
  };
};

type SandboxRunListItem = {
  id: string;
  userKey: string;
  status: string;
  startedAt: string;
  endedAt: string | null;
  flow: { id: number; nombre: string } | null;
  flowVersionId: number | null;
  eventCount: number;
};

type SandboxRunDetail = {
  id: string;
  userKey: string;
  status: string;
  startedAt: string;
  endedAt: string | null;
  flow: { id: number; nombre: string } | null;
  flowVersion: { id: number; versionNumber: number; publishedAt: string | null } | null;
  events: Array<{
    id: string;
    nodeRef: string | null;
    eventType: string;
    payload: Record<string, unknown> | null;
    createdAt: string;
  }>;
};

type ReplayResponse = {
  ok: boolean;
  replay: {
    sourceRunId: string;
    replayedSteps: number;
    userKey: string;
    outboundMetaMock: boolean;
    conversationId: string | null;
    conversationStatus: string | null;
  };
};

type ComplianceResponse = {
  ok: boolean;
  compliance: {
    runId: string;
    verdict: "pass" | "warning" | "fail";
    score: string;
    summary: string;
    checks: Array<{
      key: string;
      label: string;
      passed: boolean;
    }>;
  };
};

function formatDateTime(value: string | null, locale: string): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(locale);
}

function getErrorMessage(error: unknown, fallback: string): string {
  if (axios.isAxiosError(error)) {
    const detail = error.response?.data?.detail;
    const message = error.response?.data?.error;
    if (typeof detail === "string" && detail) return detail;
    if (typeof message === "string" && message) return message;
  }
  return fallback;
}

export default function SandboxPage() {
  const tCommon = useTranslations("common");
  const tSandbox = useTranslations("sandbox");
  const locale = useLocale();
  const { tenantSlug, superAdmin, permissions } = useAuthStore();
  const queryClient = useQueryClient();
  const [phone, setPhone] = useState(tSandbox("defaults.phone"));
  const [text, setText] = useState(tSandbox("defaults.text"));
  const [contactName, setContactName] = useState(tSandbox("defaults.contactName"));
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [complianceReport, setComplianceReport] = useState<ComplianceResponse["compliance"] | null>(null);
  const trimmedPhone = phone.trim();
  const appliedChanges = tSandbox.raw("appliedChanges.items") as string[];
  const verdictLabels = {
    pass: tSandbox("timeline.verdicts.pass"),
    warning: tSandbox("timeline.verdicts.warning"),
    fail: tSandbox("timeline.verdicts.fail"),
  } as const;

  const permissionSet = useMemo(() => buildPermissionSet(permissions), [permissions]);
  const canAccessSandbox = superAdmin || permissionSet.has("VIEW_SANDBOX");
  const canManageSandboxSettings = superAdmin || permissionSet.has("MANAGE_TENANTS");

  const { data, isLoading, isError } = useQuery({
    queryKey: ["sandbox-capabilities", tenantSlug],
    queryFn: () =>
      sandboxApi.capabilities({
        tenantSlug: superAdmin ? tenantSlug || undefined : undefined,
      }).then((res) => res.data as CapabilitiesResponse),
    enabled: canAccessSandbox && (!superAdmin || Boolean(tenantSlug)),
    staleTime: 30_000,
  });

  const updateSettingsMutation = useMutation({
    mutationFn: (outboundMetaMock: boolean) =>
      sandboxApi.updateSettings({
        tenantSlug: superAdmin ? tenantSlug || undefined : undefined,
        outboundMetaMock,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["sandbox-capabilities"] });
    },
  });

  const simulateMutation = useMutation({
    mutationFn: () =>
      sandboxApi.simulateInbound({
        tenantSlug: superAdmin ? tenantSlug || undefined : undefined,
        phone,
        text,
        contactName,
        e2e: false,
      }).then((res) => res.data as SimulationResponse),
    onSuccess: (result) => {
      if (result.simulated.conversationId) {
        setSelectedRunId(result.simulated.conversationId);
      }
      void queryClient.invalidateQueries({ queryKey: ["sandbox-runs"] });
    },
  });

  const replayMutation = useMutation({
    mutationFn: () =>
      sandboxApi.replayRun(selectedRunId!, {
        tenantSlug: superAdmin ? tenantSlug || undefined : undefined,
      }).then((res) => res.data as ReplayResponse),
    onSuccess: (result) => {
      if (result.replay.conversationId) {
        setSelectedRunId(result.replay.conversationId);
      }
      void queryClient.invalidateQueries({ queryKey: ["sandbox-runs"] });
    },
  });

  const complianceMutation = useMutation({
    mutationFn: () =>
      sandboxApi.checkCompliance(selectedRunId!, {
        tenantSlug: superAdmin ? tenantSlug || undefined : undefined,
      }).then((res) => res.data as ComplianceResponse),
    onSuccess: (result) => {
      setComplianceReport(result.compliance);
    },
  });

  const { data: runsData, isLoading: runsLoading } = useQuery({
    queryKey: ["sandbox-runs", tenantSlug, trimmedPhone],
    queryFn: () =>
      sandboxApi.listRuns({
        tenantSlug: superAdmin ? tenantSlug || undefined : undefined,
        userKey: trimmedPhone,
        limit: 8,
      }).then((res) => res.data as { ok: boolean; data: SandboxRunListItem[] }),
    enabled: canAccessSandbox && (!superAdmin || Boolean(tenantSlug)) && Boolean(trimmedPhone),
    staleTime: 5_000,
    refetchInterval: 3_000,
  });

  const runs = runsData?.data ?? [];

  useEffect(() => {
    if (!runs.length) return;

    const stillExists = selectedRunId ? runs.some((run) => run.id === selectedRunId) : false;
    if (!selectedRunId || !stillExists) {
      setSelectedRunId(runs[0].id);
    }
  }, [runs, selectedRunId]);

  useEffect(() => {
    setComplianceReport(null);
  }, [selectedRunId]);

  const { data: runDetailData, isLoading: runDetailLoading } = useQuery({
    queryKey: ["sandbox-run-detail", tenantSlug, selectedRunId],
    queryFn: () =>
      sandboxApi.getRun(selectedRunId!, {
        tenantSlug: superAdmin ? tenantSlug || undefined : undefined,
      }).then((res) => res.data as { ok: boolean; data: SandboxRunDetail }),
    enabled: canAccessSandbox && !!selectedRunId && (!superAdmin || Boolean(tenantSlug)),
    staleTime: 5_000,
  });

  const selectedRun = runDetailData?.data ?? null;

  const canReplay = Boolean(
    selectedRun?.events?.some(
      (e) => {
        const type = String(e.eventType ?? '').toLowerCase();
        return type === 'user_input' || type === 'menu_selection';
      }
    )
  );

  const runtimeEntries = Object.entries(data?.sandbox.runtime ?? {});
  const outboundMetaMockEnabled = Boolean(data?.sandbox.runtime?.outboundMetaMock);

  if (!canAccessSandbox) {
    return (
      <div className="rounded-3xl border border-red-200 bg-red-50 px-6 py-5 text-sm text-red-700">
        {tSandbox("errors.forbidden")}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">{tCommon("nav.sandbox")}</h1>
          <p className="mt-2 max-w-3xl text-sm text-slate-500">
            {tSandbox("hero.description")}
          </p>
        </div>
        <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          {tSandbox("hero.status")}
        </div>
      </div>

      <section className="rounded-3xl border border-blue-200 bg-blue-50 p-6 shadow-sm">
        <div className="flex items-center gap-2 text-slate-900">
          <ShieldCheck className="h-5 w-5 text-blue-600" />
          <h2 className="text-lg font-semibold">{tSandbox("appliedChanges.title")}</h2>
        </div>
        <p className="mt-2 text-sm text-slate-600">
          {tSandbox("appliedChanges.description")}
        </p>
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          {appliedChanges.map((item) => (
            <div key={item} className="rounded-2xl border border-blue-200 bg-white px-4 py-3 text-sm text-slate-700">
              {item}
            </div>
          ))}
        </div>
      </section>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.35fr)_minmax(320px,0.95fr)]">
        <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="mb-5 flex items-center gap-2 text-slate-900">
            <Webhook className="h-5 w-5 text-blue-600" />
            <h2 className="text-lg font-semibold">{tSandbox("simulate.title")}</h2>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <label className="space-y-2 text-sm text-slate-600">
              <span>{tSandbox("simulate.phone")}</span>
              <input
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                className="w-full rounded-2xl border border-slate-200 px-3 py-2.5 text-sm text-slate-900 transition focus:border-blue-500 focus:outline-none"
                placeholder={tSandbox("defaults.phone")}
              />
            </label>
            <label className="space-y-2 text-sm text-slate-600">
              <span>{tSandbox("simulate.contact")}</span>
              <input
                value={contactName}
                onChange={(e) => setContactName(e.target.value)}
                className="w-full rounded-2xl border border-slate-200 px-3 py-2.5 text-sm text-slate-900 transition focus:border-blue-500 focus:outline-none"
                placeholder={tSandbox("simulate.contactPlaceholder")}
              />
            </label>
            <label className="space-y-2 text-sm text-slate-600 md:col-span-2">
              <span>{tSandbox("simulate.message")}</span>
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={6}
                className="w-full rounded-2xl border border-slate-200 px-3 py-2.5 text-sm text-slate-900 transition focus:border-blue-500 focus:outline-none"
                placeholder={tSandbox("simulate.messagePlaceholder")}
              />
            </label>
          </div>

          <div className="mt-4 flex flex-col gap-3 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600 md:flex-row md:items-center md:justify-between">
            <div>
              {superAdmin ? (
                <span>
                  {tSandbox("simulate.superAdminTenant")} <strong>{tenantSlug || tSandbox("simulate.noTenantSelected")}</strong>
                </span>
              ) : (
                <span>{tSandbox("simulate.sessionTenant")}</span>
              )}
            </div>
            <button
              type="button"
              onClick={() => simulateMutation.mutate()}
              disabled={simulateMutation.isPending || !canAccessSandbox || (superAdmin && !tenantSlug)}
              className="inline-flex items-center justify-center gap-2 rounded-2xl bg-blue-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-slate-300"
            >
              <Play className="h-4 w-4" />
              {simulateMutation.isPending ? tSandbox("simulate.submitting") : tSandbox("simulate.submit")}
            </button>
          </div>

          <div className="mt-4 rounded-2xl bg-slate-950 p-4 text-xs text-slate-100">
            <div className="mb-2 font-semibold text-slate-300">{tSandbox("simulate.payload")}</div>
            <pre className="overflow-auto whitespace-pre-wrap break-all">
              {JSON.stringify(
                {
                  tenantSlug: superAdmin ? tenantSlug || null : null,
                  phone,
                  contactName,
                  text,
                },
                null,
                2
              )}
            </pre>
          </div>

          {simulateMutation.isError && (
            <div className="mt-4 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {getErrorMessage(simulateMutation.error, tSandbox("errors.simulateFailed"))}
            </div>
          )}

          {simulateMutation.data && (
            <div className="mt-4 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
              <p className="font-medium">{tSandbox("simulate.runtimeLaunched")}</p>
              <p className="mt-1">{tSandbox("simulate.messageId")} <strong>{simulateMutation.data.simulated.msgId}</strong></p>
              <p>{tSandbox("simulate.correlationId")} <strong>{simulateMutation.data.simulated.correlationId}</strong></p>
              <p>
                {tSandbox("simulate.outboundMetaMock")} <strong>{simulateMutation.data.simulated.outboundMetaMock ? tSandbox("simulate.enabled") : tSandbox("simulate.disabled")}</strong>
              </p>
              {simulateMutation.data.simulated.conversationId && (
                <p>
                  {tSandbox("simulate.run")} <strong>{simulateMutation.data.simulated.conversationId}</strong> · {tSandbox("simulate.status")} <strong>{simulateMutation.data.simulated.conversationStatus ?? tSandbox("simulate.activeFallback")}</strong>
                </p>
              )}
            </div>
          )}

          {replayMutation.data && (
            <div className="mt-4 rounded-2xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-800">
              <p className="font-medium">{tSandbox("timeline.replayTitle")}</p>
              <p>{tSandbox("timeline.run")} <strong>{replayMutation.data.replay.replayedSteps}</strong></p>
              {replayMutation.data.replay.conversationId && (
                <p>
                  {tSandbox("simulate.run")} <strong>{replayMutation.data.replay.conversationId}</strong> · {tSandbox("simulate.status")} <strong>{replayMutation.data.replay.conversationStatus ?? tSandbox("simulate.activeFallback")}</strong>
                </p>
              )}
            </div>
          )}

          <div className="mt-6 rounded-3xl border border-slate-200 bg-slate-50 p-5">
            <div className="mb-4 flex items-center gap-2 text-slate-900">
              <Clock3 className="h-5 w-5 text-slate-600" />
              <h2 className="text-lg font-semibold">{tSandbox("runs.title")}</h2>
            </div>

            {runsLoading ? (
              <div className="space-y-3">
                {Array.from({ length: 3 }).map((_, index) => (
                  <div key={index} className="h-16 animate-pulse rounded-2xl bg-white" />
                ))}
              </div>
            ) : runs.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-slate-300 bg-white px-4 py-6 text-sm text-slate-500">
                {tSandbox("runs.empty")}
              </div>
            ) : (
              <div className="space-y-3">
                {runs.map((run) => {
                  const active = run.id === selectedRunId;
                  return (
                    <button
                      key={run.id}
                      type="button"
                      onClick={() => setSelectedRunId(run.id)}
                      className={[
                        "w-full rounded-2xl border px-4 py-3 text-left transition",
                        active
                          ? "border-blue-300 bg-blue-50"
                          : "border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-100",
                      ].join(" ")}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <div className="font-medium text-slate-900">{run.flow?.nombre ?? tSandbox("runs.runtimeFallback")}</div>
                          <div className="mt-1 text-xs text-slate-500">{run.id}</div>
                        </div>
                        <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700">
                          {run.status}
                        </span>
                      </div>
                      <div className="mt-2 flex flex-wrap gap-4 text-xs text-slate-500">
                        <span>{tSandbox("runs.startedAt")} {formatDateTime(run.startedAt, locale)}</span>
                        <span>{tSandbox("runs.events")} {run.eventCount}</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </section>

        <div className="space-y-6">
          <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="mb-4 flex items-center gap-2 text-slate-900">
              <ShieldCheck className="h-5 w-5 text-emerald-600" />
              <h2 className="text-lg font-semibold">{tSandbox("capabilities.title")}</h2>
            </div>

            {isLoading ? (
              <div className="space-y-3">
                {Array.from({ length: 5 }).map((_, index) => (
                  <div key={index} className="h-10 animate-pulse rounded-2xl bg-slate-100" />
                ))}
              </div>
            ) : isError ? (
              <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                {tSandbox("errors.capabilitiesLoad")}
              </div>
            ) : (
              <div className="space-y-3">
                <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="font-medium text-slate-900">{tSandbox("capabilities.outboundMetaMockTitle")}</p>
                      <p className="text-xs text-slate-500">{tSandbox("capabilities.outboundMetaMockDescription")}</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => updateSettingsMutation.mutate(!outboundMetaMockEnabled)}
                      disabled={
                        updateSettingsMutation.isPending ||
                        !canManageSandboxSettings ||
                        (superAdmin && !tenantSlug)
                      }
                      className={[
                        "rounded-xl px-3 py-1.5 text-xs font-medium transition",
                        outboundMetaMockEnabled
                          ? "bg-emerald-600 text-white hover:bg-emerald-700"
                          : "bg-slate-200 text-slate-800 hover:bg-slate-300",
                        (updateSettingsMutation.isPending || !canManageSandboxSettings || (superAdmin && !tenantSlug))
                          ? "cursor-not-allowed opacity-60"
                          : "",
                      ].join(" ")}
                    >
                      {updateSettingsMutation.isPending
                        ? tSandbox("capabilities.save")
                        : outboundMetaMockEnabled
                          ? tSandbox("capabilities.deactivate")
                          : tSandbox("capabilities.activate")}
                    </button>
                  </div>
                </div>
                {runtimeEntries.map(([key, enabled]) => (
                  <div key={key} className="flex items-center justify-between rounded-2xl border border-slate-200 px-4 py-3 text-sm">
                    <span className="font-medium text-slate-700">{key}</span>
                    <span className={enabled ? "text-emerald-700" : "text-amber-700"}>
                      {enabled ? tSandbox("capabilities.active") : tSandbox("capabilities.pending")}
                    </span>
                  </div>
                ))}
                {updateSettingsMutation.isError && (
                  <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-700">
                    {tSandbox("errors.updateSettings")}
                  </div>
                )}
              </div>
            )}
          </section>

          <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="mb-4 flex items-center gap-2 text-slate-900">
              <TestTube2 className="h-5 w-5 text-violet-600" />
              <h2 className="text-lg font-semibold">{tSandbox("timeline.title")}</h2>
            </div>

            <div className="mb-4 grid gap-3 md:grid-cols-2">
              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="font-medium text-slate-900">{tSandbox("timeline.replayTitle")}</p>
                    <p className="mt-1 text-xs text-slate-500">{tSandbox("timeline.replayDescription")}</p>
                    {selectedRun && !canReplay && (
                      <p className="mt-1 text-xs text-amber-600">{tSandbox("timeline.replayUnavailable")}</p>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => replayMutation.mutate()}
                    disabled={!selectedRunId || replayMutation.isPending || (superAdmin && !tenantSlug) || !canReplay}
                    className="rounded-xl bg-sky-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-sky-700 disabled:cursor-not-allowed disabled:bg-slate-300"
                  >
                    {replayMutation.isPending ? tSandbox("timeline.replayPending") : tSandbox("timeline.replayButton")}
                  </button>
                </div>
              </div>

              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="font-medium text-slate-900">{tSandbox("timeline.complianceTitle")}</p>
                    <p className="mt-1 text-xs text-slate-500">{tSandbox("timeline.complianceDescription")}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => complianceMutation.mutate()}
                    disabled={!selectedRunId || complianceMutation.isPending || (superAdmin && !tenantSlug)}
                    className="rounded-xl bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-slate-300"
                  >
                    {complianceMutation.isPending ? tSandbox("timeline.compliancePending") : tSandbox("timeline.complianceButton")}
                  </button>
                </div>
              </div>
            </div>

            {replayMutation.isError && (
              <div className="mb-4 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                {getErrorMessage(replayMutation.error, tSandbox("errors.simulateFailed"))}
              </div>
            )}

            {complianceMutation.isError && (
              <div className="mb-4 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                {getErrorMessage(complianceMutation.error, tSandbox("errors.simulateFailed"))}
              </div>
            )}

            {complianceReport && (
              <div className="mb-4 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="font-medium">{tSandbox("timeline.verdict")} {verdictLabels[complianceReport.verdict]}</p>
                    <p className="text-xs text-emerald-800">{tSandbox("timeline.score")} {complianceReport.score}</p>
                  </div>
                  <span className="rounded-full bg-white px-2.5 py-1 text-xs font-medium text-emerald-800">
                    {verdictLabels[complianceReport.verdict]}
                  </span>
                </div>
                <p className="mt-2 text-xs text-emerald-800">{complianceReport.summary}</p>
                <div className="mt-3 grid gap-2">
                  {complianceReport.checks.map((check) => (
                    <div key={check.key} className="flex items-center justify-between rounded-xl border border-emerald-200 bg-white px-3 py-2 text-xs text-slate-700">
                      <span>{check.label}</span>
                      <span className={check.passed ? "text-emerald-700" : "text-amber-700"}>
                        {check.passed ? tSandbox("timeline.checkOk") : tSandbox("timeline.checkPending")}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {!selectedRunId ? (
              <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-4 py-6 text-sm text-slate-500">
                {tSandbox("timeline.selectRun")}
              </div>
            ) : runDetailLoading ? (
              <div className="space-y-3">
                {Array.from({ length: 4 }).map((_, index) => (
                  <div key={index} className="h-14 animate-pulse rounded-2xl bg-slate-100" />
                ))}
              </div>
            ) : selectedRun ? (
              <div className="space-y-4">
                <div className="rounded-2xl bg-slate-50 p-4 text-sm text-slate-600">
                  <p><strong className="text-slate-900">{tSandbox("timeline.run")}</strong> {selectedRun.id}</p>
                  <p><strong className="text-slate-900">{tSandbox("timeline.status")}</strong> {selectedRun.status}</p>
                  <p><strong className="text-slate-900">{tSandbox("timeline.start")}</strong> {formatDateTime(selectedRun.startedAt, locale)}</p>
                  <p><strong className="text-slate-900">{tSandbox("timeline.end")}</strong> {formatDateTime(selectedRun.endedAt, locale)}</p>
                </div>

                <div className="space-y-3">
                  {selectedRun.events.map((event) => (
                    <div key={event.id} className="rounded-2xl border border-slate-200 p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="font-medium text-slate-900">{event.eventType}</div>
                          <div className="mt-1 text-xs text-slate-500">{tSandbox("timeline.node")} {event.nodeRef ?? "-"}</div>
                        </div>
                        <div className="text-xs text-slate-500">{formatDateTime(event.createdAt, locale)}</div>
                      </div>
                      <pre className="mt-3 overflow-auto rounded-xl bg-slate-950 p-3 text-[11px] text-slate-100">
                        {JSON.stringify(event.payload ?? {}, null, 2)}
                      </pre>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                {tSandbox("errors.runDetail")}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}