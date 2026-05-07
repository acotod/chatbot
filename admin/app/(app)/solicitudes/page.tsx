"use client";

import { agentesApi, solicitudesApi } from "@/lib/api";
import { useAuthStore } from "@/store/auth";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Modal } from "@/components/ui/Modal";
import { formatDate } from "@/lib/utils";
import { AlertTriangle, Clock3, Filter, Search, UserCheck } from "lucide-react";
import { useSocket } from "@/hooks/useSocket";

const ESTADOS = ["", "open", "in_progress", "pending_info", "completed", "rejected"];
const PRIORIDADES = ["", "baja", "media", "alta"];
const SLA_FILTERS = ["", "on_track", "warning", "breached", "no_sla"];

const ESTADO_LABELS: Record<string, string> = {
  open: "Abierta",
  in_progress: "En progreso",
  pending_info: "Pendiente info",
  completed: "Completada",
  rejected: "Rechazada",
};

const SLA_LABELS: Record<string, string> = {
  on_track: "En SLA",
  warning: "Por vencer",
  breached: "Vencido",
  no_sla: "Sin SLA",
};

const PRIORIDAD_LABELS: Record<string, string> = {
  baja: "Baja",
  media: "Media",
  alta: "Alta",
};

interface Solicitud {
  id: number;
  nombre?: string;
  telefonoContacto?: string;
  horario?: string;
  estado: string;
  prioridad?: string;
  escalationLevel?: number;
  createdAt: string;
  slaStatus?: {
    status: string;
    minutesRemaining: number | null;
  };
  agente?: { nombre: string } | null;
}

interface Agente {
  id: number;
  nombre: string;
  estado: string;
}

interface SolicitudesTenantConfig {
  enterpriseEnabled: boolean;
  advancedSearchEnabled: boolean;
  slaEnabled: boolean;
  warningThresholdMinutes: number;
  manualEscalationEnabled: boolean;
  autoEscalationEnabled: boolean;
  escalationIntervalMinutes: number;
  assignmentRulesEnabled: boolean;
  customerPortalEnabled: boolean;
  webhooksEnabled: boolean;
}

const DEFAULT_SOLICITUDES_CONFIG: SolicitudesTenantConfig = {
  enterpriseEnabled: true,
  advancedSearchEnabled: true,
  slaEnabled: true,
  warningThresholdMinutes: 60,
  manualEscalationEnabled: true,
  autoEscalationEnabled: false,
  escalationIntervalMinutes: 30,
  assignmentRulesEnabled: true,
  customerPortalEnabled: false,
  webhooksEnabled: false,
};

