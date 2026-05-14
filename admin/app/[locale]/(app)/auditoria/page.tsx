"use client";
import { Fragment, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { auditApi } from "@/lib/api";
import { formatDate } from "@/lib/utils";
import { useTranslations } from "next-intl";
import { ChevronDown, ChevronRight, Search } from "lucide-react";

interface AuditLog {
  id: number;
  accion: string;
  entidad: string;
  entidadId: string | null;
  tenantId: string | null;
  createdAt: string;
  metadata: Record<string, unknown> | null;
  adminUser: { email: string; nombre: string } | null;
}

export default function AuditoriaPage() {
  const t = useTranslations("auditoria");
  const [page, setPage] = useState(1);
  const [accion, setAccion] = useState("");
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const { data, isLoading } = useQuery({
    queryKey: ["audit", page, accion],
    queryFn: () =>
      auditApi
        .list({ page, limit: 50, ...(accion ? { accion } : {}) })
        .then((r) => r.data),
    staleTime: 10_000,
  });

  const logs: AuditLog[] = data?.data ?? [];
  const total: number = data?.total ?? 0;
  const totalPages = Math.ceil(total / 50) || 1;

  function toggleExpanded(id: number) {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">{t("header.title")}</h1>
        <p className="text-sm text-gray-500 mt-1">
          {t("header.description")}
        </p>
      </div>

      {/* Filter */}
      <div className="flex items-center gap-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            value={accion}
            onChange={(e) => { setAccion(e.target.value); setPage(1); }}
            placeholder={t("filters.actionPlaceholder")}
            className="pl-9 pr-4 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 w-64"
          />
        </div>
        <span className="text-sm text-gray-500">{t("filters.records", { total })}</span>
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-gray-600 w-6" />
              <th className="px-4 py-3 text-left font-medium text-gray-600">{t("table.action")}</th>
              <th className="px-4 py-3 text-left font-medium text-gray-600">{t("table.entity")}</th>
              <th className="px-4 py-3 text-left font-medium text-gray-600">{t("table.user")}</th>
              <th className="px-4 py-3 text-left font-medium text-gray-600">{t("table.date")}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {isLoading
              ? Array.from({ length: 10 }).map((_, i) => (
                  <tr key={i}>
                    {Array.from({ length: 5 }).map((__, j) => (
                      <td key={j} className="px-4 py-3">
                        <div className="h-4 bg-gray-100 rounded animate-pulse" />
                      </td>
                    ))}
                  </tr>
                ))
                  : logs.map((log) => (
                    <Fragment key={log.id}>
                    <tr
                      className="hover:bg-gray-50 cursor-pointer"
                      onClick={() => toggleExpanded(log.id)}
                    >
                      <td className="px-4 py-3 text-gray-400">
                        {expanded.has(log.id) ? (
                          <ChevronDown className="w-4 h-4" />
                        ) : (
                          <ChevronRight className="w-4 h-4" />
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <span className="font-mono text-xs bg-blue-50 text-blue-700 px-2 py-1 rounded">
                          {log.accion}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-gray-700">
                        {log.entidad}
                        {log.entidadId && (
                          <span className="text-gray-400 ml-1">#{log.entidadId}</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-gray-600">
                        {log.adminUser?.email ?? t("table.systemUser")}
                      </td>
                      <td className="px-4 py-3 text-gray-500">
                        {formatDate(log.createdAt)}
                      </td>
                    </tr>
                    {expanded.has(log.id) && log.metadata && (
                      <tr key={`${log.id}-detail`} className="bg-gray-50">
                        <td colSpan={5} className="px-8 py-3">
                          <pre className="text-xs text-gray-600 overflow-auto max-h-40 bg-white border rounded p-3">
                            {JSON.stringify(log.metadata, null, 2)}
                          </pre>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between">
        <button
          onClick={() => setPage((p) => Math.max(1, p - 1))}
          disabled={page === 1}
          className="px-4 py-2 text-sm border rounded-lg disabled:opacity-40 hover:bg-gray-50"
        >
          {t("pagination.previous")}
        </button>
        <span className="text-sm text-gray-500">
          {t("pagination.pageOf", { page, totalPages })}
        </span>
        <button
          onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
          disabled={page === totalPages}
          className="px-4 py-2 text-sm border rounded-lg disabled:opacity-40 hover:bg-gray-50"
        >
          {t("pagination.next")}
        </button>
      </div>
    </div>
  );
}
