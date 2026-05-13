"use client";

import React from "react";
import { adminUsersApi, agentesApi, conversationsApi, solicitudesApi } from "@/lib/api";
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
import { cn, formatDate } from "@/lib/utils";
import { AlertTriangle, Clock3, Filter, MessageCircleMore, Search, UserCheck } from "lucide-react";
import { useSocket } from "@/hooks/useSocket";

const ESTADOS = ["open", "in_progress", "pending_info", "completed", "rejected"];
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

const EVENT_BADGES: Record<string, { label: string; color: string }> = {
  conversation_started: { label: "Inicio", color: "text-emerald-700 bg-emerald-50 border-emerald-200" },
  message_sent: { label: "Bot", color: "text-blue-700 bg-blue-50 border-blue-200" },
  user_input: { label: "Cliente", color: "text-slate-700 bg-slate-100 border-slate-200" },
  menu_selection: { label: "Seleccion", color: "text-violet-700 bg-violet-50 border-violet-200" },
  condition_evaluated: { label: "Condicion", color: "text-amber-700 bg-amber-50 border-amber-200" },
  api_call: { label: "API", color: "text-orange-700 bg-orange-50 border-orange-200" },
  task_status_change: { label: "Tarea", color: "text-fuchsia-700 bg-fuchsia-50 border-fuchsia-200" },
  conversation_ended: { label: "Cierre", color: "text-slate-600 bg-slate-100 border-slate-200" },
};

interface Solicitud {
  id: number;
  userId?: number | null;
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
  user?: { id?: number | null; phone?: string | null; name?: string | null } | null;
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

interface ConversationMensajeItem {
  id: number;
  direccion: string;
  tipo: string;
  contenido: unknown;
  createdAt: string;
  agenteId: number | null;
  agente?: { id: number; nombre: string } | null;
}

interface ConversationDetail {
  id: string;
  userKey: string;
  status: string;
  startedAt: string;
  endedAt: string | null;
  flow?: { id: number; nombre: string } | null;
  events?: ConversationEventItem[];
  mensajes?: ConversationMensajeItem[];
}

interface ConversationBubble {
  id: string;
  text: string;
  createdAt: string;
  eventType: string;
  nodeRef: string | null;
  isOutbound: boolean;
}

interface Agente {
  id: number;
  nombre: string;
  estado: string;
  puestoId?: number | null;
  puesto?: { id: number; nombre: string } | null;
}

interface EscalationModalState {
  open: boolean;
  solicitud: Solicitud | null;
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

  const { tenantSlug, superAdmin } = useAuthStore();

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
  const [detailTab, setDetailTab] = useState<"resumen" | "conversaciones" | "mensajes">("resumen");
  const [detailDraft, setDetailDraft] = useState({
    estado: "open",
    prioridad: "",
    agenteId: "",
    categoria: "",
    subcategoria: "",
    dueAt: "",
  });
  const [messageInput, setMessageInput] = useState("");
  const [messageSearch, setMessageSearch] = useState("");
  const [messageDirection, setMessageDirection] = useState<"" | "entrada" | "salida">("");
  const [messageStartDate, setMessageStartDate] = useState("");
  const [messageEndDate, setMessageEndDate] = useState("");
  const [messageReadStatus, setMessageReadStatus] = useState<"" | "leido" | "no_leido">("");
  const [conversationDetailModal, setConversationDetailModal] = useState<{
    open: boolean;
    conversation: ConversationItem | null;
  }>({ open: false, conversation: null });
  const [selectedAgente, setSelectedAgente] = useState("");
  const [escalationModal, setEscalationModal] = useState<EscalationModalState>({
    open: false,
    solicitud: null,
  });
  const [escalationReason, setEscalationReason] = useState("");
  const [escalationTargetAdminUserId, setEscalationTargetAdminUserId] = useState<string>("");
  const defaultDetailTab: "resumen" | "conversaciones" | "mensajes" = isAgentSession ? "mensajes" : "resumen";
  const detailModeLabel = isAgentSession ? "Vista de agente" : "Vista admin";
  const detailModeDescription = isAgentSession
    ? "Esta solicitud se está viendo con sesión de agente; el detalle técnico queda limitado."
    : "Edición completa del panel admin con estados, prioridad, agente y mensajes.";

  function openSolicitudDetail(solicitud: Solicitud): void {
    setDetailModal({ open: true, solicitud });
    setDetailTab(defaultDetailTab);
  }

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
  // Real-time: auto-refresh messages when a new message is sent/received for this solicitud
  useSocket(tenantSlug || null, "SOLICITUD_MESSAGE_SENT", () => {
    qc.invalidateQueries({ queryKey: ["solicitud-messages"] });
  });
  // Also refresh on WhatsApp delivery status changes while messages tab is open
  useSocket(tenantSlug || null, "SOLICITUD_MESSAGE_STATUS", () => {
    qc.invalidateQueries({ queryKey: ["solicitud-messages"] });
  });

