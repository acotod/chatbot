"use client";

import { agentesApi, conversationsApi, solicitudesApi } from "@/lib/api";
import { agentAuthApi, type AgentSolicitud } from "@/lib/agentApi";
import { useAuthStore } from "@/store/auth";
import { getStoredAccessToken } from "@/store/auth";
import { getStoredAgentAccessToken } from "@/store/agentAuth";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Modal } from "@/components/ui/Modal";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatDate } from "@/lib/utils";
import { AlertTriangle, Clock3, Filter, MessageCircleMore, Search, UserCheck } from "lucide-react";
import { useSocket } from "@/hooks/useSocket";

const ESTADOS = ["", "open", "in_progress", "pending_info", "completed", "rejected"];
const PRIORIDADES = ["", "baja", "media", "alta"];
const CATEGORIAS = ["", "tecnico", "facturacion", "comercial", "soporte", "otro"];
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

const CATEGORIA_LABELS: Record<string, string> = {
  tecnico: "Tecnico",
  facturacion: "Facturacion",
  comercial: "Comercial",
  soporte: "Soporte",
  otro: "Otro",
};

interface Solicitud {
  id: number;
  titulo?: string | null;
  nombre?: string;
  telefonoContacto?: string;
  horario?: string;
  estado: string;
  prioridad?: string;
  categoria?: string | null;
  subcategoria?: string | null;
  dueAt?: string | null;
  firstResponseAt?: string | null;
  escalationLevel?: number;
  createdAt: string;
  conversation?: { id: string } | null;
  user?: { phone?: string | null } | null;
  slaStatus?: {
    status: string;
    minutesRemaining: number | null;
  };
  agente?: { id?: number; nombre: string } | null;
}

interface ConversationItem {
  id: string;
  userKey: string;
  status: string;
  startedAt: string;
  endedAt: string | null;
  flow?: { nombre: string } | null;
  solicitudes?: Array<{ id: number; estado: string; createdAt: string }>;
}

interface ConversationEventItem {
  id: string;
  nodeRef: string | null;
  eventType: string;
  payload: unknown;
  createdAt: string;
}

interface ConversationDetail {
  id: string;
  userKey: string;
  status: string;
  startedAt: string;
  endedAt: string | null;
  flow?: { id: number; nombre: string } | null;
  events?: ConversationEventItem[];
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
  const hasAccessToken = Boolean(getStoredAccessToken());
  const hasAgentAccessToken = Boolean(getStoredAgentAccessToken());
  const isAgentSession = hasAgentAccessToken && !hasAccessToken;

  const [agentStatusFilter, setAgentStatusFilter] = useState<"assigned" | "completed">("assigned");

  const { data: agentSolicitudes, isLoading: isAgentSolicitudesLoading } = useQuery({
    queryKey: ["agent-solicitudes", agentStatusFilter],
    queryFn: () => agentAuthApi.solicitudes({ status: agentStatusFilter, page: 1, limit: 50 }).then((r) => r.data),
    enabled: isAgentSession,
  });

  const [q, setQ] = useState("");
  const [estadoFilter, setEstadoFilter] = useState("");
  const [prioridadFilter, setPrioridadFilter] = useState("");
  const [categoriaFilter, setCategoriaFilter] = useState("");
  const [slaFilter, setSlaFilter] = useState("");
  const [page, setPage] = useState(1);
  const [assignModal, setAssignModal] = useState<{
    open: boolean;
    solicitudId: number | null;
  }>({ open: false, solicitudId: null });
  const [detailModal, setDetailModal] = useState<{
    open: boolean;
    solicitud: Solicitud | null;
  }>({ open: false, solicitud: null });
  const [detailTab, setDetailTab] = useState<"resumen" | "conversaciones">("resumen");
  const [detailDraft, setDetailDraft] = useState({
    estado: "",
    prioridad: "",
    agenteId: "",
    categoria: "",
    subcategoria: "",
    dueAt: "",
  });
  const [conversationDetailModal, setConversationDetailModal] = useState<{
    open: boolean;
    conversation: ConversationItem | null;
  }>({ open: false, conversation: null });
  const [selectedAgente, setSelectedAgente] = useState("");

  const { data: configData } = useQuery({
    queryKey: ["solicitudes-config", tenantSlug],
    queryFn: () => solicitudesApi.getConfig(tenantSlug).then((r) => r.data as SolicitudesTenantConfig),
    enabled: !!tenantSlug,
  });

  const tenantConfig = { ...DEFAULT_SOLICITUDES_CONFIG, ...(configData || {}) };

  const usingAdvancedSearch = Boolean((q || prioridadFilter || slaFilter) && tenantConfig.advancedSearchEnabled);

