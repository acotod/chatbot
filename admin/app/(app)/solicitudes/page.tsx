"use client";

import { agentesApi, solicitudesApi } from "@/lib/api";
import { useAuthStore } from "@/store/auth";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Modal } from "@/components/ui/Modal";
import { formatDate } from "@/lib/utils";
import { Filter, UserCheck } from "lucide-react";
import { useSocket } from "@/hooks/useSocket";

const ESTADOS = ["", "open", "in_progress", "pending_info", "completed", "rejected"];

const ESTADO_LABELS: Record<string, string> = {
  open: "Abierta",
  in_progress: "En progreso",
  pending_info: "Pendiente info",
  completed: "Completada",
  rejected: "Rechazada",
};

interface Solicitud {
  id: number;
  nombre: string;
  telefonoContacto: string;
  horario: string;
  estado: string;
  createdAt: string;
  agente?: { nombre: string } | null;
}

interface Agente {
  id: number;
  nombre: string;
  estado: string;
}

export default function SolicitudesPage() {
  const { tenantSlug } = useAuthStore();
  const qc = useQueryClient();

  const [estadoFilter, setEstadoFilter] = useState("");
  const [page, setPage] = useState(1);
  const [assignModal, setAssignModal] = useState<{
    open: boolean;
    solicitudId: number | null;
  }>({ open: false, solicitudId: null });
  const [selectedAgente, setSelectedAgente] = useState("");

  const { data, isLoading } = useQuery({
    queryKey: ["solicitudes", tenantSlug, { estado: estadoFilter, page }],
    queryFn: () =>
      solicitudesApi
        .list(tenantSlug, { estado: estadoFilter || undefined, page, limit: 15 })
        .then((r) => r.data),
    enabled: !!tenantSlug,
  });

  // Real-time: refetch on STATUS_UPDATED or AGENT_ASSIGNED from this tenant
  useSocket(tenantSlug || null, "STATUS_UPDATED", () => {
    qc.invalidateQueries({ queryKey: ["solicitudes"] });
  });
  useSocket(tenantSlug || null, "AGENT_ASSIGNED", () => {
    qc.invalidateQueries({ queryKey: ["solicitudes"] });
  });

  const { data: agentesData } = useQuery({
    queryKey: ["agentes", tenantSlug],
    queryFn: () => agentesApi.list(tenantSlug).then((r) => r.data),
    enabled: !!tenantSlug,
  });

  const updateEstado = useMutation({
    mutationFn: ({
      id,
      estado,
    }: {
      id: number;
      estado: string;
    }) => solicitudesApi.updateEstado(tenantSlug, id, estado),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["solicitudes"] }),
  });

  const assignAgente = useMutation({
    mutationFn: ({
      id,
      agenteId,
    }: {
      id: number;
      agenteId: number;
    }) => solicitudesApi.assignAgente(tenantSlug, id, agenteId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["solicitudes"] });
      setAssignModal({ open: false, solicitudId: null });
    },
  });

  const solicitudes: Solicitud[] = data?.data ?? [];
  const total: number = data?.total ?? 0;
  const agentes: Agente[] = agentesData?.data ?? agentesData ?? [];

  function handleAssign() {
    if (!assignModal.solicitudId || !selectedAgente) return;
    assignAgente.mutate({
      id: assignModal.solicitudId,
      agenteId: parseInt(selectedAgente),
    });
  }

  return (
    <div className="space-y-5">
      {/* Filters */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-2 bg-white border border-slate-200 rounded-xl px-3 py-2">
          <Filter size={16} className="text-slate-400" />
          <select
            value={estadoFilter}
            onChange={(e) => {
              setEstadoFilter(e.target.value);
              setPage(1);
            }}
            className="text-sm bg-transparent focus:outline-none text-slate-700"
          >
            {ESTADOS.map((e) => (
              <option key={e} value={e}>
                {e === "" ? "Todos los estados" : ESTADO_LABELS[e] ?? e}
              </option>
            ))}
          </select>
        </div>
        <span className="text-sm text-slate-500 ml-auto">
          {total} solicitudes
        </span>
      </div>

      <Card>
        {isLoading ? (
          <div className="py-16 text-center text-slate-400 text-sm">
            Cargando solicitudes...
          </div>
        ) : solicitudes.length === 0 ? (
          <div className="py-16 text-center">
            <p className="text-slate-400 text-sm">No hay solicitudes con ese filtro</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 border-b border-slate-200">
                <tr>
                  {["Nombre", "Teléfono", "Horario", "Agente", "Estado", "Fecha", "Acciones"].map(
                    (h) => (
                      <th
                        key={h}
                        className="text-left px-5 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide"
                      >
                        {h}
                      </th>
                    )
                  )}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {solicitudes.map((s) => (
                  <tr key={s.id} className="hover:bg-slate-50/60 transition group">
                    <td className="px-5 py-3.5 font-medium text-slate-900">
                      {s.nombre}
                    </td>
                    <td className="px-5 py-3.5 text-slate-600">
                      {s.telefonoContacto}
                    </td>
                    <td className="px-5 py-3.5 text-slate-600">{s.horario}</td>
                    <td className="px-5 py-3.5 text-slate-600">
                      {s.agente?.nombre ?? (
                        <span className="text-slate-400 italic">Sin asignar</span>
                      )}
                    </td>
                    <td className="px-5 py-3.5">
                      <StatusBadge status={s.estado} />
                    </td>
                    <td className="px-5 py-3.5 text-slate-500 text-xs">
                      {formatDate(s.createdAt)}
                    </td>
                    <td className="px-5 py-3.5">
                      <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition">
                        {/* Quick estado changes */}
                        {s.estado === "open" && (
                          <button
                            onClick={() =>
                              updateEstado.mutate({ id: s.id, estado: "completed" })
                            }
                            className="text-xs text-green-600 hover:text-green-700 font-medium border border-green-200 rounded-lg px-2 py-1 bg-green-50 hover:bg-green-100 transition"
                          >
                            Marcar completada
                          </button>
                        )}
                        <button
                          onClick={() => {
                            setAssignModal({ open: true, solicitudId: s.id });
                            setSelectedAgente("");
                          }}
                          className="text-xs text-blue-600 hover:text-blue-700 font-medium border border-blue-200 rounded-lg px-2 py-1 bg-blue-50 hover:bg-blue-100 transition flex items-center gap-1"
                        >
                          <UserCheck size={12} />
                          Asignar
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Pagination */}
        {total > 15 && (
          <div className="flex items-center justify-between px-5 py-4 border-t border-slate-100">
            <Button
              variant="secondary"
              size="sm"
              disabled={page === 1}
              onClick={() => setPage((p) => p - 1)}
            >
              ← Anterior
            </Button>
            <span className="text-sm text-slate-500">
              Página {page} de {Math.ceil(total / 15)}
            </span>
            <Button
              variant="secondary"
              size="sm"
              disabled={page * 15 >= total}
              onClick={() => setPage((p) => p + 1)}
            >
              Siguiente →
            </Button>
          </div>
        )}
      </Card>

      {/* Assign modal */}
      <Modal
        open={assignModal.open}
        onClose={() => setAssignModal({ open: false, solicitudId: null })}
        title="Asignar agente"
      >
        <div className="space-y-4">
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-slate-700">
              Seleccioná un agente disponible
            </label>
            <select
              value={selectedAgente}
              onChange={(e) => setSelectedAgente(e.target.value)}
              className="px-3.5 py-2.5 rounded-xl border border-slate-200 bg-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/30"
            >
              <option value="">— Elegir agente —</option>
              {agentes
                .filter((a) => a.estado === "activo")
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.nombre}
                  </option>
                ))}
            </select>
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <Button
              variant="secondary"
              onClick={() => setAssignModal({ open: false, solicitudId: null })}
            >
              Cancelar
            </Button>
            <Button
              onClick={handleAssign}
              disabled={!selectedAgente || assignAgente.isPending}
            >
              {assignAgente.isPending ? "Asignando..." : "Asignar 💙"}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
