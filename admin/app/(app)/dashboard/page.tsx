"use client";

import { metricsApi, solicitudesApi, whatsappApi } from "@/lib/api";
import { buildPermissionSet } from "@/lib/permissions";
import { useAuthStore } from "@/store/auth";
import { useQuery } from "@tanstack/react-query";
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
  const { tenantSlug, superAdmin, permissions } = useAuthStore();
  const permissionSet = buildPermissionSet(permissions);
  const canViewMetrics = superAdmin || permissionSet.has("VIEW_METRICS");
  const canViewSolicitudes = superAdmin || permissionSet.has("VIEW_SOLICITUDES");

  const { data: metrics } = useQuery({
    queryKey: ["metrics", tenantSlug],
    queryFn: () => metricsApi.get(tenantSlug).then((r) => r.data),
    enabled: !!tenantSlug && canViewMetrics,
  });

  const { data: tenantData } = useQuery({
    queryKey: ["tenant", tenantSlug],
    queryFn: () =>
      import("@/lib/api").then(({ apiClient }) =>
        apiClient.get(`/admin/tenants/${tenantSlug}`).then((r) => r.data)
      ),
    enabled: !!tenantSlug,
    staleTime: Infinity,
  });
  const tenantId: string | null = tenantData?.id ?? null;

  const { data: conversacionesData } = useQuery({
    queryKey: ["conversaciones", tenantId],
    queryFn: () => whatsappApi.listConversaciones(tenantId!).then((r) => r.data),
    enabled: !!tenantId,
    staleTime: 60_000,
  });
  const mensajesHoy = conversacionesData?.data?.length ?? 0;

  const { data: solicitudesData } = useQuery({
    queryKey: ["solicitudes", tenantSlug, { limit: 5 }],
    queryFn: () =>
      solicitudesApi.list(tenantSlug, { limit: 5, page: 1 }).then((r) => r.data),
    enabled: !!tenantSlug && canViewSolicitudes,
  });

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
          title="Solicitudes pendientes"
          value={pendientes}
          sub="Esperando atención"
          color="bg-amber-100 text-amber-600"
        />
        <KpiCard
          icon={AlertTriangle}
          title="Urgencias activas"
          value={urgencias}
          sub="Requieren atención inmediata"
          color="bg-red-100 text-red-600"
        />
        <KpiCard
          icon={CalendarCheck}
          title="Atendidas"
          value={atendidas}
          sub="Este período"
          color="bg-green-100 text-green-600"
        />
        <KpiCard
          icon={MessageSquare}
          title="Conversaciones WhatsApp"
          value={mensajesHoy}
          sub="Usuarios ativos"
          color="bg-indigo-100 text-indigo-600"
        />
        <KpiCard
          icon={TrendingUp}
          title="Total usuarios"
          value={metrics?.totalUsers ?? "–"}
          sub="Registrados"
          color="bg-blue-100 text-blue-600"
        />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        {/* Chart */}
        <Card className="xl:col-span-1">
          <CardHeader>
            <h2 className="font-semibold text-slate-800">Solicitudes por estado</h2>
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
                Sin datos disponibles
              </p>
            )}
          </CardContent>
        </Card>

        {/* Recent solicitudes */}
        <Card className="xl:col-span-2">
          <CardHeader className="flex items-center justify-between">
            <h2 className="font-semibold text-slate-800">Últimas solicitudes</h2>
            <a
              href="/solicitudes"
              className="text-sm text-blue-600 hover:text-blue-700 font-medium"
            >
              Ver todas →
            </a>
          </CardHeader>
          {solicitudes.length === 0 ? (
            <CardContent>
              <p className="text-slate-400 text-sm py-8 text-center">
                No hay solicitudes recientes
              </p>
            </CardContent>
          ) : (
            <div className="overflow-hidden rounded-b-2xl">
              <table className="w-full text-sm">
                <thead className="bg-slate-50">
                  <tr>
                    <th className="text-left px-6 py-3 text-xs font-medium text-slate-500 uppercase tracking-wide">
                      Nombre
                    </th>
                    <th className="text-left px-4 py-3 text-xs font-medium text-slate-500 uppercase tracking-wide hidden md:table-cell">
                      Horario
                    </th>
                    <th className="text-left px-4 py-3 text-xs font-medium text-slate-500 uppercase tracking-wide">
                      Estado
                    </th>
                    <th className="text-left px-4 py-3 text-xs font-medium text-slate-500 uppercase tracking-wide hidden lg:table-cell">
                      Fecha
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
