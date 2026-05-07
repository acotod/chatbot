"use client";

import { Card, CardContent, CardHeader } from "@/components/ui/Card";
import { metricsApi } from "@/lib/api";
import { formatDateShort } from "@/lib/utils";
import { useAuthStore } from "@/store/auth";
import { useQuery } from "@tanstack/react-query";
import { Download, Filter } from "lucide-react";
import { useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

type ReportResponse = {
  summary: {
    total: number;
    open: number;
    inProgress: number;
    pendingInfo: number;
    completed: number;
    rejected: number;
    avgResolutionMinutes: number | null;
  };
  byStatus: Array<{ estado: string; total: number }>;
  byPriority: Array<{ prioridad: string; total: number }>;
  byAgent: Array<{ agenteId: number | null; agenteNombre: string; total: number }>;
  series: Array<{ bucket: string; total: number; completed: number; rejected: number }>;
};

function toDateInputValue(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function toCsv(rows: Array<Record<string, string | number>>): string {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]);
  const lines = [headers.join(",")];

  for (const row of rows) {
    const values = headers.map((key) => {
      const raw = String(row[key] ?? "");
      if (raw.includes(",") || raw.includes('"') || raw.includes("\n")) {
        return `"${raw.replace(/"/g, '""')}"`;
      }
      return raw;
    });
    lines.push(values.join(","));
  }

  return lines.join("\n");
}

function downloadCsv(filename: string, rows: Array<Record<string, string | number>>) {
  const csv = toCsv(rows);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export default function ReportesPage() {
  const { tenantSlug } = useAuthStore();

  const [from, setFrom] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return toDateInputValue(d);
  });
  const [to, setTo] = useState(() => toDateInputValue(new Date()));
  const [groupBy, setGroupBy] = useState<"day" | "week" | "month">("day");

  const { data, isLoading, isFetching } = useQuery({
    queryKey: ["solicitudes-report", tenantSlug, from, to, groupBy],
    queryFn: () =>
      metricsApi
        .solicitudesReport(tenantSlug!, { from, to, groupBy })
        .then((r) => r.data as ReportResponse),
    enabled: !!tenantSlug,
  });

  const trendData = useMemo(
    () =>
      (data?.series ?? []).map((point) => ({
        ...point,
        label: formatDateShort(point.bucket),
      })),
    [data]
  );

  const resolutionHours =
    data?.summary.avgResolutionMinutes != null
      ? (data.summary.avgResolutionMinutes / 60).toFixed(1)
      : "-";

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
          <div>
            <h1 className="text-lg font-semibold text-slate-900">Reportes de Solicitudes</h1>
            <p className="text-sm text-slate-500 mt-1">Analitica operativa por rango de fechas y agente</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                const rows = (data?.series ?? []).map((item) => ({
                  fecha: item.bucket,
                  total: item.total,
                  completadas: item.completed,
                  rechazadas: item.rejected,
                }));
                downloadCsv(`solicitudes-serie-${from}-a-${to}.csv`, rows);
              }}
              disabled={!data?.series?.length}
              className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              <Download size={16} />
              Exportar CSV
            </button>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
            <label className="text-sm">
              <span className="text-slate-500">Desde</span>
              <input
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2"
              />
            </label>
            <label className="text-sm">
              <span className="text-slate-500">Hasta</span>
              <input
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2"
              />
            </label>
            <label className="text-sm">
              <span className="text-slate-500">Agrupacion</span>
              <select
                value={groupBy}
                onChange={(e) => setGroupBy(e.target.value as "day" | "week" | "month")}
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2"
              >
                <option value="day">Dia</option>
                <option value="week">Semana</option>
                <option value="month">Mes</option>
              </select>
            </label>
            <div className="rounded-lg border border-slate-100 bg-slate-50 px-3 py-2 flex items-center gap-2 text-sm text-slate-600 mt-6 md:mt-0">
              <Filter size={16} className={isFetching ? "animate-pulse" : ""} />
              {isFetching ? "Actualizando reporte..." : "Filtros aplicados"}
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
        <Card>
          <CardContent>
            <p className="text-sm text-slate-500">Total solicitudes</p>
            <p className="text-2xl font-bold text-slate-900 mt-1">{data?.summary.total ?? 0}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent>
            <p className="text-sm text-slate-500">Completadas</p>
            <p className="text-2xl font-bold text-emerald-700 mt-1">{data?.summary.completed ?? 0}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent>
            <p className="text-sm text-slate-500">Abiertas + En progreso</p>
            <p className="text-2xl font-bold text-amber-700 mt-1">{(data?.summary.open ?? 0) + (data?.summary.inProgress ?? 0)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent>
            <p className="text-sm text-slate-500">Tiempo medio resolucion</p>
            <p className="text-2xl font-bold text-indigo-700 mt-1">{resolutionHours} h</p>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        <Card className="xl:col-span-2">
          <CardHeader>
            <h2 className="font-semibold text-slate-900">Tendencia en el tiempo</h2>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <p className="text-sm text-slate-400 py-14 text-center">Cargando reporte...</p>
            ) : trendData.length === 0 ? (
              <p className="text-sm text-slate-400 py-14 text-center">Sin datos para el rango seleccionado</p>
            ) : (
              <ResponsiveContainer width="100%" height={280}>
                <LineChart data={trendData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis dataKey="label" tick={{ fontSize: 12 }} />
                  <YAxis tick={{ fontSize: 12 }} allowDecimals={false} />
                  <Tooltip />
                  <Line type="monotone" dataKey="total" stroke="#2563eb" strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="completed" stroke="#059669" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <h2 className="font-semibold text-slate-900">Por estado</h2>
          </CardHeader>
          <CardContent>
            {(data?.byStatus?.length ?? 0) === 0 ? (
              <p className="text-sm text-slate-400 py-10 text-center">Sin datos</p>
            ) : (
              <ResponsiveContainer width="100%" height={260}>
                <BarChart data={data?.byStatus ?? []} layout="vertical" margin={{ left: 16, right: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis type="number" allowDecimals={false} tick={{ fontSize: 12 }} />
                  <YAxis type="category" dataKey="estado" tick={{ fontSize: 12 }} width={90} />
                  <Tooltip />
                  <Bar dataKey="total" fill="#0f766e" radius={[0, 6, 6, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <h2 className="font-semibold text-slate-900">Top agentes por volumen</h2>
        </CardHeader>
        <CardContent className="p-0">
          {(data?.byAgent?.length ?? 0) === 0 ? (
            <p className="text-sm text-slate-400 py-10 text-center">Sin datos de agentes para este rango</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-slate-50">
                <tr>
                  <th className="text-left px-6 py-3 text-xs font-medium text-slate-500 uppercase">Agente</th>
                  <th className="text-right px-6 py-3 text-xs font-medium text-slate-500 uppercase">Solicitudes</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {(data?.byAgent ?? []).map((row) => (
                  <tr key={`${row.agenteId ?? "none"}-${row.agenteNombre}`}>
                    <td className="px-6 py-3 text-slate-800">{row.agenteNombre}</td>
                    <td className="px-6 py-3 text-right font-semibold text-slate-900">{row.total}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