  const { data, isLoading } = useQuery({
    queryKey: ["solicitudes", tenantSlug, { q, estado: estadoFilter, prioridad: prioridadFilter, categoria: categoriaFilter, slaStatus: slaFilter, page }],
    queryFn: () =>
      (usingAdvancedSearch
        ? solicitudesApi.search(tenantSlug, {
            q: q || undefined,
            estado: estadoFilter || undefined,
            prioridad: prioridadFilter || undefined,
            categoria: categoriaFilter || undefined,
            slaStatus: slaFilter || undefined,
            page,
            limit: 15,
          })
        : solicitudesApi.list(tenantSlug, { estado: estadoFilter || undefined, categoria: categoriaFilter || undefined, page, limit: 15 })
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

  const createPortalToken = useMutation({
    mutationFn: (id: number) => solicitudesApi.createPortalToken(tenantSlug, id),
  });

  const saveSolicitud = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Record<string, unknown> }) =>
      solicitudesApi.update(tenantSlug, id, data),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["solicitudes"] });
      await qc.invalidateQueries({ queryKey: ["solicitudes-stats"] });
      setDetailModal((prev) => ({
        ...prev,
        solicitud: prev.solicitud
          ? {
              ...prev.solicitud,
              estado: detailDraft.estado || prev.solicitud.estado,
              prioridad: detailDraft.prioridad || prev.solicitud.prioridad,
              categoria: detailDraft.categoria || null,
              subcategoria: detailDraft.subcategoria || null,
              dueAt: detailDraft.dueAt ? new Date(detailDraft.dueAt).toISOString() : null,
              agente: detailDraft.agenteId
                ? {
                    id: Number(detailDraft.agenteId),
                    nombre: prev.solicitud.agente?.nombre ?? "Asignado",
                  }
                : null,
            }
          : prev.solicitud,
      }));
    },
  });

  const updateAgentSolicitud = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Record<string, unknown> }) =>
      agentAuthApi.updateSolicitud(id, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["agent-solicitudes"] });
    },
  });

  useEffect(() => {
    if (!detailModal.solicitud) return;
    setDetailDraft({
      estado: detailModal.solicitud.estado || "",
      prioridad: detailModal.solicitud.prioridad || "",
      agenteId: detailModal.solicitud.agente?.id ? String(detailModal.solicitud.agente.id) : "",
      categoria: detailModal.solicitud.categoria || "",
      subcategoria: detailModal.solicitud.subcategoria || "",
      dueAt: detailModal.solicitud.dueAt ? String(detailModal.solicitud.dueAt).slice(0, 16) : "",
    });
  }, [
    detailModal.solicitud?.id,
    detailModal.solicitud?.estado,
    detailModal.solicitud?.prioridad,
    detailModal.solicitud?.agente?.id,
    detailModal.solicitud?.categoria,
    detailModal.solicitud?.subcategoria,
    detailModal.solicitud?.dueAt,
  ]);

  const detailClientKey = detailModal.solicitud?.user?.phone ?? detailModal.solicitud?.telefonoContacto ?? "";
  const { data: conversationData, isLoading: conversationsLoading } = useQuery({
    queryKey: ["solicitud-conversations", isAgentSession ? "agent" : tenantSlug, detailClientKey],
    queryFn: () =>
      isAgentSession
        ? agentAuthApi.conversations({ userKey: detailClientKey, limit: 50 }).then((r) => r.data)
        : conversationsApi.list({ tenantSlug: tenantSlug || undefined, userKey: detailClientKey, limit: 50 }).then((r) => r.data),
    enabled: Boolean(detailModal.open && detailModal.solicitud && detailClientKey && detailTab === "conversaciones"),
    staleTime: 30_000,
  });
  const conversations: ConversationItem[] = (conversationData as { data?: ConversationItem[] })?.data ?? (Array.isArray(conversationData) ? conversationData : []);
  const selectedConversationId = conversationDetailModal.conversation?.id ?? "";
  const { data: conversationDetailData, isLoading: conversationDetailLoading } = useQuery({
    queryKey: ["solicitud-conversation-detail", tenantSlug, selectedConversationId],
    queryFn: () =>
      conversationsApi
        .getById(selectedConversationId, { tenantSlug: tenantSlug || undefined })
        .then((r) => r.data as ConversationDetail),
    enabled: Boolean(conversationDetailModal.open && selectedConversationId && !isAgentSession),
    staleTime: 30_000,
  });
  const conversationEvents: ConversationEventItem[] =
    (conversationDetailData?.events as ConversationEventItem[] | undefined) ?? [];

  function formatEventPayload(payload: unknown): string {
    if (payload == null) return "Sin payload";
    if (typeof payload === "string") return payload;
    try {
      return JSON.stringify(payload, null, 2);
    } catch {
      return "Payload no serializable";
    }
  }

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

  if (isAgentSession) {
    const rows: AgentSolicitud[] = agentSolicitudes?.data ?? [];
    const agentTotal = Number(agentSolicitudes?.total ?? 0);
    const heading = agentStatusFilter === "assigned" ? "Solicitudes asignadas" : "Solicitudes finalizadas";

    return (
      <div className="space-y-5">
        <div className="rounded-2xl border border-slate-200 bg-white p-5">
          <h1 className="text-xl font-semibold text-slate-900">{heading}</h1>
          <p className="mt-1 text-sm text-slate-600">Vista del agente sobre sus solicitudes.</p>
          <div className="mt-4 inline-flex rounded-xl border border-slate-200 bg-slate-50 p-1">
            <button
              type="button"
              onClick={() => setAgentStatusFilter("assigned")}
              className={`px-3 py-1.5 text-sm rounded-lg ${agentStatusFilter === "assigned" ? "bg-white text-slate-900 shadow-sm" : "text-slate-600"}`}
            >
              Asignadas
            </button>
            <button
              type="button"
              onClick={() => setAgentStatusFilter("completed")}
              className={`px-3 py-1.5 text-sm rounded-lg ${agentStatusFilter === "completed" ? "bg-white text-slate-900 shadow-sm" : "text-slate-600"}`}
            >
              Finalizadas
            </button>
          </div>
          <p className="mt-3 text-sm text-slate-500">{agentTotal} resultados</p>
        </div>

        <Card>
          {isAgentSolicitudesLoading ? (
            <div className="py-16 text-center text-slate-400 text-sm">Cargando solicitudes...</div>
          ) : rows.length === 0 ? (
            <div className="py-16 text-center text-slate-400 text-sm">No hay solicitudes para este filtro.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-50 text-slate-600">
                  <tr>
                    <th className="px-4 py-3 text-left font-medium">ID</th>
                    <th className="px-4 py-3 text-left font-medium">Titulo</th>
                    <th className="px-4 py-3 text-left font-medium">Contacto</th>
                    <th className="px-4 py-3 text-left font-medium">Categoria</th>
                    <th className="px-4 py-3 text-left font-medium">Estado</th>
                    <th className="px-4 py-3 text-left font-medium">Prioridad</th>
                    <th className="px-4 py-3 text-left font-medium">Vence</th>
                    <th className="px-4 py-3 text-left font-medium">Actualizada</th>
                    <th className="px-4 py-3 text-left font-medium">Acciones</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((s) => (
                    <tr key={s.id} className="border-t border-slate-100">
                      <td className="px-4 py-3 text-slate-700">#{s.id}</td>
                      <td className="px-4 py-3 text-slate-700">{s.titulo || s.nombre || "Sin titulo"}</td>
                      <td className="px-4 py-3 text-slate-600">{s.nombre || s.telefonoContacto || "-"}</td>
                      <td className="px-4 py-3 text-slate-700">{CATEGORIA_LABELS[s.categoria || ""] ?? s.categoria ?? "-"}</td>
                      <td className="px-4 py-3 text-slate-700">{ESTADO_LABELS[s.estado || ""] ?? s.estado ?? "-"}</td>
                      <td className="px-4 py-3 text-slate-700">{PRIORIDAD_LABELS[s.prioridad || ""] ?? s.prioridad ?? "-"}</td>
                      <td className="px-4 py-3 text-slate-500">{s.dueAt ? formatDate(s.dueAt) : "-"}</td>
                      <td className="px-4 py-3 text-slate-500">{formatDate(s.updatedAt)}</td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          {s.estado === "open" && (
                            <button
                              type="button"
                              onClick={() => updateAgentSolicitud.mutate({ id: s.id, data: { estado: "in_progress" } })}
                              className="rounded-lg border border-blue-200 bg-blue-50 px-2 py-1 text-xs font-medium text-blue-700"
                            >
                              Tomar
                            </button>
                          )}
                          {s.estado !== "completed" && s.estado !== "rejected" && (
                            <button
                              type="button"
                              onClick={() => updateAgentSolicitud.mutate({ id: s.id, data: { estado: "completed" } })}
                              className="rounded-lg border border-emerald-200 bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-700"
                            >
                              Completar
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => {
                              setDetailModal({
                                open: true,
                                solicitud: {
                                  id: s.id,
                                  titulo: s.titulo,
                                  nombre: s.nombre ?? undefined,
                                  telefonoContacto: s.telefonoContacto ?? undefined,
                                  estado: s.estado ?? "open",
                                  prioridad: s.prioridad ?? undefined,
                                  categoria: s.categoria ?? undefined,
                                  subcategoria: s.subcategoria ?? undefined,
                                  dueAt: s.dueAt,
                                  firstResponseAt: s.firstResponseAt,
                                  createdAt: s.createdAt,
                                  conversation: s.conversation ? { id: s.conversation.id } : null,
                                  user: s.user ? { phone: s.user.phone } : null,
                                  agente: null,
                                },
                              });
                              setDetailTab("resumen");
                            }}
                            className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs font-medium text-slate-700"
                          >
                            Conversaciones
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Modal
          open={detailModal.open}
          onClose={() => setDetailModal({ open: false, solicitud: null })}
          title="Detalle de solicitud"
          className="max-w-4xl"
        >
          {detailModal.solicitud && (
            <Tabs value={detailTab} className="space-y-4">
              <TabsList className="w-full justify-start overflow-x-auto">
                <TabsTrigger value="resumen" onClick={() => setDetailTab("resumen")}>Resumen</TabsTrigger>
                <TabsTrigger value="conversaciones" onClick={() => setDetailTab("conversaciones")}>Conversaciones del cliente</TabsTrigger>
              </TabsList>

              <TabsContent value="resumen" className="space-y-4">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                    <p className="text-xs uppercase tracking-wide text-slate-500">Cliente</p>
                    <p className="mt-1 font-medium text-slate-900">{detailModal.solicitud.nombre || "Sin nombre"}</p>
                    <p className="text-sm text-slate-600">{detailModal.solicitud.telefonoContacto || "Sin teléfono"}</p>
                  </div>
                  <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                    <p className="text-xs uppercase tracking-wide text-slate-500">Estado</p>
                    <div className="mt-1"><StatusBadge status={detailModal.solicitud.estado} /></div>
                    <p className="text-sm text-slate-600 mt-2">Creada: {formatDate(detailModal.solicitud.createdAt)}</p>
                  </div>
                  <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                    <p className="text-xs uppercase tracking-wide text-slate-500">Agente</p>
                    <p className="mt-1 text-sm text-slate-700">{detailModal.solicitud.agente?.nombre ?? "Sin asignar"}</p>
                  </div>
                  <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                    <p className="text-xs uppercase tracking-wide text-slate-500">Conexión</p>
                    <p className="mt-1 text-sm text-slate-700">{detailClientKey || "Sin identificador de cliente"}</p>
                  </div>
                  <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                    <p className="text-xs uppercase tracking-wide text-slate-500">Vencimiento</p>
                    <p className="mt-1 text-sm text-slate-700">{detailModal.solicitud.dueAt ? formatDate(detailModal.solicitud.dueAt) : "Sin fecha"}</p>
                  </div>
                  <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                    <p className="text-xs uppercase tracking-wide text-slate-500">Primera respuesta</p>
                    <p className="mt-1 text-sm text-slate-700">{detailModal.solicitud.firstResponseAt ? formatDate(detailModal.solicitud.firstResponseAt) : "Pendiente"}</p>
                  </div>
                </div>
                <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-3">
                  <p className="text-sm font-medium text-slate-900">Gestionar solicitud</p>
                  <div className="grid gap-3 sm:grid-cols-3">
                    <div className="space-y-1.5">
                      <label className="text-xs font-medium uppercase tracking-wide text-slate-500">Estado</label>
                      <select
                        value={detailDraft.estado}
                        onChange={(e) => setDetailDraft((prev) => ({ ...prev, estado: e.target.value }))}
                        className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
                      >
                        {ESTADOS.filter(Boolean).map((estado) => (
                          <option key={estado} value={estado}>
                            {ESTADO_LABELS[estado] ?? estado}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-xs font-medium uppercase tracking-wide text-slate-500">Prioridad</label>
                      <select
                        value={detailDraft.prioridad}
                        onChange={(e) => setDetailDraft((prev) => ({ ...prev, prioridad: e.target.value }))}
                        className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
                      >
                        {PRIORIDADES.filter(Boolean).map((prioridad) => (
                          <option key={prioridad} value={prioridad}>
                            {PRIORIDAD_LABELS[prioridad] ?? prioridad}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-xs font-medium uppercase tracking-wide text-slate-500">Agente</label>
                      <select
                        value={detailDraft.agenteId}
                        disabled
                        className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-500"
                      >
                        <option value="">{detailModal.solicitud.agente?.nombre ?? "Asignado automáticamente"}</option>
                      </select>
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-xs font-medium uppercase tracking-wide text-slate-500">Categoria</label>
                      <select
                        value={detailDraft.categoria}
                        onChange={(e) => setDetailDraft((prev) => ({ ...prev, categoria: e.target.value }))}
                        className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
                      >
                        <option value="">Sin categoria</option>
                        {CATEGORIAS.filter(Boolean).map((categoria) => (
                          <option key={categoria} value={categoria}>
                            {CATEGORIA_LABELS[categoria] ?? categoria}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-xs font-medium uppercase tracking-wide text-slate-500">Subcategoria</label>
                      <input
                        value={detailDraft.subcategoria}
                        onChange={(e) => setDetailDraft((prev) => ({ ...prev, subcategoria: e.target.value }))}
                        placeholder="Ej: integracion-whatsapp"
                        className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-xs font-medium uppercase tracking-wide text-slate-500">Fecha limite</label>
                      <input
                        type="datetime-local"
                        value={detailDraft.dueAt}
                        onChange={(e) => setDetailDraft((prev) => ({ ...prev, dueAt: e.target.value }))}
                        className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
                      />
                    </div>
                  </div>
                  <div className="flex justify-end gap-3 pt-1">
                    <Button
                      variant="secondary"
                      onClick={() => setDetailModal({ open: false, solicitud: null })}
                    >
                      Cerrar
                    </Button>
                    <Button
                      onClick={() => {
                        if (!detailModal.solicitud) return;
                        updateAgentSolicitud.mutate({
                          id: detailModal.solicitud.id,
                          data: {
                            estado: detailDraft.estado,
                            prioridad: detailDraft.prioridad || null,
                            categoria: detailDraft.categoria || null,
                            subcategoria: detailDraft.subcategoria || null,
                            dueAt: detailDraft.dueAt ? new Date(detailDraft.dueAt).toISOString() : null,
                          },
                        });
                      }}
                      disabled={updateAgentSolicitud.isPending}
                    >
                      {updateAgentSolicitud.isPending ? "Guardando..." : "Guardar cambios"}
                    </Button>
                  </div>
                </div>
                <div className="flex justify-end gap-3 pt-2">
                  <Button variant="secondary" onClick={() => setDetailModal({ open: false, solicitud: null })}>
                    Cerrar
                  </Button>
                  <Button onClick={() => setDetailTab("conversaciones")}>
                    Ver conversaciones del cliente
                  </Button>
                </div>
              </TabsContent>

              <TabsContent value="conversaciones" className="space-y-4">
                {!detailClientKey ? (
                  <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 p-6 text-sm text-slate-500">
                    Esta solicitud no tiene teléfono de cliente para buscar conversaciones del tenant.
                  </div>
                ) : conversationsLoading ? (
                  <div className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-500">
                    Cargando conversaciones del cliente...
                  </div>
                ) : conversations.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 p-6 text-sm text-slate-500">
                    No hay conversaciones registradas para este cliente en este tenant.
                  </div>
                ) : (
                  <div className="space-y-3 max-h-[55vh] overflow-auto pr-1">
                    {conversations.map((conversation) => {
                      const isCurrentConversation = detailModal.solicitud?.conversation?.id === conversation.id;
                      return (
                        <button
                          type="button"
                          onClick={() =>
                            setConversationDetailModal({
                              open: true,
                              conversation,
                            })
                          }
                          key={conversation.id}
                          className={`w-full text-left rounded-xl border p-4 transition hover:shadow-sm ${isCurrentConversation ? "border-blue-300 bg-blue-50/50" : "border-slate-200 bg-white"}`}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <div className="flex items-center gap-2 flex-wrap">
                                <p className="font-medium text-slate-900">{conversation.flow?.nombre ?? "Flujo sin nombre"}</p>
                                {isCurrentConversation && (
                                  <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[11px] font-semibold text-blue-700">
                                    Conversación actual
                                  </span>
                                )}
                              </div>
                              <p className="text-sm text-slate-500 mt-1">ID {conversation.id} · Estado {conversation.status}</p>
                              <p className="text-sm text-slate-500">
                                Inicio {formatDate(conversation.startedAt)}
                                {conversation.endedAt ? ` · Fin ${formatDate(conversation.endedAt)}` : ""}
                              </p>
                            </div>
                            <div className="text-right text-xs text-slate-500">
                              <p>{conversation.solicitudes?.length ?? 0} solicitud(es) vinculada(s)</p>
                              <p className="truncate max-w-[12rem]">{conversation.userKey}</p>
                            </div>
                          </div>
                          {conversation.solicitudes?.length ? (
                            <div className="mt-3 flex flex-wrap gap-2">
                              {conversation.solicitudes.map((solicitud) => (
                                <span
                                  key={solicitud.id}
                                  className="rounded-full bg-slate-100 px-2 py-1 text-[11px] font-medium text-slate-600"
                                >
                                  Solicitud #{solicitud.id} · {ESTADO_LABELS[solicitud.estado] ?? solicitud.estado}
                                </span>
                              ))}
                            </div>
                          ) : null}
                        </button>
                      );
                    })}
                  </div>
                )}
                <div className="flex justify-end gap-3 pt-2">
                  <Button variant="secondary" onClick={() => setDetailModal({ open: false, solicitud: null })}>
                    Cerrar
                  </Button>
                </div>
              </TabsContent>
            </Tabs>
          )}
        </Modal>

        <Modal
          open={conversationDetailModal.open}
          onClose={() => setConversationDetailModal({ open: false, conversation: null })}
          title="Detalle de conversación"
          className="max-w-3xl"
        >
          {conversationDetailModal.conversation && (
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                  <p className="text-xs uppercase tracking-wide text-slate-500">Flujo</p>
                  <p className="mt-1 font-medium text-slate-900">
                    {conversationDetailModal.conversation.flow?.nombre ?? "Flujo sin nombre"}
                  </p>
                </div>
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                  <p className="text-xs uppercase tracking-wide text-slate-500">Estado</p>
                  <p className="mt-1 text-sm text-slate-700">{conversationDetailModal.conversation.status}</p>
                </div>
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 sm:col-span-2">
                  <p className="text-xs uppercase tracking-wide text-slate-500">Identificador</p>
                  <p className="mt-1 text-sm text-slate-700 break-all">{conversationDetailModal.conversation.id}</p>
                  <p className="mt-1 text-sm text-slate-600">Cliente {conversationDetailModal.conversation.userKey}</p>
                </div>
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                  <p className="text-xs uppercase tracking-wide text-slate-500">Inicio</p>
                  <p className="mt-1 text-sm text-slate-700">{formatDate(conversationDetailModal.conversation.startedAt)}</p>
                </div>
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                  <p className="text-xs uppercase tracking-wide text-slate-500">Fin</p>
                  <p className="mt-1 text-sm text-slate-700">
                    {conversationDetailModal.conversation.endedAt
                      ? formatDate(conversationDetailModal.conversation.endedAt)
                      : "Activa / sin cierre"}
                  </p>
                </div>
              </div>

              {isAgentSession ? (
                <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 p-4 text-sm text-slate-500">
                  En sesión de agente solo se muestra el resumen. El detalle técnico de eventos está disponible en sesión de administrador.
                </div>
              ) : conversationDetailLoading ? (
                <div className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-500">
                  Cargando eventos de la conversación...
                </div>
              ) : conversationEvents.length === 0 ? (
                <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 p-4 text-sm text-slate-500">
                  Esta conversación no tiene eventos registrados.
                </div>
              ) : (
                <div className="space-y-2 max-h-[45vh] overflow-auto pr-1">
                  {conversationEvents.map((eventItem) => (
                    <div key={eventItem.id} className="rounded-xl border border-slate-200 bg-white p-3">
                      <div className="flex items-center justify-between gap-3">
                        <p className="text-sm font-medium text-slate-900">{eventItem.eventType}</p>
                        <p className="text-xs text-slate-500">{formatDate(eventItem.createdAt)}</p>
                      </div>
                      {eventItem.nodeRef ? (
                        <p className="mt-1 text-xs text-slate-500">Nodo: {eventItem.nodeRef}</p>
                      ) : null}
                      <pre className="mt-2 overflow-auto rounded-lg bg-slate-950/95 p-3 text-xs text-slate-100">
                        {formatEventPayload(eventItem.payload)}
                      </pre>
                    </div>
                  ))}
                </div>
              )}

              <div className="flex justify-end">
                <Button variant="secondary" onClick={() => setConversationDetailModal({ open: false, conversation: null })}>
                  Cerrar
                </Button>
              </div>
            </div>
          )}
        </Modal>
      </div>
    );
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
            value={categoriaFilter}
            onChange={(e) => {
              setCategoriaFilter(e.target.value);
              setPage(1);
            }}
            className="text-sm bg-transparent focus:outline-none text-slate-700"
          >
            {CATEGORIAS.map((c) => (
              <option key={c} value={c}>
                {c === "" ? "Todas las categorias" : CATEGORIA_LABELS[c] ?? c}
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
                  {["Nombre", "Telefono", "Categoria", "Prioridad", "SLA", "Agente", "Estado", "Vence", "Fecha", "Acciones"].map(
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
                      {s.categoria ? (CATEGORIA_LABELS[s.categoria] ?? s.categoria) : "-"}
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
                      {s.dueAt ? formatDate(s.dueAt) : "-"}
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
                        {tenantConfig.customerPortalEnabled && (
                          <button
                            onClick={async () => {
                              try {
                                const response = await createPortalToken.mutateAsync(s.id);
                                const url = response?.data?.url;
                                const path = response?.data?.path;
                                const target = url || (typeof window !== "undefined" ? `${window.location.origin}${path}` : path);
                                if (target && typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
                                  await navigator.clipboard.writeText(String(target));
                                  alert("Link de portal copiado");
                                }
                              } catch {
                                alert("No se pudo generar el link del portal");
                              }
                            }}
                            className="text-xs text-indigo-600 hover:text-indigo-700 font-medium border border-indigo-200 rounded-lg px-2 py-1 bg-indigo-50 hover:bg-indigo-100 transition"
                          >
                            Link portal
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
                        <button
                          onClick={() => {
                            setDetailModal({ open: true, solicitud: s });
                            setDetailTab("resumen");
                          }}
                          className="text-xs text-slate-700 hover:text-slate-900 font-medium border border-slate-200 rounded-lg px-2 py-1 bg-white hover:bg-slate-50 transition flex items-center gap-1"
                        >
                          <MessageCircleMore size={12} />
                          Conversaciones
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
        open={detailModal.open}
        onClose={() => setDetailModal({ open: false, solicitud: null })}
        title="Detalle de solicitud"
        className="max-w-4xl"
      >
        {detailModal.solicitud && (
          <Tabs value={detailTab} className="space-y-4">
            <TabsList className="w-full justify-start overflow-x-auto">
              <TabsTrigger value="resumen" onClick={() => setDetailTab("resumen")}>Resumen</TabsTrigger>
              <TabsTrigger value="conversaciones" onClick={() => setDetailTab("conversaciones")}>Conversaciones del cliente</TabsTrigger>
            </TabsList>

            <TabsContent value="resumen" className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                  <p className="text-xs uppercase tracking-wide text-slate-500">Cliente</p>
                  <p className="mt-1 font-medium text-slate-900">{detailModal.solicitud.nombre || "Sin nombre"}</p>
                  <p className="text-sm text-slate-600">{detailModal.solicitud.telefonoContacto || "Sin teléfono"}</p>
                </div>
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                  <p className="text-xs uppercase tracking-wide text-slate-500">Estado</p>
                  <div className="mt-1"><StatusBadge status={detailModal.solicitud.estado} /></div>
                  <p className="text-sm text-slate-600 mt-2">Creada: {formatDate(detailModal.solicitud.createdAt)}</p>
                </div>
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                  <p className="text-xs uppercase tracking-wide text-slate-500">Agente</p>
                  <p className="mt-1 text-sm text-slate-700">{detailModal.solicitud.agente?.nombre ?? "Sin asignar"}</p>
                </div>
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                  <p className="text-xs uppercase tracking-wide text-slate-500">Conexión</p>
                  <p className="mt-1 text-sm text-slate-700">{detailClientKey || "Sin identificador de cliente"}</p>
                </div>
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                  <p className="text-xs uppercase tracking-wide text-slate-500">Vencimiento</p>
                  <p className="mt-1 text-sm text-slate-700">{detailModal.solicitud.dueAt ? formatDate(detailModal.solicitud.dueAt) : "Sin fecha"}</p>
                </div>
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                  <p className="text-xs uppercase tracking-wide text-slate-500">Primera respuesta</p>
                  <p className="mt-1 text-sm text-slate-700">{detailModal.solicitud.firstResponseAt ? formatDate(detailModal.solicitud.firstResponseAt) : "Pendiente"}</p>
                </div>
              </div>
              <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-3">
                <p className="text-sm font-medium text-slate-900">Gestionar solicitud</p>
                <div className="grid gap-3 sm:grid-cols-3">
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium uppercase tracking-wide text-slate-500">Estado</label>
                    <select
                      value={detailDraft.estado}
                      onChange={(e) => setDetailDraft((prev) => ({ ...prev, estado: e.target.value }))}
                      className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
                    >
                      {ESTADOS.filter(Boolean).map((estado) => (
                        <option key={estado} value={estado}>
                          {ESTADO_LABELS[estado] ?? estado}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium uppercase tracking-wide text-slate-500">Prioridad</label>
                    <select
                      value={detailDraft.prioridad}
                      onChange={(e) => setDetailDraft((prev) => ({ ...prev, prioridad: e.target.value }))}
                      className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
                    >
                      {PRIORIDADES.filter(Boolean).map((prioridad) => (
                        <option key={prioridad} value={prioridad}>
                          {PRIORIDAD_LABELS[prioridad] ?? prioridad}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium uppercase tracking-wide text-slate-500">Agente</label>
                    <select
                      value={detailDraft.agenteId}
                      onChange={(e) => setDetailDraft((prev) => ({ ...prev, agenteId: e.target.value }))}
                      className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
                    >
                      <option value="">Sin asignar</option>
                      {agentes
                        .filter((a) => a.estado === "activo")
                        .map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.nombre}
                          </option>
                        ))}
                    </select>
                  </div>
                    <div className="space-y-1.5">
                      <label className="text-xs font-medium uppercase tracking-wide text-slate-500">Categoria</label>
                      <select
                        value={detailDraft.categoria}
                        onChange={(e) => setDetailDraft((prev) => ({ ...prev, categoria: e.target.value }))}
                        className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
                      >
                        <option value="">Sin categoria</option>
                        {CATEGORIAS.filter(Boolean).map((categoria) => (
                          <option key={categoria} value={categoria}>
                            {CATEGORIA_LABELS[categoria] ?? categoria}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-xs font-medium uppercase tracking-wide text-slate-500">Subcategoria</label>
                      <input
                        value={detailDraft.subcategoria}
                        onChange={(e) => setDetailDraft((prev) => ({ ...prev, subcategoria: e.target.value }))}
                        placeholder="Ej: integracion-whatsapp"
                        className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-xs font-medium uppercase tracking-wide text-slate-500">Fecha limite</label>
                      <input
                        type="datetime-local"
                        value={detailDraft.dueAt}
                        onChange={(e) => setDetailDraft((prev) => ({ ...prev, dueAt: e.target.value }))}
                        className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
                      />
                    </div>
                </div>
                <div className="flex justify-end gap-3 pt-1">
                  <Button
                    variant="secondary"
                    onClick={() => setDetailModal({ open: false, solicitud: null })}
                  >
                    Cerrar
                  </Button>
                  <Button
                    onClick={() => {
                      if (!detailModal.solicitud) return;
                      saveSolicitud.mutate({
                        id: detailModal.solicitud.id,
                        data: {
                          estado: detailDraft.estado,
                          prioridad: detailDraft.prioridad || null,
                          agenteId: detailDraft.agenteId ? Number(detailDraft.agenteId) : null,
                          categoria: detailDraft.categoria || null,
                          subcategoria: detailDraft.subcategoria || null,
                          dueAt: detailDraft.dueAt ? new Date(detailDraft.dueAt).toISOString() : null,
                        },
                      });
                    }}
                    disabled={saveSolicitud.isPending}
                  >
                    {saveSolicitud.isPending ? "Guardando..." : "Guardar cambios"}
                  </Button>
                </div>
              </div>
              <div className="flex justify-end gap-3 pt-2">
                <Button variant="secondary" onClick={() => setDetailModal({ open: false, solicitud: null })}>
                  Cerrar
                </Button>
                <Button onClick={() => setDetailTab("conversaciones")}>
                  Ver conversaciones del cliente
                </Button>
              </div>
            </TabsContent>

            <TabsContent value="conversaciones" className="space-y-4">
              {!detailClientKey ? (
                <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 p-6 text-sm text-slate-500">
                  Esta solicitud no tiene teléfono de cliente para buscar conversaciones del tenant.
                </div>
              ) : conversationsLoading ? (
                <div className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-500">
                  Cargando conversaciones del cliente...
                </div>
              ) : conversations.length === 0 ? (
                <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 p-6 text-sm text-slate-500">
                  No hay conversaciones registradas para este cliente en este tenant.
                </div>
              ) : (
                <div className="space-y-3 max-h-[55vh] overflow-auto pr-1">
                  {conversations.map((conversation) => {
                    const isCurrentConversation = detailModal.solicitud?.conversation?.id === conversation.id;
                    return (
                      <button
                        type="button"
                        onClick={() =>
                          setConversationDetailModal({
                            open: true,
                            conversation,
                          })
                        }
                        key={conversation.id}
                        className={`w-full text-left rounded-xl border p-4 transition hover:shadow-sm ${isCurrentConversation ? "border-blue-300 bg-blue-50/50" : "border-slate-200 bg-white"}`}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <div className="flex items-center gap-2 flex-wrap">
                              <p className="font-medium text-slate-900">{conversation.flow?.nombre ?? "Flujo sin nombre"}</p>
                              {isCurrentConversation && (
                                <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[11px] font-semibold text-blue-700">
                                  Conversación actual
                                </span>
                              )}
                            </div>
                            <p className="text-sm text-slate-500 mt-1">ID {conversation.id} · Estado {conversation.status}</p>
                            <p className="text-sm text-slate-500">
                              Inicio {formatDate(conversation.startedAt)}
                              {conversation.endedAt ? ` · Fin ${formatDate(conversation.endedAt)}` : ""}
                            </p>
                          </div>
                          <div className="text-right text-xs text-slate-500">
                            <p>{conversation.solicitudes?.length ?? 0} solicitud(es) vinculada(s)</p>
                            <p className="truncate max-w-[12rem]">{conversation.userKey}</p>
                          </div>
                        </div>
                        {conversation.solicitudes?.length ? (
                          <div className="mt-3 flex flex-wrap gap-2">
                            {conversation.solicitudes.map((solicitud) => (
                              <span
                                key={solicitud.id}
                                className="rounded-full bg-slate-100 px-2 py-1 text-[11px] font-medium text-slate-600"
                              >
                                Solicitud #{solicitud.id} · {ESTADO_LABELS[solicitud.estado] ?? solicitud.estado}
                              </span>
                            ))}
                          </div>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              )}
              <div className="flex justify-end gap-3 pt-2">
                <Button variant="secondary" onClick={() => setDetailModal({ open: false, solicitud: null })}>
                  Cerrar
                </Button>
              </div>
            </TabsContent>
          </Tabs>
        )}
      </Modal>

      <Modal
        open={conversationDetailModal.open}
        onClose={() => setConversationDetailModal({ open: false, conversation: null })}
        title="Detalle de conversación"
        className="max-w-3xl"
      >
        {conversationDetailModal.conversation && (
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                <p className="text-xs uppercase tracking-wide text-slate-500">Flujo</p>
                <p className="mt-1 font-medium text-slate-900">
                  {conversationDetailModal.conversation.flow?.nombre ?? "Flujo sin nombre"}
                </p>
              </div>
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                <p className="text-xs uppercase tracking-wide text-slate-500">Estado</p>
                <p className="mt-1 text-sm text-slate-700">{conversationDetailModal.conversation.status}</p>
              </div>
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 sm:col-span-2">
                <p className="text-xs uppercase tracking-wide text-slate-500">Identificador</p>
                <p className="mt-1 text-sm text-slate-700 break-all">{conversationDetailModal.conversation.id}</p>
                <p className="mt-1 text-sm text-slate-600">Cliente {conversationDetailModal.conversation.userKey}</p>
              </div>
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                <p className="text-xs uppercase tracking-wide text-slate-500">Inicio</p>
                <p className="mt-1 text-sm text-slate-700">{formatDate(conversationDetailModal.conversation.startedAt)}</p>
              </div>
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                <p className="text-xs uppercase tracking-wide text-slate-500">Fin</p>
                <p className="mt-1 text-sm text-slate-700">
                  {conversationDetailModal.conversation.endedAt
                    ? formatDate(conversationDetailModal.conversation.endedAt)
                    : "Activa / sin cierre"}
                </p>
              </div>
            </div>

            {isAgentSession ? (
              <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 p-4 text-sm text-slate-500">
                En sesión de agente solo se muestra el resumen. El detalle técnico de eventos está disponible en sesión de administrador.
              </div>
            ) : conversationDetailLoading ? (
              <div className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-500">
                Cargando eventos de la conversación...
              </div>
            ) : conversationEvents.length === 0 ? (
              <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 p-4 text-sm text-slate-500">
                Esta conversación no tiene eventos registrados.
              </div>
            ) : (
              <div className="space-y-2 max-h-[45vh] overflow-auto pr-1">
                {conversationEvents.map((eventItem) => (
                  <div key={eventItem.id} className="rounded-xl border border-slate-200 bg-white p-3">
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-sm font-medium text-slate-900">{eventItem.eventType}</p>
                      <p className="text-xs text-slate-500">{formatDate(eventItem.createdAt)}</p>
                    </div>
                    {eventItem.nodeRef ? (
                      <p className="mt-1 text-xs text-slate-500">Nodo: {eventItem.nodeRef}</p>
                    ) : null}
                    <pre className="mt-2 overflow-auto rounded-lg bg-slate-950/95 p-3 text-xs text-slate-100">
                      {formatEventPayload(eventItem.payload)}
                    </pre>
                  </div>
                ))}
              </div>
            )}

            <div className="flex justify-end">
              <Button variant="secondary" onClick={() => setConversationDetailModal({ open: false, conversation: null })}>
                Cerrar
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
