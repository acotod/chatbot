"use client";

import Link from "next/link";
import { portalApi } from "@/lib/api";
import { useQuery } from "@tanstack/react-query";
import { Card } from "@/components/ui/Card";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { formatDate } from "@/lib/utils";

interface Solicitud {
  id: number;
  nombre?: string;
  titulo?: string;
  estado: string;
  prioridad?: string;
  createdAt: string;
}

export default function PortalSolicitudesPage({ params }: { params: { token: string } }) {
  const token = params.token;

  const { data, isLoading, error } = useQuery({
    queryKey: ["portal-solicitudes", token],
    queryFn: () => portalApi.list(token).then((r) => r.data),
    enabled: !!token,
  });

  const solicitudes: Solicitud[] = data?.data ?? [];

  return (
    <Card>
      {isLoading ? (
        <div className="py-12 text-center text-sm text-slate-500">Cargando solicitudes...</div>
      ) : error ? (
        <div className="py-12 text-center text-sm text-rose-600">No se pudo cargar el portal. Revisa que el enlace sea válido.</div>
      ) : solicitudes.length === 0 ? (
        <div className="py-12 text-center text-sm text-slate-500">No hay solicitudes disponibles.</div>
      ) : (
        <div className="divide-y divide-slate-100">
          {solicitudes.map((s) => (
            <div key={s.id} className="p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <div>
                <p className="font-medium text-slate-900">{s.titulo || s.nombre || `Solicitud #${s.id}`}</p>
                <p className="text-xs text-slate-500 mt-1">Creada: {formatDate(s.createdAt)}</p>
              </div>
              <div className="flex items-center gap-3">
                <StatusBadge status={s.estado} />
                <Link
                  href={`/portal/${encodeURIComponent(token)}/solicitudes/${s.id}`}
                  className="text-sm text-blue-600 hover:text-blue-700 font-medium"
                >
                  Ver detalle
                </Link>
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