export default function SolicitudesPage() {
  const { tenantSlug } = useAuthStore();
  const qc = useQueryClient();

  const [q, setQ] = useState("");
  const [estadoFilter, setEstadoFilter] = useState("");
  const [prioridadFilter, setPrioridadFilter] = useState("");
  const [slaFilter, setSlaFilter] = useState("");
  const [page, setPage] = useState(1);
  const [assignModal, setAssignModal] = useState<{
    open: boolean;
    solicitudId: number | null;
  }>({ open: false, solicitudId: null });
  const [selectedAgente, setSelectedAgente] = useState("");
  const [configOpen, setConfigOpen] = useState(false);
  const [configDraft, setConfigDraft] = useState<SolicitudesTenantConfig>(DEFAULT_SOLICITUDES_CONFIG);

  const { data: configData } = useQuery({
    queryKey: ["solicitudes-config", tenantSlug],
    queryFn: () => solicitudesApi.getConfig(tenantSlug).then((r) => r.data as SolicitudesTenantConfig),
    enabled: !!tenantSlug,
  });

  const tenantConfig = { ...DEFAULT_SOLICITUDES_CONFIG, ...(configData || {}) };

  useEffect(() => {
    setConfigDraft(tenantConfig);
  }, [
    tenantConfig.enterpriseEnabled,
    tenantConfig.advancedSearchEnabled,
    tenantConfig.slaEnabled,
    tenantConfig.warningThresholdMinutes,
    tenantConfig.manualEscalationEnabled,
    tenantConfig.autoEscalationEnabled,
    tenantConfig.escalationIntervalMinutes,
    tenantConfig.assignmentRulesEnabled,
    tenantConfig.customerPortalEnabled,
    tenantConfig.webhooksEnabled,
  ]);

  const usingAdvancedSearch = Boolean((q || prioridadFilter || slaFilter) && tenantConfig.advancedSearchEnabled);

  const { data, isLoading } = useQuery({
    queryKey: ["solicitudes", tenantSlug, { q, estado: estadoFilter, prioridad: prioridadFilter, slaStatus: slaFilter, page }],
    queryFn: () =>
      (usingAdvancedSearch
        ? solicitudesApi.search(tenantSlug, {
            q: q || undefined,
            estado: estadoFilter || undefined,
            prioridad: prioridadFilter || undefined,
            slaStatus: slaFilter || undefined,
            page,
            limit: 15,
          })
        : solicitudesApi.list(tenantSlug, { estado: estadoFilter || undefined, page, limit: 15 })
      ).then((r) => r.data),
    enabled: !!tenantSlug,
  });

  const { data: statsData } = useQuery({
    queryKey: ["solicitudes-stats", tenantSlug],
    queryFn: () => solicitudesApi.stats(tenantSlug).then((r) => r.data),
    enabled: !!tenantSlug,
  });

  // Real-time: refetch on STATUS_UPDATED or AGENT_ASSIGNED from this tenant
  useSocket(tenantSlug || null, "STATUS_UPDATED", () => {
    qc.invalidateQueries({ queryKey: ["solicitudes"] });
  });
  useSocket(tenantSlug || null, "AGENT_ASSIGNED", () => {
    qc.invalidateQueries({ queryKey: ["solicitudes"] });
  });
  useSocket(tenantSlug || null, "SOLICITUD_ESCALATED", () => {
    qc.invalidateQueries({ queryKey: ["solicitudes"] });
    qc.invalidateQueries({ queryKey: ["solicitudes-stats"] });
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

  const escalateSolicitud = useMutation({
    mutationFn: (id: number) => solicitudesApi.escalate(tenantSlug, id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["solicitudes"] });
      qc.invalidateQueries({ queryKey: ["solicitudes-stats"] });
    },
  });

  const updateConfig = useMutation({
    mutationFn: (payload: SolicitudesTenantConfig) => solicitudesApi.updateConfig(tenantSlug, payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["solicitudes-config", tenantSlug] });
      qc.invalidateQueries({ queryKey: ["solicitudes"] });
      qc.invalidateQueries({ queryKey: ["solicitudes-stats"] });
      setConfigOpen(false);
    },
  });

  const solicitudes: Solicitud[] = data?.data ?? [];
  const total: number = data?.total ?? 0;
  const agentes: Agente[] = agentesData?.data ?? agentesData ?? [];
  const stats = statsData ?? { total: 0, estado: {}, sla: { onTrack: 0, warning: 0, breached: 0 } };

  function handleAssign() {
    if (!assignModal.solicitudId || !selectedAgente) return;
    assignAgente.mutate({
      id: assignModal.solicitudId,
      agenteId: parseInt(selectedAgente),
    });
  }

  return (
    <div className="space-y-5">
      <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 xl:grid-cols-4">
        <Card className="p-4">
          <p className="text-xs text-slate-500 uppercase tracking-wide">Total</p>
          <p className="text-2xl font-semibold text-slate-900 mt-1">{stats.total ?? 0}</p>
        </Card>
        <Card className="p-4">
          <div className="flex items-center justify-between">
            <p className="text-xs text-slate-500 uppercase tracking-wide">En SLA</p>
            <Clock3 size={14} className="text-emerald-500" />
          </div>
          <p className="text-2xl font-semibold text-emerald-700 mt-1">{tenantConfig.slaEnabled ? (stats.sla?.onTrack ?? 0) : 0}</p>
        </Card>
        <Card className="p-4">
          <div className="flex items-center justify-between">
            <p className="text-xs text-slate-500 uppercase tracking-wide">Por vencer</p>
            <Clock3 size={14} className="text-amber-500" />
          </div>
          <p className="text-2xl font-semibold text-amber-700 mt-1">{tenantConfig.slaEnabled ? (stats.sla?.warning ?? 0) : 0}</p>
        </Card>
        <Card className="p-4">
          <div className="flex items-center justify-between">
            <p className="text-xs text-slate-500 uppercase tracking-wide">SLA vencido</p>
            <AlertTriangle size={14} className="text-rose-500" />
          </div>
          <p className="text-2xl font-semibold text-rose-700 mt-1">{tenantConfig.slaEnabled ? (stats.sla?.breached ?? 0) : 0}</p>
        </Card>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-2 bg-white border border-slate-200 rounded-xl px-3 py-2 min-w-[260px]">
          <Search size={16} className="text-slate-400" />
          <input
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setPage(1);
            }}
            disabled={!tenantConfig.advancedSearchEnabled}
            placeholder="Buscar por nombre, teléfono o título"
            className="text-sm bg-transparent focus:outline-none text-slate-700 w-full"
          />
        </div>
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

        <div className="flex items-center gap-2 bg-white border border-slate-200 rounded-xl px-3 py-2">
          <select
            value={prioridadFilter}
            onChange={(e) => {
              setPrioridadFilter(e.target.value);
              setPage(1);
            }}
            disabled={!tenantConfig.advancedSearchEnabled}
            className="text-sm bg-transparent focus:outline-none text-slate-700"
          >
            {PRIORIDADES.map((p) => (
              <option key={p} value={p}>
                {p === "" ? "Todas las prioridades" : PRIORIDAD_LABELS[p] ?? p}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-2 bg-white border border-slate-200 rounded-xl px-3 py-2">
          <select
            value={slaFilter}
            onChange={(e) => {
              setSlaFilter(e.target.value);
              setPage(1);
            }}
            disabled={!tenantConfig.slaEnabled}
            className="text-sm bg-transparent focus:outline-none text-slate-700"
          >
            {SLA_FILTERS.map((s) => (
              <option key={s} value={s}>
                {s === "" ? "Todos los SLA" : SLA_LABELS[s] ?? s}
              </option>
            ))}
          </select>
        </div>

        <span className="text-sm text-slate-500 ml-auto">
          {total} solicitudes
        </span>
        <Button variant="secondary" size="sm" onClick={() => setConfigOpen(true)}>
          Configurar tenant
        </Button>
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
                  {["Nombre", "Teléfono", "Prioridad", "SLA", "Agente", "Estado", "Fecha", "Acciones"].map(
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
                      {s.nombre || "Sin nombre"}
                    </td>
                    <td className="px-5 py-3.5 text-slate-600">
                      {s.telefonoContacto || "-"}
                    </td>
                    <td className="px-5 py-3.5 text-slate-600">
                      {s.prioridad ? (PRIORIDAD_LABELS[s.prioridad] ?? s.prioridad) : "-"}
                    </td>
                    <td className="px-5 py-3.5">
                      <span
                        className={`inline-flex items-center px-2 py-1 rounded-md text-xs font-medium ${
                          s.slaStatus?.status === "breached"
                            ? "bg-rose-100 text-rose-700"
                            : s.slaStatus?.status === "warning"
                              ? "bg-amber-100 text-amber-700"
                              : s.slaStatus?.status === "on_track"
                                ? "bg-emerald-100 text-emerald-700"
                                : "bg-slate-100 text-slate-600"
                        }`}
                      >
                        {SLA_LABELS[s.slaStatus?.status || "no_sla"] || "Sin SLA"}
                      </span>
                    </td>
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
                              updateEstado.mutate({ id: s.id, estado: "in_progress" })
                            }
                            className="text-xs text-blue-600 hover:text-blue-700 font-medium border border-blue-200 rounded-lg px-2 py-1 bg-blue-50 hover:bg-blue-100 transition"
                          >
                            Tomar
                          </button>
                        )}
                        {tenantConfig.manualEscalationEnabled && (
                          <button
                            onClick={() => escalateSolicitud.mutate(s.id)}
                            disabled={escalateSolicitud.isPending}
                            className="text-xs text-rose-600 hover:text-rose-700 font-medium border border-rose-200 rounded-lg px-2 py-1 bg-rose-50 hover:bg-rose-100 transition"
                          >
                            Escalar
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
              {assignAgente.isPending ? "Asignando..." : "Asignar"}
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        open={configOpen}
        onClose={() => setConfigOpen(false)}
        title="Configuración enterprise por tenant"
      >
        <div className="space-y-3">
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={configDraft.advancedSearchEnabled}
              onChange={(e) => setConfigDraft((prev) => ({ ...prev, advancedSearchEnabled: e.target.checked }))}
            />
            Búsqueda avanzada
          </label>
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={configDraft.slaEnabled}
              onChange={(e) => setConfigDraft((prev) => ({ ...prev, slaEnabled: e.target.checked }))}
            />
            SLA habilitado
          </label>
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={configDraft.manualEscalationEnabled}
              onChange={(e) => setConfigDraft((prev) => ({ ...prev, manualEscalationEnabled: e.target.checked }))}
            />
            Escalación manual
          </label>
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={configDraft.assignmentRulesEnabled}
              onChange={(e) => setConfigDraft((prev) => ({ ...prev, assignmentRulesEnabled: e.target.checked }))}
            />
            Reglas de asignación
          </label>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs text-slate-500 uppercase tracking-wide">Umbral warning SLA (min)</label>
              <input
                type="number"
                min={5}
                max={1440}
                value={configDraft.warningThresholdMinutes}
                onChange={(e) => setConfigDraft((prev) => ({ ...prev, warningThresholdMinutes: Number(e.target.value || 60) }))}
                className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-slate-500 uppercase tracking-wide">Intervalo auto-escalación (min)</label>
              <input
                type="number"
                min={5}
                max={1440}
                value={configDraft.escalationIntervalMinutes}
                onChange={(e) => setConfigDraft((prev) => ({ ...prev, escalationIntervalMinutes: Number(e.target.value || 30) }))}
                className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm"
              />
            </div>
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <Button variant="secondary" onClick={() => setConfigOpen(false)}>
              Cancelar
            </Button>
            <Button
              onClick={() => updateConfig.mutate(configDraft)}
              disabled={updateConfig.isPending}
            >
              {updateConfig.isPending ? "Guardando..." : "Guardar configuración"}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
