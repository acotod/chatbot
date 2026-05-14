"use client";

import { agentAuthApi } from "@/lib/agentApi";
import { getStoredAgentAccessToken, useAgentAuthStore } from "@/store/agentAuth";
import { metricsApi, solicitudesApi, whatsappApi } from "@/lib/api";
import { buildPermissionSet } from "@/lib/permissions";
import { getStoredAccessToken, useAuthStore } from "@/store/auth";
import { useQuery } from "@tanstack/react-query";
import axios from "axios";
import { AlertTriangle, CalendarCheck, ClipboardList, MessageSquare, TrendingUp } from "lucide-react";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { Card, CardContent, CardHeader } from "@/components/ui/Card";
import { formatDate } from "@/lib/utils";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useTranslations } from "@/lib/i18n/client";

type AgentProfile = {
  agenteId: number;
  tenantId: string;
  tenantSlug: string;
  tenantNombre: string | null;
  nombre: string;
  email: string;
  whatsapp: string | null;
  estado: string;
  puesto: { id: number; nombre: string } | null;
  calendarLink: string | null;
  lastSeenAt: string | null;
};

function KpiCard({
  icon: Icon,
  title,
  value,
  sub,
  color,
}: {
  icon: React.ElementType;
  title: string;
  value: string | number;
  sub?: string;
  color: string;
}) {
  return (
    <Card>
      <CardContent className="flex items-start gap-4">
        <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${color}`}>
          <Icon size={20} />
        </div>
        <div>
          <p className="text-sm text-slate-500">{title}</p>
          <p className="text-2xl font-bold text-slate-900 leading-tight">
            {value}
          </p>
          {sub && <p className="text-xs text-slate-400 mt-0.5">{sub}</p>}
        </div>
      </CardContent>
    </Card>
  );
}

export default function DashboardPage() {
  const t = useTranslations("dashboard");
  const router = useRouter();
  const { logout: logoutAgent } = useAgentAuthStore();
  const hasAdminAccessToken = Boolean(getStoredAccessToken());
  const hasAgentAccessToken = Boolean(getStoredAgentAccessToken());
  const isAgentSession = hasAgentAccessToken && !hasAdminAccessToken;
  const { tenantSlug, superAdmin, permissions } = useAuthStore();
  const [agentProfile, setAgentProfile] = useState<AgentProfile | null>(null);
  const [agentLoading, setAgentLoading] = useState(false);
  const [agentError, setAgentError] = useState("");
  const {
    data: agentKpis,
    isLoading: agentKpisLoading,
  } = useQuery({
    queryKey: ["agent-kpis", agentProfile?.agenteId ?? null],
    queryFn: () => agentAuthApi.kpis().then((r) => r.data),
    enabled: isAgentSession,
    staleTime: 30_000,
  });
  const permissionSet = buildPermissionSet(permissions);
  const canViewMetrics = superAdmin || permissionSet.has("VIEW_METRICS");
  const canViewSolicitudes = superAdmin || permissionSet.has("VIEW_SOLICITUDES");

  const { data: metrics } = useQuery({
    queryKey: ["metrics", tenantSlug],
    queryFn: () => metricsApi.get(tenantSlug).then((r) => r.data),
    enabled: !isAgentSession && !!tenantSlug && canViewMetrics,
  });

  const { data: tenantData } = useQuery({
    queryKey: ["tenant", tenantSlug],
    queryFn: () =>
      import("@/lib/api").then(({ apiClient }) =>
        apiClient.get(`/admin/tenants/${tenantSlug}`).then((r) => r.data)
      ),
    enabled: !isAgentSession && !!tenantSlug,
    staleTime: Infinity,
  });
  const tenantId: string | null = tenantData?.id ?? null;

  const { data: conversacionesData } = useQuery({
    queryKey: ["conversaciones", tenantSlug, tenantId],
    queryFn: () => whatsappApi.listConversaciones({ tenantSlug: tenantSlug || undefined, tenantId: tenantId ?? undefined }).then((r) => r.data),
    enabled: !isAgentSession && !!tenantId,
    staleTime: 60_000,
  });
  const mensajesHoy = conversacionesData?.data?.length ?? 0;

  const { data: solicitudesData } = useQuery({
    queryKey: ["solicitudes", tenantSlug, { limit: 5 }],
    queryFn: () =>
      solicitudesApi.list(tenantSlug, { limit: 5, page: 1 }).then((r) => r.data),
    enabled: !isAgentSession && !!tenantSlug && canViewSolicitudes,
  });

  useEffect(() => {
    if (!isAgentSession) return;

    let cancelled = false;
    setAgentLoading(true);
    setAgentError("");

    async function loadAgentProfile() {
      try {
        const res = await agentAuthApi.me();
        if (!cancelled) {
          setAgentProfile(res.data);
        }
      } catch (err) {
        if (!cancelled) {
          const status = axios.isAxiosError(err) ? err.response?.status : undefined;
          if (status === 401) {
            logoutAgent();
            router.replace("/agente/login?reason=expired");
            return;
          }
          setAgentError(t("agentPanel.error"));
        }
      } finally {
        if (!cancelled) {
          setAgentLoading(false);
        }
      }
    }

    void loadAgentProfile();

    return () => {
      cancelled = true;
    };
  }, [isAgentSession, logoutAgent, router]);

  if (isAgentSession) {
    if (agentLoading) {
      return <div className="rounded-3xl bg-white border border-slate-200 shadow-sm p-6 text-sm text-slate-500">{t("agentPanel.loading")}</div>;
    }

    if (agentError) {
      return <div className="rounded-3xl bg-white border border-red-200 shadow-sm p-6 text-sm text-red-600">{agentError}</div>;
    }

    if (!agentProfile) {
      return null;
    }

    return (
      <div className="space-y-6">
        <div className="rounded-3xl bg-white border border-slate-200 shadow-sm p-6 sm:p-8">
          <p className="text-sm font-medium uppercase tracking-[0.2em] text-cyan-600">{t("agentPanel.eyebrow")}</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-900">{t("agentPanel.title")}</h1>
          <p className="mt-2 text-slate-600">{t("agentPanel.subtitle")}</p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
          <KpiCard
            icon={ClipboardList}
            title={t("agentPanel.kpis.activeRequests")}
            value={agentKpisLoading ? "..." : (agentKpis?.solicitudesActivas ?? 0)}
            sub={t("agentPanel.kpis.assignedToYou")}
            color="bg-amber-100 text-amber-600"
          />
          <KpiCard
            icon={CalendarCheck}
            title={t("agentPanel.kpis.completedMonth")}
            value={agentKpisLoading ? "..." : (agentKpis?.solicitudesCompletadasMes ?? 0)}
            sub={t("agentPanel.kpis.resolvedThisMonth")}
            color="bg-green-100 text-green-600"
          />
          <KpiCard
            icon={TrendingUp}
            title={t("agentPanel.kpis.agendaNext7Days")}
            value={agentKpisLoading ? "..." : (agentKpis?.agendaProximos7Dias ?? 0)}
            sub={t("agentPanel.kpis.upcomingEvents")}
            color="bg-blue-100 text-blue-600"
          />
          <KpiCard
            icon={AlertTriangle}
            title={t("agentPanel.kpis.overdueAgenda")}
            value={agentKpisLoading ? "..." : (agentKpis?.agendaVencida ?? 0)}
            sub={t("agentPanel.kpis.pastPending")}
            color="bg-red-100 text-red-600"
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <div className="rounded-3xl bg-white border border-slate-200 shadow-sm p-6 sm:col-span-2">
            <p className="text-xs uppercase tracking-[0.2em] text-slate-400">{t("agentPanel.welcome")}</p>
            <h2 className="mt-2 text-2xl font-semibold text-slate-900">{agentProfile.nombre}</h2>
            <p className="mt-2 text-sm text-slate-600">
              {t("agentPanel.company")} <span className="font-medium text-slate-900">{agentProfile.tenantNombre || agentProfile.tenantSlug}</span>
            </p>
            <p className="mt-1 text-sm text-slate-600">
              {t("agentPanel.status")} <span className="font-medium text-slate-900">{agentProfile.estado}</span>
            </p>
            <div className="mt-4">
              <Link href="/agente/perfil" className="inline-flex rounded-xl bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-700 transition">
                {t("agentPanel.viewProfile")}
              </Link>
            </div>
          </div>

          <div className="rounded-3xl bg-white border border-slate-200 shadow-sm p-6">
            <p className="text-xs uppercase tracking-[0.2em] text-slate-400">{t("agentPanel.summary")}</p>
            <div className="mt-3 space-y-2 text-sm text-slate-600">
              <p><span className="font-medium text-slate-900">{t("agentPanel.email")}</span> {agentProfile.email}</p>
              <p><span className="font-medium text-slate-900">{t("agentPanel.position")}</span> {agentProfile.puesto?.nombre || t("agentPanel.noPosition")}</p>
              <p><span className="font-medium text-slate-900">{t("agentPanel.lastAccess")}</span> {agentProfile.lastSeenAt ? new Date(agentProfile.lastSeenAt).toLocaleString("es-ES") : t("agentPanel.noRecord")}</p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const solicitudes = solicitudesData?.data ?? [];
  const porEstado = metrics?.solicitudesPorEstado ?? {};

  const chartData = Object.entries(porEstado).map(([name, value]) => ({
    name,
    total: value,
  }));

  const urgencias = porEstado.urgente ?? 0;
  const pendientes = porEstado.pendiente ?? 0;
  const atendidas = porEstado.atendida ?? 0;

  return (
    <div className="space-y-6">
      {/* KPIs */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 gap-4">
        <KpiCard
          icon={ClipboardList}
          title={t("kpis.pendingRequests")}
          value={pendientes}
          sub={t("kpis.waitingAttention")}
          color="bg-amber-100 text-amber-600"
        />
        <KpiCard
          icon={AlertTriangle}
          title={t("kpis.activeUrgencies")}
          value={urgencias}
          sub={t("kpis.requireImmediate")}
          color="bg-red-100 text-red-600"
        />
        <KpiCard
          icon={CalendarCheck}
          title={t("kpis.attended")}
          value={atendidas}
          sub={t("kpis.thisPeriod")}
          color="bg-green-100 text-green-600"
        />
        <KpiCard
          icon={MessageSquare}
          title={t("kpis.whatsappConversations")}
          value={mensajesHoy}
          sub={t("kpis.activeUsers")}
          color="bg-indigo-100 text-indigo-600"
        />
        <KpiCard
          icon={TrendingUp}
          title={t("kpis.totalUsers")}
          value={metrics?.totalUsers ?? "–"}
          sub={t("kpis.registered")}
          color="bg-blue-100 text-blue-600"
        />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        {/* Chart */}
        <Card className="xl:col-span-1">
          <CardHeader>
            <h2 className="font-semibold text-slate-800">{t("chart.title")}</h2>
          </CardHeader>
          <CardContent>
            {chartData.length > 0 ? (
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={chartData} barSize={32}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis
                    dataKey="name"
                    tick={{ fontSize: 12, fill: "#94a3b8" }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis
                    tick={{ fontSize: 12, fill: "#94a3b8" }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <Tooltip
                    contentStyle={{
                      borderRadius: 12,
                      border: "1px solid #e2e8f0",
                      fontSize: 13,
                    }}
                  />
                  <Bar dataKey="total" fill="#2563eb" radius={[6, 6, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <p className="text-slate-400 text-sm py-12 text-center">
                {t("chart.noData")}
              </p>
            )}
          </CardContent>
        </Card>

        {/* Recent solicitudes */}
        <Card className="xl:col-span-2">
          <CardHeader className="flex items-center justify-between">
            <h2 className="font-semibold text-slate-800">{t("recentRequests.title")}</h2>
            <a
              href="/solicitudes"
              className="text-sm text-blue-600 hover:text-blue-700 font-medium"
            >
              {t("recentRequests.viewAll")}
            </a>
          </CardHeader>
          {solicitudes.length === 0 ? (
            <CardContent>
              <p className="text-slate-400 text-sm py-8 text-center">
                {t("recentRequests.empty")}
              </p>
            </CardContent>
          ) : (
            <div className="overflow-hidden rounded-b-2xl">
              <table className="w-full text-sm">
                <thead className="bg-slate-50">
                  <tr>
                    <th className="text-left px-6 py-3 text-xs font-medium text-slate-500 uppercase tracking-wide">
                      {t("recentRequests.cols.name")}
                    </th>
                    <th className="text-left px-4 py-3 text-xs font-medium text-slate-500 uppercase tracking-wide hidden md:table-cell">
                      {t("recentRequests.cols.schedule")}
                    </th>
                    <th className="text-left px-4 py-3 text-xs font-medium text-slate-500 uppercase tracking-wide">
                      {t("recentRequests.cols.status")}
                    </th>
                    <th className="text-left px-4 py-3 text-xs font-medium text-slate-500 uppercase tracking-wide hidden lg:table-cell">
                      {t("recentRequests.cols.date")}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {solicitudes.map(
                    (s: {
                      id: number;
                      nombre: string;
                      horario: string;
                      estado: string;
                      createdAt: string;
                    }) => (
                      <tr key={s.id} className="hover:bg-slate-50 transition">
                        <td className="px-6 py-3 font-medium text-slate-900">
                          {s.nombre}
                        </td>
                        <td className="px-4 py-3 text-slate-600 hidden md:table-cell">
                          {s.horario}
                        </td>
                        <td className="px-4 py-3">
                          <StatusBadge status={s.estado} />
                        </td>
                        <td className="px-4 py-3 text-slate-500 text-xs hidden lg:table-cell">
                          {formatDate(s.createdAt)}
                        </td>
                      </tr>
                    )
                  )}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
