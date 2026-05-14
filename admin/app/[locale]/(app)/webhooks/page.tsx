"use client";

import { Card, CardContent, CardHeader } from "@/components/ui/Card";
import { solicitudesApi } from "@/lib/api";
import { formatDate } from "@/lib/utils";
import { useAuthStore } from "@/store/auth";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BellRing, Plus, Send, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";

type WebhookConfig = {
  id: number;
  event: string;
  url: string;
  active: boolean;
  failureCount: number;
  lastTriggeredAt: string | null;
};

type DeliveryLog = {
  id: number;
  accion: string;
  entidadId: string | null;
  metadata?: {
    event?: string;
    status?: number;
    durationMs?: number;
    url?: string;
    error?: string | null;
  };
  createdAt: string;
};

const EVENT_OPTIONS = [
  "solicitud.created",
  "solicitud.updated",
  "solicitud.status_changed",
  "solicitud.assigned",
  "solicitud.escalated",
  "solicitud.comment_added",
];

export default function WebhooksPage() {
  const t = useTranslations("webhooks");
  const { tenantSlug } = useAuthStore();
  const qc = useQueryClient();

  const [event, setEvent] = useState("solicitud.updated");
  const [url, setUrl] = useState("");
  const [active, setActive] = useState(true);
  const [statusFilter, setStatusFilter] = useState("all");

  const { data: hooksData, isLoading } = useQuery({
    queryKey: ["solicitudes-webhooks", tenantSlug],
    queryFn: () => solicitudesApi.listWebhooks(tenantSlug!).then((r) => r.data),
    enabled: !!tenantSlug,
  });

  const { data: deliveriesData, isFetching: deliveriesFetching } = useQuery({
    queryKey: ["solicitudes-webhook-deliveries", tenantSlug, statusFilter],
    queryFn: () =>
      solicitudesApi
        .listWebhookDeliveries(tenantSlug!, {
          limit: 50,
          status: statusFilter === "all" ? undefined : statusFilter,
        })
        .then((r) => r.data),
    enabled: !!tenantSlug,
  });

  const createWebhook = useMutation({
    mutationFn: () =>
      solicitudesApi.createWebhook(tenantSlug!, {
        event,
        url,
        active,
      }),
    onSuccess: () => {
      setUrl("");
      qc.invalidateQueries({ queryKey: ["solicitudes-webhooks", tenantSlug] });
    },
  });

  const updateWebhook = useMutation({
    mutationFn: ({ id, active }: { id: number; active: boolean }) =>
      solicitudesApi.updateWebhook(tenantSlug!, id, { active }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["solicitudes-webhooks", tenantSlug] });
    },
  });

  const removeWebhook = useMutation({
    mutationFn: (id: number) => solicitudesApi.deleteWebhook(tenantSlug!, id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["solicitudes-webhooks", tenantSlug] });
    },
  });

  const testWebhook = useMutation({
    mutationFn: (eventToTest: string) => solicitudesApi.testWebhook(tenantSlug!, eventToTest),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["solicitudes-webhook-deliveries", tenantSlug] });
    },
  });

  const hooks = useMemo<WebhookConfig[]>(() => hooksData?.data ?? [], [hooksData]);
  const deliveries = useMemo<DeliveryLog[]>(() => deliveriesData?.data ?? [], [deliveriesData]);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <h1 className="text-lg font-semibold text-slate-900">{t("title")}</h1>
          <p className="text-sm text-slate-500 mt-1">
            {t("description")}
          </p>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
            <label className="text-sm md:col-span-2">
              <span className="text-slate-500">{t("form.event")}</span>
              <select
                value={event}
                onChange={(e) => setEvent(e.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2"
              >
                {EVENT_OPTIONS.map((ev) => (
                  <option key={ev} value={ev}>
                    {ev}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm md:col-span-2">
              <span className="text-slate-500">{t("form.url")}</span>
              <input
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder={t("form.urlPlaceholder")}
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2"
              />
            </label>
            <label className="text-sm flex items-end">
              <span className="inline-flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 w-full h-[42px]">
                <input
                  type="checkbox"
                  checked={active}
                  onChange={(e) => setActive(e.target.checked)}
                />
                {t("form.active")}
              </span>
            </label>
          </div>

          <div className="pt-4 flex justify-end">
            <button
              onClick={() => createWebhook.mutate()}
              disabled={!url.trim() || createWebhook.isPending}
              className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              <Plus size={16} />
              {createWebhook.isPending ? t("form.saving") : t("form.save")}
            </button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <h2 className="font-semibold text-slate-900">{t("config.title")}</h2>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <p className="text-sm text-slate-400 py-10 text-center">{t("config.loading")}</p>
          ) : hooks.length === 0 ? (
            <p className="text-sm text-slate-400 py-10 text-center">{t("config.empty")}</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-slate-50">
                <tr>
                  <th className="text-left px-6 py-3 text-xs font-medium text-slate-500 uppercase">{t("config.headers.event")}</th>
                  <th className="text-left px-6 py-3 text-xs font-medium text-slate-500 uppercase">{t("config.headers.url")}</th>
                  <th className="text-right px-6 py-3 text-xs font-medium text-slate-500 uppercase">{t("config.headers.status")}</th>
                  <th className="text-right px-6 py-3 text-xs font-medium text-slate-500 uppercase">{t("config.headers.actions")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {hooks.map((hook) => (
                  <tr key={hook.id}>
                    <td className="px-6 py-3 text-slate-800">{hook.event}</td>
                    <td className="px-6 py-3 text-slate-600 max-w-[420px] truncate">{hook.url}</td>
                    <td className="px-6 py-3 text-right">
                      <span
                        className={`inline-flex rounded-full px-2 py-1 text-xs font-medium ${
                          hook.active ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-600"
                        }`}
                      >
                        {hook.active ? t("config.statusActive") : t("config.statusInactive")}
                      </span>
                      <p className="text-xs text-slate-400 mt-1">
                        {t("config.failures")} {hook.failureCount} · {t("config.last")} {hook.lastTriggeredAt ? formatDate(hook.lastTriggeredAt) : "-"}
                      </p>
                    </td>
                    <td className="px-6 py-3">
                      <div className="flex justify-end gap-2">
                        <button
                          onClick={() => updateWebhook.mutate({ id: hook.id, active: !hook.active })}
                          className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2 py-1 text-xs text-slate-700 hover:bg-slate-50"
                        >
                          <BellRing size={14} />
                          {hook.active ? t("config.disable") : t("config.enable")}
                        </button>
                        <button
                          onClick={() => testWebhook.mutate(hook.event)}
                          className="inline-flex items-center gap-1 rounded-lg border border-indigo-200 bg-indigo-50 px-2 py-1 text-xs text-indigo-700 hover:bg-indigo-100"
                        >
                          <Send size={14} />
                          {t("config.test")}
                        </button>
                        <button
                          onClick={() => removeWebhook.mutate(hook.id)}
                          className="inline-flex items-center gap-1 rounded-lg border border-rose-200 bg-rose-50 px-2 py-1 text-xs text-rose-700 hover:bg-rose-100"
                        >
                          <Trash2 size={14} />
                          {t("config.delete")}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex items-center justify-between">
          <h2 className="font-semibold text-slate-900">{t("deliveries.title")}</h2>
          <div className="flex items-center gap-2">
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="rounded-lg border border-slate-200 px-2 py-1 text-sm"
            >
              <option value="all">{t("deliveries.filters.all")}</option>
              <option value="ok">{t("deliveries.filters.ok")}</option>
              <option value="failed">{t("deliveries.filters.failed")}</option>
            </select>
            {deliveriesFetching && <span className="text-xs text-slate-400">{t("deliveries.refreshing")}</span>}
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {deliveries.length === 0 ? (
            <p className="text-sm text-slate-400 py-10 text-center">{t("deliveries.empty")}</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-slate-50">
                <tr>
                  <th className="text-left px-6 py-3 text-xs font-medium text-slate-500 uppercase">{t("deliveries.headers.date")}</th>
                  <th className="text-left px-6 py-3 text-xs font-medium text-slate-500 uppercase">{t("deliveries.headers.event")}</th>
                  <th className="text-left px-6 py-3 text-xs font-medium text-slate-500 uppercase">{t("deliveries.headers.result")}</th>
                  <th className="text-left px-6 py-3 text-xs font-medium text-slate-500 uppercase">{t("deliveries.headers.detail")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {deliveries.map((row) => {
                  const ok = row.accion === "SOLICITUD_WEBHOOK_DELIVERED";
                  return (
                    <tr key={row.id}>
                      <td className="px-6 py-3 text-slate-700">{formatDate(row.createdAt)}</td>
                      <td className="px-6 py-3 text-slate-700">{row.metadata?.event || "-"}</td>
                      <td className="px-6 py-3">
                        <span
                          className={`inline-flex rounded-full px-2 py-1 text-xs font-medium ${
                            ok ? "bg-emerald-100 text-emerald-700" : "bg-rose-100 text-rose-700"
                          }`}
                        >
                            {ok ? "OK" : t("deliveries.resultFailed")}
                        </span>
                      </td>
                      <td className="px-6 py-3 text-xs text-slate-500">
                          {t("deliveries.detailStatus")}{row.metadata?.status ?? "-"} · {row.metadata?.durationMs ?? "-"}{t("deliveries.detailDuration")}
                        {row.metadata?.error ? ` · ${row.metadata.error}` : ""}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