  const { data: adminUsersData } = useQuery({
    queryKey: ["admin-users", tenantSlug],
    queryFn: () => adminUsersApi.list(tenantSlug).then((r) => r.data),
    enabled: !!tenantSlug,
  });

  const { data: agentesData } = useQuery({
    queryKey: ["agentes", tenantSlug],
    queryFn: () => agentesApi.list(tenantSlug).then((r) => r.data),
    enabled: !!tenantSlug,
  });

  function patchSolicitudAgenteInCache(solicitudId: number, agenteId: number | null) {
    const agenteSnapshot = agenteId
      ? (agentes.find((agente) => agente.id === agenteId) ?? { id: agenteId, nombre: "Asignado" })
      : null;

    qc.setQueriesData({ queryKey: ["solicitudes"] }, (old: any) => {
      if (!old) return old;

      const patchSolicitud = (solicitud: Solicitud) =>
        solicitud.id === solicitudId
          ? {
              ...solicitud,
              agenteId,
              agente: agenteSnapshot ? { id: agenteSnapshot.id, nombre: agenteSnapshot.nombre } : null,
            }
          : solicitud;

      if (Array.isArray(old)) {
        return old.map(patchSolicitud);
      }

      if (Array.isArray(old.data)) {
        return { ...old, data: old.data.map(patchSolicitud) };
      }

      if (Array.isArray(old.items)) {
        return { ...old, items: old.items.map(patchSolicitud) };
      }

      return old;
    });

    setDetailModal((prev) => {
      if (!prev.solicitud || prev.solicitud.id !== solicitudId) return prev;
      return {
        ...prev,
        solicitud: {
          ...prev.solicitud,
          agenteId,
          agente: agenteSnapshot ? { id: agenteSnapshot.id, nombre: agenteSnapshot.nombre } : null,
        },
      };
    });
  }

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
    onSuccess: (_data, variables) => {
      patchSolicitudAgenteInCache(variables.id, variables.agenteId);
      qc.invalidateQueries({ queryKey: ["solicitudes"] });
      setAssignModal({ open: false, solicitudId: null });
    },
  });

  const escalateSolicitud = useMutation({
    mutationFn: ({
      id,
      reason,
      targetAdminUserId,
    }: {
      id: number;
      reason?: string;
      targetAdminUserId?: number;
    }) =>
      solicitudesApi.escalate(tenantSlug, id, {
        reason,
        targetAdminUserId,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["solicitudes"] });
      qc.invalidateQueries({ queryKey: ["solicitudes-stats"] });
      setEscalationModal({ open: false, solicitud: null });
      setEscalationReason("");
      setEscalationTargetAdminUserId("");
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
    enabled: Boolean(
      detailModal.open &&
      detailModal.solicitud &&
      detailClientKey &&
      detailTab === "conversaciones" &&
      (isAgentSession || !superAdmin || Boolean(tenantSlug))
    ),
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
    enabled: Boolean(
      conversationDetailModal.open &&
      selectedConversationId &&
      !isAgentSession &&
      (!superAdmin || Boolean(tenantSlug))
    ),
    staleTime: 30_000,
  });
  const conversationEvents: ConversationEventItem[] =
    (conversationDetailData?.events as ConversationEventItem[] | undefined) ?? [];

  const { data: messagesData, isLoading: messagesLoading, refetch: refetchMessages } = useQuery({
    queryKey: [
      "solicitud-messages",
      tenantSlug,
      detailModal.solicitud?.id,
      isAgentSession ? "agent" : "admin",
      messageSearch,
      messageDirection,
      messageStartDate,
      messageEndDate,
      messageReadStatus,
    ],
    queryFn: () =>
      isAgentSession
        ? agentAuthApi
            .solicitudMessages(detailModal.solicitud?.id || 0, {
              page: 1,
              limit: 50,
              q: messageSearch.trim() || undefined,
              direccion: messageDirection || undefined,
              start: messageStartDate || undefined,
              end: messageEndDate || undefined,
              lectura: messageReadStatus || undefined,
            })
            .then((r) => r.data)
        : solicitudesApi
            .messages(tenantSlug || "", detailModal.solicitud?.id || 0, {
              page: 1,
              limit: 50,
              q: messageSearch.trim() || undefined,
              direccion: messageDirection || undefined,
              start: messageStartDate || undefined,
              end: messageEndDate || undefined,
              lectura: messageReadStatus || undefined,
            })
            .then((r) => r.data),
    enabled: Boolean(detailModal.open && detailModal.solicitud?.id && detailTab === "mensajes"),
    staleTime: 0,
  });

  const messageRows: any[] = Array.isArray(messagesData)
    ? messagesData
    : Array.isArray((messagesData as any)?.data)
      ? (messagesData as any).data
      : Array.isArray((messagesData as any)?.items)
        ? (messagesData as any).items
        : [];

  const sendMessageMutation = useMutation({
    mutationFn: ({ text }: { text: string }) =>
      isAgentSession
        ? agentAuthApi.sendSolicitudMessage(detailModal.solicitud?.id || 0, text)
        : solicitudesApi.sendMessage(tenantSlug || "", detailModal.solicitud?.id || 0, text),
    onSuccess: () => {
      setMessageInput("");
      refetchMessages();
    },
  });

  function formatDateForInput(value: Date): string {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, "0");
    const day = String(value.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function applyMessageDatePreset(days: number): void {
    const end = new Date();
    const start = new Date();
    if (days > 1) start.setDate(start.getDate() - (days - 1));
    setMessageStartDate(formatDateForInput(start));
    setMessageEndDate(formatDateForInput(end));
  }

  function formatEventPayload(payload: unknown): string {
    if (payload == null) return "Sin payload";
    if (typeof payload === "string") return payload;
    try {
      return JSON.stringify(payload, null, 2);
    } catch {
      return "Payload no serializable";
    }
  }

  function asReadableText(value: unknown): string | null {
    if (typeof value === "string") {
      const trimmed = value.trim();
      return trimmed ? trimmed : null;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }
    return null;
  }

  function toPayloadRecord(payload: unknown): Record<string, unknown> | null {
    let data: Record<string, unknown> | null = null;

    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      data = payload as Record<string, unknown>;
    } else if (typeof payload === "string") {
      try {
        const parsed = JSON.parse(payload) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          data = parsed as Record<string, unknown>;
        }
      } catch {
        // Ignore non-JSON strings and continue with event-specific fallback.
      }

      if (!data) {
        return null;
      }
    }

    return data;
  }

  function findMenuOptionTitle(options: unknown, selectedId: string): string | null {
    if (!Array.isArray(options)) return null;

    for (const option of options) {
      if (!option || typeof option !== "object") continue;
      const optionRecord = option as Record<string, unknown>;

      const directId = asReadableText(optionRecord.id);
      if (directId === selectedId) {
        return (
          asReadableText(optionRecord.title) ??
          asReadableText(optionRecord.label) ??
          asReadableText(optionRecord.text) ??
          directId
        );
      }

      const rows = optionRecord.rows;
      if (Array.isArray(rows)) {
        for (const row of rows) {
          if (!row || typeof row !== "object") continue;
          const rowRecord = row as Record<string, unknown>;
          const rowId = asReadableText(rowRecord.id);
          if (rowId === selectedId) {
            return asReadableText(rowRecord.title) ?? asReadableText(rowRecord.label) ?? rowId;
          }
        }
      }
    }

    return null;
  }

  function extractNestedReadableText(value: unknown, depth = 0): string | null {
    if (depth > 4 || value == null) return null;

    const primitive = asReadableText(value);
    if (primitive) return primitive;

    if (Array.isArray(value)) {
      for (const item of value) {
        const nested = extractNestedReadableText(item, depth + 1);
        if (nested) return nested;
      }
      return null;
    }

    if (typeof value === "object") {
      const record = value as Record<string, unknown>;
      const prioritizedKeys = [
        "text",
        "body",
        "caption",
        "message",
        "title",
        "content",
        "raw_input",
        "value",
        "input",
        "selected_id",
        "id",
      ];

      for (const key of prioritizedKeys) {
        if (!(key in record)) continue;
        const nested = extractNestedReadableText(record[key], depth + 1);
        if (nested) return nested;
      }

      const nestedKeys = ["contenido", "content", "interactive", "reply", "output", "payload", "raw"];
      for (const key of nestedKeys) {
        if (!(key in record)) continue;
        const nested = extractNestedReadableText(record[key], depth + 1);
        if (nested) return nested;
      }
    }

    return null;
  }

  function resolveMenuSelectionLabel(
    eventItem: ConversationEventItem,
    events: ConversationEventItem[],
    currentIndex: number,
    selectedId: string,
  ): string | null {
    for (let i = currentIndex - 1; i >= 0; i -= 1) {
      const previous = events[i];
      if (previous.eventType !== "message_sent") continue;
      if (previous.nodeRef && eventItem.nodeRef && previous.nodeRef !== eventItem.nodeRef) continue;

      const previousPayload = toPayloadRecord(previous.payload);
      if (!previousPayload) continue;

      const options = previousPayload.options;
      const optionTitle = findMenuOptionTitle(options, selectedId);
      if (optionTitle) return optionTitle;
    }

    return null;
  }

  function extractEventText(
    eventItem: ConversationEventItem,
    events: ConversationEventItem[],
    currentIndex: number,
  ): string | null {
    const payload = eventItem.payload;
    const data = toPayloadRecord(payload);

    if (!data) {
      return typeof payload === "string" ? asReadableText(payload) : null;
    }

    if (eventItem.eventType === "user_input") {
      const inboundText =
        asReadableText(data.raw_input) ??
        asReadableText(data.value) ??
        asReadableText(data.input) ??
        asReadableText(data.text) ??
        extractNestedReadableText(data.raw_input) ??
        extractNestedReadableText(data.value) ??
        extractNestedReadableText(data.input);
      if (inboundText) return inboundText;
    }

    if (eventItem.eventType === "menu_selection") {
      const selectedId = asReadableText(data.selected_id) ?? asReadableText(data.input);
      if (selectedId) {
        const selectedLabel = resolveMenuSelectionLabel(eventItem, events, currentIndex, selectedId);
        if (selectedLabel) return selectedLabel;
      }

      const selectedText =
        selectedId ??
        asReadableText(data.selected_title) ??
        asReadableText(data.selected_label) ??
        asReadableText(data.input);
      if (selectedText) return selectedText;
    }

    if (eventItem.eventType === "message_received") {
      const receivedText =
        asReadableText(data.text) ??
        extractNestedReadableText(data.contenido) ??
        extractNestedReadableText(data.content) ??
        extractNestedReadableText(data.payload) ??
        extractNestedReadableText(data.raw);
      if (receivedText) return receivedText;
    }

    const directCandidates = [
      data.text,
      data.content,
      data.raw_input,
      data.value,
      data.input,
      data.message,
      data.prompt,
      data.caption,
      data.title,
      data.selected_id,
    ];
    for (const candidate of directCandidates) {
      const text = asReadableText(candidate);
      if (text) return text;
    }

    const output = data.output;
    if (output && typeof output === "object" && !Array.isArray(output)) {
      const out = output as Record<string, unknown>;
      const outText = asReadableText(out.text) ?? asReadableText(out.title) ?? asReadableText(out.body);
      if (outText) return outText;
    }

    const interactive = data.interactive;
    if (interactive && typeof interactive === "object" && !Array.isArray(interactive)) {
      const iv = interactive as Record<string, unknown>;
      const reply = iv.reply;
      if (reply && typeof reply === "object" && !Array.isArray(reply)) {
        const rv = reply as Record<string, unknown>;
        const replyText = asReadableText(rv.title) ?? asReadableText(rv.id);
        if (replyText) return replyText;
      }
    }

    const nestedFallback = extractNestedReadableText(data);
    if (nestedFallback) return nestedFallback;

    return null;
  }

  const conversationBubbles: ConversationBubble[] = (() => {
    const fromEvents: ConversationBubble[] = conversationEvents
      .map((eventItem, index) => {
        const text = extractEventText(eventItem, conversationEvents, index);
        if (!text) return null;
        const eventType = (eventItem.eventType || "").toLowerCase();
        const isOutbound =
          eventType === "message_sent" ||
          eventType === "conversation_started" ||
          eventType === "flow_start";
        return {
          id: eventItem.id,
          text,
          createdAt: eventItem.createdAt,
          eventType: eventItem.eventType,
          nodeRef: eventItem.nodeRef,
          isOutbound,
        };
      })
      .filter((bubble): bubble is ConversationBubble => Boolean(bubble));

    const conversationMensajes: ConversationMensajeItem[] =
      (conversationDetailData?.mensajes as ConversationMensajeItem[] | undefined) ?? [];

    const fromMensajes: ConversationBubble[] = conversationMensajes
      .map((m) => {
        const contenido = m.contenido as Record<string, unknown> | null;
        const text: string =
          typeof contenido?.text === "string" && contenido.text.trim()
            ? contenido.text.trim()
            : typeof contenido?.body === "string" && contenido.body.trim()
              ? contenido.body.trim()
              : null!;
        if (!text) return null;
        const isOutbound = m.direccion === "salida";
        const actorLabel = m.agente?.nombre
          ? m.agente.nombre
          : isOutbound
            ? "Agente"
            : "Cliente";
        return {
          id: `msg-${m.id}`,
          text,
          createdAt: m.createdAt,
          eventType: isOutbound ? "crm_outbound" : "crm_inbound",
          nodeRef: actorLabel,
          isOutbound,
        };
      })
      .filter((bubble): bubble is ConversationBubble => Boolean(bubble));

    // Merge and sort by time; dedupe events that overlap with mensajes
    const eventCreatedAts = new Set(fromEvents.map((b) => b.createdAt));
    const uniqueMensajes = fromMensajes.filter(
      (b) => !eventCreatedAts.has(b.createdAt)
    );

    return [...fromEvents, ...uniqueMensajes].sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    );
  })();

  function renderConversationDetailContent() {
    if (!conversationDetailModal.conversation) return null;

    return (
      <div className="space-y-4">
        <div className="rounded-2xl border border-slate-200 bg-white p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <div className="h-10 w-10 rounded-full bg-blue-100 text-blue-700 font-semibold flex items-center justify-center">
                <MessageCircleMore size={18} />
              </div>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-slate-900 truncate">
                  {conversationDetailModal.conversation.flow?.nombre ?? "Conversacion"}
                </p>
                <p className="text-xs text-slate-500 truncate">Cliente {conversationDetailModal.conversation.userKey}</p>
              </div>
            </div>
            <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-700 whitespace-nowrap">
              {conversationDetailModal.conversation.status}
            </span>
          </div>
          <div className="mt-3 grid gap-2 text-xs text-slate-500 sm:grid-cols-2">
            <p>Inicio: {formatDate(conversationDetailModal.conversation.startedAt)}</p>
            <p>
              Fin: {conversationDetailModal.conversation.endedAt
                ? formatDate(conversationDetailModal.conversation.endedAt)
                : "Activa / sin cierre"}
            </p>
          </div>
        </div>

        {isAgentSession ? (
          <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 p-4 text-sm text-slate-500">
            El detalle técnico solo está disponible para administradores. En esta vista se muestra el resumen de la conversación.
          </div>
        ) : (
          <>
            <div className="rounded-2xl border border-slate-200 overflow-hidden">
              <div className="border-b border-slate-200 bg-white px-4 py-2.5">
                <p className="text-sm font-medium text-slate-800">Mensajes</p>
                <p className="text-xs text-slate-400">Vista estilo cliente</p>
              </div>
              <div className="max-h-[42vh] overflow-y-auto p-4 space-y-3 bg-slate-50">
                {conversationDetailLoading ? (
                  <div className="flex flex-col gap-3">
                    {[1, 2, 3].map((item) => (
                      <div key={item} className={cn("animate-pulse flex", item % 2 === 0 ? "justify-end" : "justify-start")}>
                        <div className="h-10 w-48 bg-slate-200 rounded-2xl" />
                      </div>
                    ))}
                  </div>
                ) : conversationBubbles.length === 0 ? (
                  <div className="flex items-center justify-center h-24 text-sm text-slate-400">
                    No hay mensajes legibles para mostrar en esta conversación.
                  </div>
                ) : (
                  conversationBubbles.map((bubble) => {
                    const isCrm = bubble.eventType === "crm_outbound" || bubble.eventType === "crm_inbound";
                    const senderLabel = isCrm
                      ? (bubble.nodeRef ?? (bubble.isOutbound ? "Agente" : "Cliente"))
                      : bubble.isOutbound
                        ? "Bot"
                        : "Cliente";
                    return (
                    <div key={bubble.id} className={cn("flex flex-col gap-0.5", bubble.isOutbound ? "items-end" : "items-start")}>
                      <span className={cn("text-[10px] font-medium px-1", bubble.isOutbound ? (isCrm ? "text-emerald-600" : "text-blue-500") : "text-slate-400")}>
                        {senderLabel}
                      </span>
                      <div
                        className={cn(
                          "max-w-xs lg:max-w-md px-4 py-2.5 rounded-2xl text-sm shadow-sm",
                          bubble.isOutbound
                            ? (isCrm ? "bg-emerald-600 text-white rounded-tr-sm" : "bg-blue-600 text-white rounded-tr-sm")
                            : "bg-white text-slate-800 rounded-tl-sm border border-slate-200"
                        )}
                      >
                        <p className="whitespace-pre-wrap">{bubble.text}</p>
                        <p className={cn("text-xs mt-1", bubble.isOutbound ? (isCrm ? "text-emerald-200" : "text-blue-200") : "text-slate-400")}>
                          {new Date(bubble.createdAt).toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" })}
                        </p>
                      </div>
                    </div>
                    );
                  })
                )}
              </div>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white p-3.5 space-y-2 max-h-[28vh] overflow-y-auto">
              <p className="text-sm font-medium text-slate-800">Actividad del flujo</p>
              {conversationDetailLoading ? (
                <p className="text-sm text-slate-400">Cargando actividad...</p>
              ) : conversationEvents.length === 0 ? (
                <p className="text-sm text-slate-400">No hay eventos registrados.</p>
              ) : (
                conversationEvents.map((eventItem) => {
                  const badge = EVENT_BADGES[eventItem.eventType] ?? {
                    label: eventItem.eventType,
                    color: "text-slate-700 bg-slate-100 border-slate-200",
                  };
                  return (
                    <div key={eventItem.id} className="rounded-xl border border-slate-200 bg-slate-50 p-2.5">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className={cn("text-[11px] font-semibold px-2 py-0.5 rounded-full border", badge.color)}>
                            {badge.label}
                          </span>
                          {eventItem.nodeRef ? (
                            <span className="text-[11px] text-slate-400 truncate">{eventItem.nodeRef}</span>
                          ) : null}
                        </div>
                        <span className="text-[11px] text-slate-400 shrink-0">
                          {new Date(eventItem.createdAt).toLocaleTimeString("es", {
                            hour: "2-digit",
                            minute: "2-digit",
                            second: "2-digit",
                          })}
                        </span>
                      </div>
                      <details className="mt-1.5">
                        <summary className="cursor-pointer text-[11px] text-slate-500 select-none">Ver detalle técnico</summary>
                        <pre className="mt-2 overflow-auto rounded-lg bg-slate-950/95 p-3 text-xs text-slate-100">
                          {formatEventPayload(eventItem.payload)}
                        </pre>
                      </details>
                    </div>
                  );
                })
              )}
            </div>
          </>
        )}

        <div className="flex justify-end">
          <Button variant="secondary" onClick={() => setConversationDetailModal({ open: false, conversation: null })}>
            Cerrar
          </Button>
        </div>
      </div>
    );
  }

  const solicitudes: Solicitud[] = data?.data ?? [];
  const total: number = data?.total ?? 0;
  const agentes: Agente[] = agentesData?.data ?? agentesData ?? [];
  const stats = statsData ?? { total: 0, estado: {}, sla: { onTrack: 0, warning: 0, breached: 0 } };
  const agentesActivos = agentes.filter((agente) => agente.estado === "activo");
  const adminUsers: Array<{ id: number; nombre: string; email: string; jefeId: number | null; superAdmin: boolean }> =
    adminUsersData?.data ?? adminUsersData ?? [];

  // Build AdminUser tree: group by root (no jefeId) vs children
  const rootAdminUsers = adminUsers.filter((u) => !u.jefeId);
  function getAdminUserSubordinados(parentId: number): typeof adminUsers {
    return adminUsers.filter((u) => u.jefeId === parentId);
  }

  function handleAssign() {
    if (!assignModal.solicitudId || !selectedAgente) return;
    assignAgente.mutate({
      id: assignModal.solicitudId,
      agenteId: parseInt(selectedAgente),
    });
  }

  function openEscalationModal(solicitud: Solicitud) {
    if (!solicitud.userId) {
      alert("La solicitud debe tener un usuario asociado para escalar.");
      return;
    }
    setEscalationModal({ open: true, solicitud });
    setEscalationReason("");
    setEscalationTargetAdminUserId("");
  }

  function handleEscalateSubmit() {
    if (!escalationModal.solicitud) return;
    if (!escalationTargetAdminUserId) return;
    escalateSolicitud.mutate({
      id: escalationModal.solicitud.id,
      reason: escalationReason.trim() || undefined,
      targetAdminUserId: Number(escalationTargetAdminUserId),
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
                                setDetailTab(defaultDetailTab);
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

    {isAgentSession && (
      <Modal
        open={detailModal.open}
        onClose={() => setDetailModal({ open: false, solicitud: null })}
        title="Detalle de solicitud"
        className="max-w-2xl"
      >
        {detailModal.solicitud && (
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                <p className="text-xs uppercase tracking-wide text-slate-500">Cliente</p>
                <p className="mt-1 text-sm font-medium text-slate-900">{detailModal.solicitud.nombre || "Sin nombre"}</p>
                <p className="text-sm text-slate-600">{detailModal.solicitud.telefonoContacto || "Sin teléfono"}</p>
              </div>
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                <p className="text-xs uppercase tracking-wide text-slate-500">Estado</p>
                <p className="mt-1 text-sm font-medium text-slate-900">{(ESTADO_LABELS[detailModal.solicitud.estado || ""] ?? detailModal.solicitud.estado) || "-"}</p>
                <p className="text-sm text-slate-600">Actualizada {formatDate(detailModal.solicitud.updatedAt || detailModal.solicitud.createdAt)}</p>
              </div>
            </div>
            <div className="rounded-xl border border-dashed border-slate-200 bg-white p-4 text-sm text-slate-600">
              La acción de conversaciones abre este detalle para revisar la solicitud seleccionada.
            </div>
            <div className="flex justify-end">
              <Button variant="secondary" onClick={() => setDetailModal({ open: false, solicitud: null })}>
                Cerrar
              </Button>
            </div>
          </div>
        )}
      </Modal>
    )}

        <Modal
          open={detailModal.open}
          onClose={() => setDetailModal({ open: false, solicitud: null })}
          title="Detalle de solicitud"
          className="max-w-4xl"
        >
          {detailModal.solicitud && (
            <>
              <div className="rounded-2xl border border-slate-200 bg-gradient-to-r from-slate-50 via-white to-blue-50 p-4 shadow-sm">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide ${
                          isAgentSession
                            ? "border-amber-200 bg-amber-50 text-amber-700"
                            : "border-blue-200 bg-blue-50 text-blue-700"
                        }`}
                      >
                        {detailModeLabel}
                      </span>
                      <span className="rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-semibold text-slate-600">
                        Solicitud #{detailModal.solicitud.id}
                      </span>
                    </div>
                    <h3 className="mt-3 truncate text-xl font-semibold text-slate-900">
                      {detailModal.solicitud.nombre || "Sin nombre"}
                    </h3>
                    <p className="mt-1 text-sm text-slate-600">
                      {detailModal.solicitud.telefonoContacto || "Sin teléfono"}
                      {detailModal.solicitud.createdAt ? ` · Creada ${formatDate(detailModal.solicitud.createdAt)}` : ""}
                    </p>
                  </div>
                  <div className="flex flex-col gap-2 lg:items-end">
                    <StatusBadge status={detailModal.solicitud.estado} />
                    <p className="text-xs text-slate-500">
                      {detailModal.solicitud.agente?.nombre ? `Agente: ${detailModal.solicitud.agente.nombre}` : "Sin agente asignado"}
                    </p>
                    <p className="text-xs text-slate-500">
                      {detailModal.solicitud.dueAt ? `Vence ${formatDate(detailModal.solicitud.dueAt)}` : "Sin vencimiento"}
                    </p>
                  </div>
                </div>
                <p className="mt-3 text-sm text-slate-600">{detailModeDescription}</p>
              </div>

              <Tabs value={detailTab} className="space-y-4">
                <TabsList className="w-full justify-start overflow-x-auto">
                  <TabsTrigger value="resumen" onClick={() => setDetailTab("resumen")}>Resumen</TabsTrigger>
                  <TabsTrigger value="conversaciones" onClick={() => setDetailTab("conversaciones")}>Conversaciones del cliente</TabsTrigger>
                  <TabsTrigger value="mensajes" onClick={() => setDetailTab("mensajes")}>Mensajes WhatsApp</TabsTrigger>
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

              <TabsContent value="mensajes" className="space-y-4">
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <input
                      type="text"
                      value={messageSearch}
                      onChange={(e) => setMessageSearch(e.target.value)}
                      placeholder="Filtrar por texto..."
                      className="flex-1 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm placeholder-slate-500 focus:border-blue-500 focus:outline-none"
                    />
                    <select
                      value={messageDirection}
                      onChange={(e) => setMessageDirection((e.target.value as "" | "entrada" | "salida") || "")}
                      className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                    >
                      <option value="">Todas las direcciones</option>
                      <option value="entrada">Recibidos</option>
                      <option value="salida">Enviados</option>
                    </select>
                    <select
                      value={messageReadStatus}
                      onChange={(e) => setMessageReadStatus((e.target.value as "" | "leido" | "no_leido") || "")}
                      className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                    >
                      <option value="">Todos los estados</option>
                      <option value="leido">Leidos</option>
                      <option value="no_leido">No leidos</option>
                    </select>
                    <input
                      type="date"
                      value={messageStartDate}
                      onChange={(e) => setMessageStartDate(e.target.value)}
                      className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                    />
                    <input
                      type="date"
                      value={messageEndDate}
                      onChange={(e) => setMessageEndDate(e.target.value)}
                      className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                    />
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        setMessageSearch("");
                        setMessageDirection("");
                        setMessageStartDate("");
                        setMessageEndDate("");
                        setMessageReadStatus("");
                      }}
                      disabled={!messageSearch.trim() && !messageDirection && !messageStartDate && !messageEndDate && !messageReadStatus}
                    >
                      Limpiar
                    </Button>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button variant="secondary" size="sm" onClick={() => applyMessageDatePreset(1)}>
                      Hoy
                    </Button>
                    <Button variant="secondary" size="sm" onClick={() => applyMessageDatePreset(7)}>
                      7d
                    </Button>
                    <Button variant="secondary" size="sm" onClick={() => applyMessageDatePreset(30)}>
                      30d
                    </Button>
                  </div>
                </div>

                {messagesLoading ? (
                  <div className="flex items-center justify-center py-8">
                    <div className="text-slate-500">Cargando mensajes...</div>
                  </div>
                ) : messageRows.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 px-4 py-8 text-center">
                    <MessageCircleMore className="mx-auto mb-2 h-6 w-6 text-slate-400" />
                    <p className="text-sm text-slate-600">No hay mensajes aún</p>
                  </div>
                ) : (
                  <div className="space-y-3 max-h-96 overflow-y-auto">
                    {messageRows.map((msg: any) => (
                      <div
                        key={msg.id}
                        className={cn(
                          "rounded-lg p-3 max-w-xs",
                          msg.direccion === "salida"
                            ? "ml-auto bg-blue-100 text-blue-900"
                            : "mr-auto bg-slate-100 text-slate-900"
                        )}
                      >
                        <div className="text-xs font-medium mb-1">
                          {msg.direccion === "salida" ? "🔴 Enviado" : "🟢 Recibido"}
                        </div>
                        <p className="text-sm break-words">
                          {typeof msg.contenido === "string"
                            ? msg.contenido
                            : msg.contenido?.text || JSON.stringify(msg.contenido)}
                        </p>
                        <div className="text-xs opacity-70 mt-1">
                          {formatDate(msg.createdAt)}
                          {msg.leido && msg.direccion === "salida" && " ✓✓"}
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                <div className="border-t border-slate-200 pt-4 space-y-2">
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={messageInput}
                      onChange={(e) => setMessageInput(e.target.value)}
                      placeholder="Escribe un mensaje..."
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey && messageInput.trim()) {
                          sendMessageMutation.mutate({ text: messageInput });
                        }
                      }}
                      className="flex-1 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm placeholder-slate-500 focus:border-blue-500 focus:outline-none"
                      disabled={sendMessageMutation.isPending}
                    />
                    <Button
                      onClick={() => {
                        if (messageInput.trim()) {
                          sendMessageMutation.mutate({ text: messageInput });
                        }
                      }}
                      disabled={sendMessageMutation.isPending || !messageInput.trim()}
                      size="sm"
                    >
                      {sendMessageMutation.isPending ? "Enviando..." : "Enviar"}
                    </Button>
                  </div>
                  {sendMessageMutation.isError && (
                    <p className="text-xs text-red-600">Error al enviar mensaje</p>
                  )}
                </div>
              </TabsContent>
            </Tabs>
            </>
          )}
        </Modal>

        <Modal
          open={conversationDetailModal.open}
          onClose={() => setConversationDetailModal({ open: false, conversation: null })}
          title="Detalle de conversación"
          className="max-w-3xl"
        >
          {renderConversationDetailContent()}
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
                            onClick={() => openEscalationModal(s)}
                            disabled={escalateSolicitud.isPending || !s.userId}
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
                            openSolicitudDetail(s as Solicitud);
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
        open={escalationModal.open}
        onClose={() => {
          if (escalateSolicitud.isPending) return;
          setEscalationModal({ open: false, solicitud: null });
          setEscalationReason("");
          setEscalationTargetAdminUserId("");
        }}
        title="Escalar por árbol jerárquico"
      >
        <div className="space-y-4">
          <div>
            <p className="text-sm font-medium text-slate-800">
              Solicitud #{escalationModal.solicitud?.id}
            </p>
            <p className="text-xs text-slate-600 mt-1">
              Usuario a escalar: {escalationModal.solicitud?.nombre || escalationModal.solicitud?.user?.phone || escalationModal.solicitud?.telefonoContacto || "No definido"}
            </p>
            <p className="text-xs text-slate-500 mt-1">
              Seleccioná el administrador destino dentro del árbol jerárquico.
            </p>
          </div>

          <div className="rounded-xl border border-slate-200 bg-slate-50 max-h-72 overflow-y-auto p-3 space-y-3">
            {adminUsers.length === 0 ? (
              <p className="text-sm text-slate-500">No hay administradores disponibles para escalar.</p>
            ) : (
              (() => {
                function renderAdminUserNode(user: typeof adminUsers[0], depth: number): React.ReactNode {
                  const isSelected = escalationTargetAdminUserId === String(user.id);
                  const subs = getAdminUserSubordinados(user.id);
                  return (
                    <div key={user.id} style={{ marginLeft: depth * 16 }} className="space-y-1">
                      <button
                        type="button"
                        onClick={() => setEscalationTargetAdminUserId(String(user.id))}
                        className={cn(
                          "w-full text-left rounded-lg border px-3 py-2 text-sm transition",
                          isSelected
                            ? "border-rose-300 bg-rose-50 text-rose-700"
                            : "border-slate-200 bg-white text-slate-700 hover:border-slate-300"
                        )}
                      >
                        <span className="font-medium">{user.nombre}</span>
                        <span className="ml-2 text-[11px] text-slate-400">{user.email}</span>
                        {user.superAdmin && (
                          <span className="ml-2 text-[11px] text-indigo-500">Super Admin</span>
                        )}
                      </button>
                      {subs.length > 0 && (
                        <div className="pl-3 border-l border-slate-200 space-y-1">
                          {subs.map((sub) => renderAdminUserNode(sub, depth + 1))}
                        </div>
                      )}
                    </div>
                  );
                }
                return rootAdminUsers.map((u) => renderAdminUserNode(u, 0));
              })()
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-slate-700">Motivo (opcional)</label>
            <textarea
              value={escalationReason}
              onChange={(e) => setEscalationReason(e.target.value)}
              rows={3}
              placeholder="Ej: requiere validación de nivel 2"
              className="px-3.5 py-2.5 rounded-xl border border-slate-200 bg-white text-sm focus:outline-none focus:ring-2 focus:ring-rose-500/30"
            />
          </div>

          <div className="flex justify-end gap-3 pt-2">
            <Button
              variant="secondary"
              onClick={() => {
                setEscalationModal({ open: false, solicitud: null });
                setEscalationReason("");
                setEscalationTargetAdminUserId("");
              }}
              disabled={escalateSolicitud.isPending}
            >
              Cancelar
            </Button>
            <Button
              onClick={handleEscalateSubmit}
              disabled={!escalationTargetAdminUserId || escalateSolicitud.isPending || adminUsers.length === 0}
            >
              {escalateSolicitud.isPending ? "Escalando..." : "Confirmar escalación"}
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
        {renderConversationDetailContent()}
      </Modal>
    </div>
  );
}
