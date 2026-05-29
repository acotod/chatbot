"use client";

import { cn, formatDate } from "@/lib/utils";
import {
  AlertTriangle,
  ChevronDown,
  ClipboardList,
  ExternalLink,
  GitBranch,
  MessageCircle,
  Search,
  Send,
  StickyNote,
  UserCheck,
  Wifi,
  WifiOff,
  X,
  Zap,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useAuthStore } from "@/store/auth";
import { agentesApi, conversationsApi, solicitudesApi, whatsappApi } from "@/lib/api";
import { useWaSocket } from "@/hooks/useSocket";
import { getSocket } from "@/lib/socket";
import { useTranslations } from "@/lib/i18n/client";

// ── Types ────────────────────────────────────────────────────────────────────

interface MensajeContenido {
  text?: string;
  interactive?: { type: string; reply?: { id: string; title: string } };
  [key: string]: unknown;
}

interface Mensaje {
  id: number;
  userId: number | null;
  waMsgId: string | null;
  direccion: "entrada" | "salida";
  tipo: string;
  contenido: MensajeContenido;
  createdAt: string;
}

interface Thread {
  id: number;
  userId: number | null;
  tipo: string;
  contenido: MensajeContenido;
  createdAt: string;
  user?: { id: number; phone?: string | null };
  _contactName?: string | null;
}

interface Solicitud {
  id: number;
  nombre: string | null;
  telefonoContacto: string | null;
  estado: string | null;
  horario: string | null;
  createdAt: string;
  agente?: { id: number; nombre: string } | null;
}

interface ConvEvent {
  id: string;
  eventType: string;
  nodeRef: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

interface ConvRecord {
  id: string;
  userKey: string;
  status: string;
  startedAt: string;
  endedAt: string | null;
  flow?: { nombre: string } | null;
  events?: ConvEvent[];
}

interface ApiTraceSummary {
  callId: string;
  conversationId: string;
  startedAt: string;
  endedAt: string;
  durationMs: number | null;
  method: string | null;
  endpoint: string | null;
  integrationRef: string | null;
  attempts: number;
  retries: number;
  statusCode: number | null;
  hasError: boolean;
  lastError: string | null;
  nodes: string[];
}

interface Agente {
  id: number;
  nombre: string;
  estado?: string | null;
}

const SOLICITUD_STATUS_KEY: Record<string, string> = {
  open: "open",
  in_progress: "in_progress",
  pending_info: "pending_info",
  completed: "completed",
  rejected: "rejected",
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractText(msg: Pick<Mensaje, "tipo" | "contenido">): string {
  const c = msg.contenido as Record<string, unknown>;

  const pickText = (value: unknown): string | null => {
    if (typeof value === "string") {
      const trimmed = value.trim();
      return trimmed || null;
    }
    if (!value || typeof value !== "object") return null;
    const obj = value as Record<string, unknown>;
    return (
      pickText(obj.text) ??
      pickText(obj.body) ??
      pickText(obj.message) ??
      pickText(obj.caption) ??
      pickText(obj.title) ??
      pickText(obj.reply) ??
      null
    );
  };

  const direct =
    pickText(c.text) ??
    pickText(c.body) ??
    pickText(c.message) ??
    pickText(c.caption) ??
    pickText(c.interactive) ??
    pickText(c.payload) ??
    pickText(c.raw);

  if (direct) return direct;
  const transcript = getAudioTranscript({ contenido: msg.contenido });
  if (transcript?.text) return transcript.text;
  const mediaType = inferMediaType(msg);
  if (mediaType === "image") return "Imagen";
  if (mediaType === "audio") return "Audio";
  if (mediaType === "document") return "Documento";
  return `[${msg.tipo}]`;
}

function inferMediaType(msg: Pick<Mensaje, "tipo" | "contenido">): "image" | "audio" | "document" | null {
  const normalizedTipo = String(msg.tipo ?? "").trim().toLowerCase();
  if (normalizedTipo === "image" || normalizedTipo === "audio" || normalizedTipo === "document") {
    return normalizedTipo;
  }

  const contenido = (msg.contenido && typeof msg.contenido === "object")
    ? (msg.contenido as Record<string, unknown>)
    : {};

  if (contenido.image && typeof contenido.image === "object") return "image";
  if (contenido.audio && typeof contenido.audio === "object") return "audio";
  if (contenido.document && typeof contenido.document === "object") return "document";

  const raw = (contenido.raw && typeof contenido.raw === "object")
    ? (contenido.raw as Record<string, unknown>)
    : null;
  if (raw?.image && typeof raw.image === "object") return "image";
  if (raw?.audio && typeof raw.audio === "object") return "audio";
  if (raw?.document && typeof raw.document === "object") return "document";

  return null;
}

function getDisplayName(thread: Thread): string {
  return thread._contactName ?? thread.user?.phone ?? `Usuario ${thread.userId}`;
}

function getAudioTranscript(msg: Pick<Mensaje, "contenido">):
  | { status: string; text: string | null; error: string | null }
  | null {
  const contenido = (msg.contenido && typeof msg.contenido === "object")
    ? (msg.contenido as Record<string, unknown>)
    : {};
  const direct = contenido.audioTranscript;
  const rawContainer = (contenido.raw && typeof contenido.raw === "object")
    ? (contenido.raw as Record<string, unknown>)
    : null;
  const raw = direct ?? rawContainer?.audioTranscript;
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  return {
    status: String(obj.status ?? "").trim() || "unknown",
    text: typeof obj.text === "string" ? obj.text.trim() || null : null,
    error: typeof obj.error === "string" ? obj.error.trim() || null : null,
  };
}

function MessageMediaContent({
  msg,
  tenantId,
  tenantSlug,
}: {
  msg: Mensaje;
  tenantId: string | null;
  tenantSlug: string | null;
}) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mediaType = inferMediaType(msg);
  const isMedia = mediaType !== null;
  const transcript = mediaType === "audio" ? getAudioTranscript(msg) : null;

  useEffect(() => {
    if (!isMedia || (!tenantId && !tenantSlug)) {
      setBlobUrl(null);
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    let localUrl: string | null = null;

    (async () => {
      setLoading(true);
      setError(null);
      try {
        const response = await whatsappApi.getMediaBlob(msg.id, {
          tenantId: tenantId ?? undefined,
          tenantSlug: tenantSlug ?? undefined,
        });
        localUrl = URL.createObjectURL(response.data as Blob);
        if (!cancelled) {
          setBlobUrl(localUrl);
        }
      } catch {
        if (!cancelled) setError("media_unavailable");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      if (localUrl) URL.revokeObjectURL(localUrl);
    };
  }, [isMedia, msg.id, tenantId, tenantSlug]);

  if (mediaType === "image") {
    if (loading) return <p className="text-xs text-[#5B6670]">Cargando imagen...</p>;
    if (error || !blobUrl) return <p className="text-xs text-[#5B6670]">Imagen no disponible</p>;
    return <img src={blobUrl} alt="WhatsApp media" className="max-h-72 rounded-xl border border-[#00BFAE]/20 object-contain" />;
  }

  if (mediaType === "audio") {
    return (
      <div className="space-y-1.5">
        {loading && <p className="text-xs text-[#5B6670]">Cargando audio...</p>}
        {!loading && blobUrl && <audio controls src={blobUrl} className="max-w-full" preload="metadata" />}
        {!loading && !blobUrl && <p className="text-xs text-[#5B6670]">Audio no disponible</p>}
        {transcript?.status === "processing" && (
          <p className="text-xs text-[#5B6670]">Transcribiendo audio...</p>
        )}
        {transcript?.text && (
          <p className="text-xs text-[#0D2B3E] whitespace-pre-wrap">{transcript.text}</p>
        )}
        {transcript?.status === "failed" && (
          <div className="space-y-1">
            <p className="text-xs text-[#5B6670]">No se pudo transcribir este audio</p>
            {transcript.error && (
              <p className="text-[11px] text-[#5B6670]/90 whitespace-pre-wrap">
                Motivo: {transcript.error}
              </p>
            )}
          </div>
        )}
      </div>
    );
  }

  if (mediaType === "document") {
    if (loading) return <p className="text-xs text-[#5B6670]">Cargando documento...</p>;
    if (error || !blobUrl) return <p className="text-xs text-[#5B6670]">Documento no disponible</p>;
    return (
      <a href={blobUrl} target="_blank" rel="noreferrer" className="text-xs text-[#00BFAE] hover:underline">
        Abrir documento
      </a>
    );
  }

  return <p className="whitespace-pre-wrap">{extractText(msg)}</p>;
}

// ── Socket indicator ──────────────────────────────────────────────────────────

function SocketIndicator({ tenantId }: { tenantId: string | null }) {
  const t = useTranslations("conversaciones");
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!tenantId) return;
    const s = getSocket(tenantId);
    const onConnect = () => setConnected(true);
    const onDisconnect = () => setConnected(false);
    setConnected(s.connected);
    s.on("connect", onConnect);
    s.on("disconnect", onDisconnect);
    return () => {
      s.off("connect", onConnect);
      s.off("disconnect", onDisconnect);
    };
  }, [tenantId]);

  return (
    <span
      title={connected ? t("socket.connectedTitle") : t("socket.disconnectedTitle")}
      className={cn(
        "flex items-center gap-1 text-xs px-2 py-0.5 rounded-full",
        connected
          ? "bg-[#00BFAE]/18 text-[#00BFAE] border border-[#00BFAE]/24"
          : "bg-[#F4F7F9]/60 text-[#5B6670] border border-[#00BFAE]/14"
      )}
    >
      {connected ? <Wifi size={12} /> : <WifiOff size={12} />}
      {connected ? t("socket.live") : t("socket.offline")}
    </span>
  );
}

// ── ConvHistoryCard ────────────────────────────────────────────────────────────

const EVENT_COLORS: Record<string, string> = {
  conversation_started:  "text-[#00BFAE] bg-[#00BFAE]/14 border-[#00BFAE]/24",
  message_sent:          "text-[#6EE8FF] bg-[#F4F7F9]/78 border-[#00BFAE]/22",
  user_input:            "text-[#B9D3DD] bg-[#F4F7F9]/65 border-[#00BFAE]/18",
  condition_evaluated:   "text-[#8FC3FF] bg-[#F4F7F9]/72 border-[#8FC3FF]/22",
  api_call:              "text-[#FFC16A] bg-[#F4F7F9]/72 border-[#FFC16A]/22",
  api_response:          "text-[#00BFAE] bg-[#F4F7F9]/75 border-[#00BFAE]/24",
  api_retry:             "text-[#FFE18D] bg-[#F4F7F9]/72 border-[#FFE18D]/24",
  flow_error:            "text-red-600 bg-red-50 border-red-200",
  task_status_change:    "text-[#FFE18D] bg-[#F4F7F9]/72 border-[#FFE18D]/22",
  conversation_ended:    "text-[#5B6670] bg-[#F4F7F9]/62 border-[#00BFAE]/15",
};

function groupApiTraces(conversationId: string, events: ConvEvent[]): ApiTraceSummary[] {
  const byCall = new Map<string, ApiTraceSummary>();

  for (const ev of events) {
    const payload = (ev.payload ?? {}) as Record<string, unknown>;
    const callId = String(payload.call_id ?? payload.callId ?? "").trim();
    if (!callId) continue;

    const existing = byCall.get(callId) ?? {
      callId,
      conversationId,
      startedAt: ev.createdAt,
      endedAt: ev.createdAt,
      durationMs: null,
      method: (payload.method as string) ?? null,
      endpoint: (payload.endpoint as string) ?? null,
      integrationRef: (payload.integration_ref as string) ?? (payload.integrationRef as string) ?? null,
      attempts: 0,
      retries: 0,
      statusCode: null,
      hasError: false,
      lastError: null,
      nodes: [],
    };

    if (new Date(ev.createdAt).getTime() < new Date(existing.startedAt).getTime()) {
      existing.startedAt = ev.createdAt;
    }
    if (new Date(ev.createdAt).getTime() > new Date(existing.endedAt).getTime()) {
      existing.endedAt = ev.createdAt;
    }

    if (ev.nodeRef && !existing.nodes.includes(ev.nodeRef)) {
      existing.nodes.push(ev.nodeRef);
    }

    if (ev.eventType === "api_call") {
      const attempt = Number(payload.attempt ?? 0);
      if (Number.isFinite(attempt)) {
        existing.attempts = Math.max(existing.attempts, Math.max(1, attempt));
      }
      existing.method = existing.method ?? ((payload.method as string) ?? null);
      existing.endpoint = existing.endpoint ?? ((payload.endpoint as string) ?? null);
      existing.integrationRef = existing.integrationRef ?? ((payload.integration_ref as string) ?? (payload.integrationRef as string) ?? null);
    }

    if (ev.eventType === "api_retry") {
      existing.retries += 1;
    }

    if (ev.eventType === "api_response") {
      const statusCode = Number(payload.status_code ?? payload.statusCode ?? 0);
      if (Number.isFinite(statusCode) && statusCode > 0) {
        existing.statusCode = statusCode;
      }
      const duration = Number(payload.duration_ms ?? payload.durationMs ?? 0);
      if (Number.isFinite(duration) && duration > 0) {
        existing.durationMs = duration;
      }
      const attempt = Number(payload.attempt ?? 0);
      if (Number.isFinite(attempt)) {
        existing.attempts = Math.max(existing.attempts, Math.max(1, attempt));
      }
    }

    if (ev.eventType === "flow_error") {
      existing.hasError = true;
      existing.lastError =
        (payload.error_message as string) ??
        (payload.message as string) ??
        existing.lastError;
      const statusCode = Number(payload.status_code ?? payload.statusCode ?? 0);
      if (Number.isFinite(statusCode) && statusCode > 0) {
        existing.statusCode = statusCode;
      }
      const duration = Number(payload.duration_ms ?? payload.durationMs ?? 0);
      if (Number.isFinite(duration) && duration > 0) {
        existing.durationMs = duration;
      }
      const attempt = Number(payload.attempt ?? 0);
      if (Number.isFinite(attempt)) {
        existing.attempts = Math.max(existing.attempts, Math.max(1, attempt));
      }
    }

    byCall.set(callId, existing);
  }

  return Array.from(byCall.values()).sort(
    (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
  );
}

function ApiTracePanel({
  conversationId,
  tenantSlug,
}: {
  conversationId: string;
  tenantSlug?: string | null;
}) {
  const [callIdFilter, setCallIdFilter] = useState("");
  const [integrationRefFilter, setIntegrationRefFilter] = useState("");
  const [onlyErrors, setOnlyErrors] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["apiTraces", conversationId, tenantSlug, callIdFilter, integrationRefFilter],
    queryFn: () =>
      conversationsApi
        .getEvents(conversationId, {
          tenantSlug: tenantSlug ?? undefined,
          eventType: "api_call,api_response,api_retry,flow_error",
          callId: callIdFilter.trim() || undefined,
          integrationRef: integrationRefFilter.trim() || undefined,
          limit: 500,
        })
        .then((r) => r.data),
    enabled: Boolean(conversationId),
    staleTime: 15_000,
  });

  const events: ConvEvent[] = (data as { data?: ConvEvent[] })?.data ?? (Array.isArray(data) ? data : []);

  const traces = useMemo(() => {
    const grouped = groupApiTraces(conversationId, events);
    if (!onlyErrors) return grouped;
    return grouped.filter((trace) => trace.hasError || (trace.statusCode != null && trace.statusCode >= 400));
  }, [conversationId, events, onlyErrors]);

  return (
    <div className="p-3 bg-white rounded-2xl border border-[#D9E5EB] shadow-sm space-y-2.5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-semibold text-[#0D2B3E] uppercase tracking-[0.12em]">API Traces</p>
        <span className="text-[10px] text-[#5B6670]">{traces.length} llamadas</span>
      </div>

      <div className="grid grid-cols-1 gap-2">
        <input
          value={callIdFilter}
          onChange={(e) => setCallIdFilter(e.target.value)}
          placeholder="Filtrar por call_id"
          className="w-full text-xs bg-white border border-[#D9E5EB] rounded-lg px-2 py-1.5 text-[#0D2B3E] placeholder:text-[#5B6670] focus:outline-none focus:ring-2 focus:ring-[#00BFAE]/25"
        />
        <input
          value={integrationRefFilter}
          onChange={(e) => setIntegrationRefFilter(e.target.value)}
          placeholder="Filtrar por integration_ref"
          className="w-full text-xs bg-white border border-[#D9E5EB] rounded-lg px-2 py-1.5 text-[#0D2B3E] placeholder:text-[#5B6670] focus:outline-none focus:ring-2 focus:ring-[#00BFAE]/25"
        />
        <label className="inline-flex items-center gap-1.5 text-xs text-[#5B6670]">
          <input
            type="checkbox"
            checked={onlyErrors}
            onChange={(e) => setOnlyErrors(e.target.checked)}
            className="accent-[#00BFAE]"
          />
          Solo errores
        </label>
      </div>

      <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
        {isLoading && (
          <div className="space-y-2">
            {[1, 2].map((i) => (
              <div key={i} className="h-16 animate-pulse bg-[#F4F7F9] rounded-xl" />
            ))}
          </div>
        )}

        {!isLoading && traces.length === 0 && (
          <p className="text-xs text-[#5B6670] text-center py-4">No hay trazas API con esos filtros.</p>
        )}

        {traces.map((trace) => {
          const isError = trace.hasError || (trace.statusCode != null && trace.statusCode >= 400);
          return (
            <div key={trace.callId} className="p-2.5 rounded-xl border border-[#D9E5EB] bg-[#F8FBFD] space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className={cn(
                  "text-[10px] font-semibold px-1.5 py-0.5 rounded-full",
                  isError ? "bg-red-50 text-red-600" : "bg-[#00BFAE]/16 text-[#00BFAE]"
                )}>
                  {isError ? "ERROR" : "OK"}
                </span>
                <span className="text-[10px] text-[#5B6670]">{new Date(trace.startedAt).toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
              </div>
              <p className="text-xs font-medium text-[#0D2B3E] break-all">{trace.method ?? "HTTP"} {trace.endpoint ?? "(sin endpoint)"}</p>
              <p className="text-[11px] text-[#5B6670] break-all">call_id: {trace.callId}</p>
              <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-[#5B6670]">
                <span className="px-1.5 py-0.5 rounded bg-white border border-[#D9E5EB]">status {trace.statusCode ?? "-"}</span>
                <span className="px-1.5 py-0.5 rounded bg-white border border-[#D9E5EB]">dur {trace.durationMs != null ? `${trace.durationMs}ms` : "-"}</span>
                <span className="px-1.5 py-0.5 rounded bg-white border border-[#D9E5EB]">intentos {trace.attempts || 1}</span>
                <span className="px-1.5 py-0.5 rounded bg-white border border-[#D9E5EB]">retries {trace.retries}</span>
              </div>
              {trace.integrationRef && (
                <p className="text-[10px] text-[#5B6670] break-all">integration_ref: {trace.integrationRef}</p>
              )}
              {trace.nodes.length > 0 && (
                <p className="text-[10px] text-[#5B6670] break-all">node_ref: {trace.nodes.join(", ")}</p>
              )}
              {trace.lastError && (
                <p className="text-[10px] text-red-600 break-words">{trace.lastError}</p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ConvHistoryCard({ conv }: { conv: ConvRecord }) {
  const t = useTranslations("conversaciones");
  const eventLabels: Record<string, string> = {
    conversation_started: t("eventLabels.conversation_started"),
    message_sent: t("eventLabels.message_sent"),
    user_input: t("eventLabels.user_input"),
    condition_evaluated: t("eventLabels.condition_evaluated"),
    api_call: t("eventLabels.api_call"),
    api_response: "API Response",
    api_retry: "API Retry",
    flow_error: "Flow Error",
    task_status_change: t("eventLabels.task_status_change"),
    conversation_ended: t("eventLabels.conversation_ended"),
  };
  const [open, setOpen] = useState(false);
  const { data: eventsData } = useQuery({
    queryKey: ["convEvents", conv.id],
    queryFn: () => conversationsApi.getEvents(conv.id, { limit: 200 }).then((r) => r.data),
    enabled: open,
    staleTime: 60_000,
  });
  const events: ConvEvent[] = (eventsData as { data?: ConvEvent[] })?.data ?? (Array.isArray(eventsData) ? eventsData : []);

  const statusColor =
    conv.status === "active"     ? "text-[#00BFAE] bg-[#00BFAE]/16"  :
    conv.status === "completed"  ? "text-[#5B6670] bg-[#F4F7F9]/70" :
    conv.status === "abandoned"  ? "text-[#FFE18D] bg-[#F4F7F9]/74":
    "text-red-600 bg-red-50";

  return (
    <div className="border border-[#00BFAE]/18 rounded-xl overflow-hidden bg-[#F4F7F9]/36">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-start gap-2 p-2.5 text-left hover:bg-[#F4F7F9]/68 transition"
      >
        <GitBranch size={13} className="mt-0.5 text-[#00BFAE] shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-medium text-[#0D2B3E] truncate">
              {conv.flow?.nombre ?? t("historialTab.unknownFlow")}
            </span>
            <span className={cn("text-[10px] font-semibold px-1.5 py-0.5 rounded-full shrink-0", statusColor)}>
              {conv.status}
            </span>
          </div>
          <p className="text-[11px] text-[#5B6670] mt-0.5">
            {new Date(conv.startedAt).toLocaleString("es", { dateStyle: "short", timeStyle: "short" })}
          </p>
        </div>
        <ChevronDown size={13} className={cn("text-[#5B6670] shrink-0 transition-transform mt-0.5", open && "rotate-180")} />
      </button>

      {open && (
        <div className="border-t border-[#00BFAE]/12 divide-y divide-[#00BFAE]/8">
          {events.length === 0 && (
            <p className="text-xs text-[#5B6670] px-3 py-3 text-center">{t("historialTab.noEvents")}</p>
          )}
          {events.map((ev) => {
            const color = EVENT_COLORS[ev.eventType] ?? "text-[#5B6670] bg-[#F4F7F9]/60 border-[#00BFAE]/12";
            const label = eventLabels[ev.eventType] ?? ev.eventType;
            const payload = ev.payload as Record<string, unknown>;
            const callId = (payload.call_id as string) ?? (payload.callId as string) ?? null;
            const statusCode = payload.status_code;
            const durationMs = payload.duration_ms;
            const endpoint = (payload.endpoint as string) ?? null;
            const method = (payload.method as string) ?? null;
            const detail =
              (callId ? `call_id=${callId}` : null) ??
              (statusCode ? `status=${String(statusCode)}` : null) ??
              (typeof durationMs === "number" ? `${durationMs} ms` : null) ??
              (endpoint && method ? `${method} ${endpoint}` : null) ??
              (payload.content as string) ??
              (payload.input as string) ??
              (payload.error_message as string) ??
              (payload.toStatus ? `→ ${payload.toStatus}` : null) ??
              null;
            return (
              <div key={ev.id} className="flex items-start gap-2 px-3 py-2">
                <Zap size={11} className="mt-0.5 text-[#00BFAE]/60 shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className={cn("text-[10px] font-semibold px-1.5 py-px rounded border", color)}>
                      {label}
                    </span>
                    {ev.nodeRef && (
                      <span className="text-[10px] text-[#5B6670] truncate">{ev.nodeRef}</span>
                    )}
                  </div>
                  {detail && (
                    <p className="text-[11px] text-[#5B6670] mt-0.5 truncate">{detail}</p>
                  )}
                  <p className="text-[10px] text-[#7A8792] mt-0.5">
                    {new Date(ev.createdAt).toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function ConversacionesPage() {
  const t = useTranslations("conversaciones");
  const solicitudStatusLabels: Record<string, string> = {
    open: t("statusLabels.open"),
    in_progress: t("statusLabels.in_progress"),
    pending_info: t("statusLabels.pending_info"),
    completed: t("statusLabels.completed"),
    rejected: t("statusLabels.rejected"),
  };
  const { tenantSlug, setTenantSlug, superAdmin } = useAuthStore();
  const qc = useQueryClient();
  const router = useRouter();
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const [activeThread, setActiveThread] = useState<Thread | null>(null);
  const [input, setInput] = useState("");
  const [search, setSearch] = useState("");
  const [msgPage, setMsgPage] = useState(1);
  const [olderMessages, setOlderMessages] = useState<Mensaje[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);

  // Context panel state
  const [contextTab, setContextTab] = useState<"solicitudes" | "agentes" | "notas" | "historial">("solicitudes");
  const [nota, setNota] = useState("");
  const [savedNota, setSavedNota] = useState("");
  const [showEscalarForm, setShowEscalarForm] = useState(false);
  const [escalarAgenteId, setEscalarAgenteId] = useState<number | "">("");
  const [escalandoId, setEscalandoId] = useState<number | null>(null);
  const [traceConversationId, setTraceConversationId] = useState("");

  // Resolve tenantId (UUID) from slug
  const { data: tenantData, isLoading: tenantLoading } = useQuery({
    queryKey: ["tenant", tenantSlug],
    queryFn: () =>
      import("@/lib/api").then(({ apiClient }) =>
        apiClient.get(`/admin/tenants/${tenantSlug}`).then((r) => r.data).catch(() => null)
      ),
    enabled: !!tenantSlug,
    staleTime: Infinity,
  });

  const { data: tenantsData } = useQuery({
    queryKey: ["tenants", "conversaciones-fallback"],
    queryFn: () => import("@/lib/api").then(({ tenantApi }) => tenantApi.list().then((r) => r.data)),
    staleTime: 60_000,
  });

  const tenants = Array.isArray(tenantsData) ? tenantsData : [];
  const fallbackTenant = tenants[0] ?? null;
  const shouldUseFallback = Boolean(tenantSlug && !tenantLoading && !tenantData && fallbackTenant?.slug);
  const effectiveTenantSlug = tenantData?.slug ?? (shouldUseFallback ? fallbackTenant?.slug : tenantSlug);
  const tenantId: string | null = tenantData?.id ?? (shouldUseFallback ? fallbackTenant?.id : null);

  useEffect(() => {
    if (!tenantSlug && fallbackTenant?.slug) {
      setTenantSlug(fallbackTenant.slug);
      return;
    }
    if (shouldUseFallback && effectiveTenantSlug && tenantSlug !== effectiveTenantSlug) {
      setTenantSlug(effectiveTenantSlug);
    }
  }, [tenantSlug, fallbackTenant?.slug, shouldUseFallback, effectiveTenantSlug, setTenantSlug]);

  // Subscribe to WA real-time events — keeps cache up to date
  useWaSocket(tenantId);

  // Conversation thread list
  const { data: threadsData, isLoading: threadsLoading } = useQuery({
    queryKey: ["conversaciones", effectiveTenantSlug, tenantId],
    queryFn: () =>
      whatsappApi
        .listConversaciones({ tenantSlug: effectiveTenantSlug ?? undefined, tenantId: tenantId ?? undefined })
        .then((r) => r.data),
    enabled: !!effectiveTenantSlug || !!tenantId,
    staleTime: 30_000,
  });
  const threads: Thread[] = threadsData?.data ?? [];

  // For superadmins, if current tenant is empty, find a tenant that has conversations.
  const { data: tenantWithThreads, isLoading: tenantWithThreadsLoading } = useQuery({
    queryKey: ["conversaciones-tenant-fallback", tenantSlug, threads.length, tenants.map((t: { slug?: string }) => t.slug).join(",")],
    queryFn: async () => {
      const candidates = tenants.filter(
        (t: { slug?: string; id?: string }) => t?.slug && t.slug !== effectiveTenantSlug
      );
      for (const tenant of candidates) {
        const res = await whatsappApi.listConversaciones({
          tenantSlug: tenant.slug,
          tenantId: tenant.id,
        });
        const count = Array.isArray(res.data?.data) ? res.data.data.length : 0;
        if (count > 0) {
          return tenant.slug as string;
        }
      }
      return null;
    },
    enabled:
      superAdmin &&
      !threadsLoading &&
      threads.length === 0 &&
      tenants.length > 1 &&
      !!effectiveTenantSlug,
    staleTime: 30_000,
  });

  useEffect(() => {
    if (tenantWithThreads && tenantWithThreads !== tenantSlug) {
      setTenantSlug(tenantWithThreads);
    }
  }, [tenantWithThreads, tenantSlug, setTenantSlug]);

  const isResolvingTenantWithThreads =
    superAdmin &&
    !threadsLoading &&
    threads.length === 0 &&
    tenants.length > 1 &&
    !!effectiveTenantSlug &&
    tenantWithThreadsLoading;

  // Messages for active thread
  const { data: mensajesData, isLoading: mensajesLoading } = useQuery({
    queryKey: ["mensajes", effectiveTenantSlug, tenantId, activeThread?.userId],
    queryFn: () =>
      whatsappApi
        .listMensajes({ tenantSlug: effectiveTenantSlug ?? undefined, tenantId: tenantId ?? undefined, userId: activeThread!.userId!, page: 1, limit: 100 })
        .then((r) => {
        setHasMore((r.data?.count ?? r.data?.data?.length ?? 0) >= 100);
        setOlderMessages([]);
        setMsgPage(1);
        return r.data;
      }),
    enabled: (!!effectiveTenantSlug || !!tenantId) && !!activeThread?.userId,
    staleTime: 0,
  });
  // Backend returns newest-first (desc). No reverse — display newest at top.
  const latestMessages: Mensaje[] = mensajesData?.data ?? [];
  const messages: Mensaje[] = [...latestMessages, ...olderMessages];

  async function loadMoreMessages() {
    if ((!effectiveTenantSlug && !tenantId) || !activeThread?.userId || loadingMore) return;
    setLoadingMore(true);
    try {
      const nextPage = msgPage + 1;
      const r = await whatsappApi.listMensajes({
        tenantSlug: effectiveTenantSlug ?? undefined,
        tenantId: tenantId ?? undefined,
        userId: activeThread.userId,
        page: nextPage,
        limit: 100,
      });
      const older: Mensaje[] = r.data?.data ?? [];
      setOlderMessages((prev) => [...prev, ...older]);
      setMsgPage(nextPage);
      setHasMore((r.data?.count ?? older.length) >= 100);
    } finally {
      setLoadingMore(false);
    }
  }

  // Solicitudes for active contact
  const { data: solicitudesData, isLoading: solicitudesLoading, refetch: refetchSolicitudes } = useQuery({
    queryKey: ["solicitudesContacto", effectiveTenantSlug, activeThread?.userId],
    queryFn: () =>
      solicitudesApi.list(effectiveTenantSlug!, { userId: activeThread!.userId, limit: 10 }).then((r) => r.data),
    enabled: !!effectiveTenantSlug && !!activeThread?.userId,
    staleTime: 30_000,
  });
  const solicitudes: Solicitud[] = Array.isArray(solicitudesData) ? solicitudesData : (solicitudesData?.data ?? []);

  // Agentes list (for escalation picker)
  const { data: agentesData } = useQuery({
    queryKey: ["agentes", effectiveTenantSlug],
    queryFn: () => agentesApi.list(effectiveTenantSlug!).then((r) => r.data),
    enabled: !!effectiveTenantSlug,
    staleTime: 60_000,
  });
  const agentes: Agente[] = Array.isArray(agentesData) ? agentesData : (agentesData?.data ?? []);

  // Conversation history from event-sourced model
  const { data: convHistoryData } = useQuery({
    queryKey: ["convHistory", tenantId, activeThread?.user?.phone],
    queryFn: () =>
      conversationsApi.list({ tenantSlug: effectiveTenantSlug ?? undefined, userKey: activeThread!.user!.phone!, limit: 10 }).then((r) => r.data),
    enabled: !!tenantId && !!activeThread?.user?.phone && contextTab === "historial",
    staleTime: 30_000,
  });
  const convHistory: ConvRecord[] = (convHistoryData as { data?: ConvRecord[] })?.data ?? (Array.isArray(convHistoryData) ? convHistoryData : []);
  const activeConversation = convHistory.find((conv) => conv.status === "active") ?? null;

  useEffect(() => {
    if (contextTab !== "historial") return;
    if (convHistory.length === 0) {
      setTraceConversationId("");
      return;
    }
    const stillExists = convHistory.some((conv) => conv.id === traceConversationId);
    if (!stillExists) {
      setTraceConversationId(activeConversation?.id ?? convHistory[0].id);
    }
  }, [contextTab, convHistory, traceConversationId, activeConversation?.id]);

  const closeConversationMutation = useMutation({
    mutationFn: (conversationId: string) => conversationsApi.updateStatus(conversationId, "completed"),
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["convHistory", tenantId, activeThread?.user?.phone] }),
        qc.invalidateQueries({ queryKey: ["conversaciones", effectiveTenantSlug, tenantId] }),
      ]);
    },
  });

  // Scroll to top on new messages (newest first display)
  useEffect(() => {
    if (messages.length > 0) {
      const container = messagesEndRef.current?.parentElement;
      if (container) container.scrollTop = 0;
    }
  }, [activeThread?.userId]);

  // Send outbound message
  const sendMutation = useMutation({
    mutationFn: (text: string) =>
      whatsappApi.send(tenantId!, activeThread!.user!.phone!, text),
    onMutate: async (text) => {
      const optimistic: Mensaje = {
        id: Date.now(),
        userId: activeThread?.userId ?? null,
        waMsgId: null,
        direccion: "salida",
        tipo: "text",
        contenido: { text },
        createdAt: new Date().toISOString(),
      };
      qc.setQueryData(
        ["mensajes", tenantId, activeThread?.userId],
        (old: { data: Mensaje[] } | undefined) =>
          old ? { data: [...old.data, optimistic] } : { data: [optimistic] }
      );
      return { optimistic };
    },
    onError: (_err, _vars, ctx) => {
      qc.setQueryData(
        ["mensajes", tenantId, activeThread?.userId],
        (old: { data: Mensaje[] } | undefined) =>
          old ? { data: old.data.filter((m) => m.id !== ctx?.optimistic.id) } : old
      );
    },
  });

  function handleSend() {
    const text = input.trim();
    if (!text || !activeThread?.user?.phone) return;
    setInput("");
    sendMutation.mutate(text);
  }

  // Escalate: create solicitud and assign to agente
  async function handleEscalar() {
    if (!effectiveTenantSlug || !activeThread?.userId || !escalarAgenteId) return;
    try {
      const r = await solicitudesApi.create(effectiveTenantSlug, {
        userId: activeThread.userId,
        nombre: activeThread._contactName ?? undefined,
        telefonoContacto: activeThread.user?.phone ?? undefined,
        estado: "open",
      });
      const newId: number = r.data?.id;
      if (newId && escalarAgenteId) {
        setEscalandoId(newId);
        await solicitudesApi.assignAgente(effectiveTenantSlug, newId, Number(escalarAgenteId));
        setEscalandoId(null);
      }
      setShowEscalarForm(false);
      setEscalarAgenteId("");
      refetchSolicitudes();
    } catch {
      setEscalandoId(null);
    }
  }

  // Marcar urgente: create solicitud with canonical in_progress status
  async function handleMarcarUrgente() {
    if (!effectiveTenantSlug || !activeThread?.userId) return;
    await solicitudesApi.create(effectiveTenantSlug, {
      userId: activeThread.userId,
      nombre: activeThread._contactName ?? undefined,
      telefonoContacto: activeThread.user?.phone ?? undefined,
      estado: "in_progress",
    });
    refetchSolicitudes();
  }

  // Update solicitud estado
  const updateEstadoMutation = useMutation({
    mutationFn: ({ id, estado }: { id: number; estado: string }) =>
      solicitudesApi.updateEstado(effectiveTenantSlug!, id, estado),
    onSuccess: () => refetchSolicitudes(),
  });

  const filtered = threads.filter((t) =>
    getDisplayName(t).toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="zentra-chat-shell zentra-soft-grid flex gap-0 h-[calc(100vh-7rem)] rounded-3xl overflow-hidden">

      {/* ── Thread list ── */}
      <div className="w-80 shrink-0 border-r border-[#D9E5EB] flex flex-col bg-white/90 backdrop-blur-sm">
        <div className="p-4 border-b border-[#D9E5EB] space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-semibold text-[#5B6670] uppercase tracking-[0.18em]">
              {t("header")}
            </span>
            <SocketIndicator tenantId={tenantId} />
          </div>
          <div className="relative">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#5B6670]" />
            <input
              placeholder={t("searchPlaceholder")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-9 pr-3 py-2.5 rounded-2xl bg-white border border-[#D9E5EB] text-[#0D2B3E] placeholder:text-[#5B6670] text-sm focus:outline-none focus:ring-2 focus:ring-[#00BFAE]/25"
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {(threadsLoading || isResolvingTenantWithThreads) && (
            <div className="flex flex-col gap-2 p-4">
              {[1, 2, 3].map((i) => (
                  <div key={i} className="animate-pulse flex gap-3 p-2">
                  <div className="w-10 h-10 rounded-full bg-[#D9E5EB] shrink-0" />
                  <div className="flex-1 space-y-2 py-1">
                    <div className="h-3 bg-[#D9E5EB] rounded w-3/4" />
                    <div className="h-2 bg-[#E9F0F4] rounded w-full" />
                  </div>
                </div>
              ))}
            </div>
          )}

          {!threadsLoading && !isResolvingTenantWithThreads && filtered.length === 0 && (
            <div className="flex flex-col items-center justify-center h-40 text-[#5B6670] text-sm gap-2 px-4 text-center">
              <p>{t("emptyList")}</p>
              <p className="text-xs text-[#7A8792]">
                {t("emptyListSub")}
              </p>
            </div>
          )}

          {filtered.map((thread) => {
            const name = getDisplayName(thread);
            const lastText = extractText({ tipo: thread.tipo, contenido: thread.contenido });
            const isActive = activeThread?.id === thread.id;

            return (
              <button
                key={thread.id}
                onClick={() => {
                  setActiveThread(thread);
                  setOlderMessages([]);
                  setMsgPage(1);
                  setHasMore(false);
                }}
                className={cn(
                  "w-full flex items-start gap-3 px-4 py-3.5 hover:bg-[#F4F7F9] transition text-left border-b border-[#E7EEF2]",
                  isActive && "bg-[#EEF9F7] hover:bg-[#EEF9F7]"
                )}
              >
                <div className="w-10 h-10 rounded-full bg-[#0D2B3E] border border-[#00BFAE]/16 flex items-center justify-center text-white font-semibold text-sm shrink-0">
                  {name.charAt(0).toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between">
                    <span className={cn("text-sm font-semibold truncate", isActive ? "text-[#00BFAE]" : "text-[#0D2B3E]")}>
                      {name}
                    </span>
                    <span className="text-xs text-[#7D9AA8] shrink-0 ml-2">
                      {formatDate(thread.createdAt)}
                    </span>
                  </div>
                  <p className="text-xs text-[#5B6670] truncate mt-0.5">{lastText}</p>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Active conversation ── */}
      {!activeThread ? (
        <div className="flex-1 flex flex-col items-center justify-center text-[#5B6670] gap-3">
          <div className="w-16 h-16 rounded-2xl bg-white border border-[#D9E5EB] flex items-center justify-center shadow-sm">
            <MessageCircle size={28} className="text-[#00BFAE]" />
          </div>
          <p className="font-medium text-[#0D2B3E]">{t("selectConversation")}</p>
          <p className="text-sm text-[#5B6670]">{t("selectConversationSub")}</p>
        </div>
      ) : (
        <div className="flex-1 flex flex-col min-w-0">
          {/* Header */}
          <div className="h-16 px-5 border-b border-[#D9E5EB] flex items-center bg-white/85 backdrop-blur-sm">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-full bg-[#0D2B3E] border border-[#00BFAE]/16 flex items-center justify-center text-white font-semibold text-sm">
                {getDisplayName(activeThread).charAt(0).toUpperCase()}
              </div>
              <div>
                <p className="font-semibold text-[#0D2B3E] text-sm">{getDisplayName(activeThread)}</p>
                <p className="text-xs text-[#5B6670]">{activeThread.user?.phone ?? ""}</p>
              </div>
            </div>
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto p-5 space-y-3 bg-gradient-to-b from-[#FFFFFF] to-[#F8FBFD]">
            {mensajesLoading && (
              <div className="flex flex-col gap-3">
                {[1, 2, 3].map((i) => (
                  <div key={i} className={cn("animate-pulse flex", i % 2 === 0 ? "justify-end" : "justify-start")}>
                    <div className="h-10 w-48 bg-[#E7EEF2] rounded-2xl" />
                  </div>
                ))}
              </div>
            )}

            {!mensajesLoading && messages.length === 0 && (
              <div className="flex items-center justify-center h-32 text-[#5B6670] text-sm">
                {t("noMessages")}
              </div>
            )}

            {messages.map((msg) => {
              const isOutbound = msg.direccion === "salida";
              return (
                <div key={msg.id} className={cn("flex", isOutbound ? "justify-end" : "justify-start")}>
                  <div
                    className={cn(
                      "max-w-xs lg:max-w-md px-4 py-2.5 rounded-2xl text-sm shadow-sm border",
                      isOutbound
                        ? "bg-gradient-to-br from-[#00BFAE] to-[#39E6D2] border-[#00BFAE]/25 text-[#063743] rounded-tr-sm"
                        : "bg-white text-[#0D2B3E] rounded-tl-sm border-[#D9E5EB]"
                    )}
                  >
                    <MessageMediaContent
                      msg={msg}
                      tenantId={tenantId}
                      tenantSlug={effectiveTenantSlug ?? null}
                    />
                    <p className={cn("text-xs mt-1", isOutbound ? "text-[#065E67]" : "text-[#5B6670]")}>
                      {new Date(msg.createdAt).toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" })}
                    </p>
                  </div>
                </div>
              );
            })}
            {!mensajesLoading && hasMore && (
              <div className="flex justify-center pt-2">
                <button
                  onClick={loadMoreMessages}
                  disabled={loadingMore}
                  className="text-xs text-[#00BFAE] hover:text-[#0D2B3E] bg-white hover:bg-[#EEF9F7] px-4 py-1.5 rounded-full border border-[#D9E5EB] transition disabled:opacity-50"
                >
                  {loadingMore ? t("loading") : t("loadMore")}
                </button>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* Input */}
          <div className="px-4 py-3 bg-white/85 border-t border-[#D9E5EB] backdrop-blur-sm">
            {!activeThread.user?.phone ? (
              <p className="text-xs text-[#5B6670] text-center py-1">
                {t("noPhone")}
              </p>
            ) : (
              <div className="flex items-center gap-3">
                <input
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleSend()}
                  placeholder={t("inputPlaceholder")}
                  disabled={sendMutation.isPending}
                  className="flex-1 px-4 py-2.5 rounded-xl bg-white border border-[#D9E5EB] text-[#0D2B3E] placeholder:text-[#5B6670] text-sm focus:outline-none focus:ring-2 focus:ring-[#00BFAE]/25 disabled:opacity-60"
                />
                <button
                  onClick={handleSend}
                  disabled={!input.trim() || sendMutation.isPending}
                  className="w-10 h-10 rounded-xl bg-gradient-to-br from-[#00BFAE] to-[#39E6D2] hover:brightness-105 text-[#063743] flex items-center justify-center transition disabled:opacity-50"
                >
                  <Send size={16} />
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Context panel ── */}
      {activeThread && (
        <div className="w-72 shrink-0 border-l border-[#D9E5EB] bg-white/92 flex-col overflow-hidden hidden lg:flex backdrop-blur-sm">
          {/* Contact header */}
          <div className="p-4 border-b border-[#D9E5EB]">
            <div className="flex flex-col items-center gap-2">
              <div className="w-12 h-12 rounded-full bg-[#0D2B3E] border border-[#00BFAE]/20 text-white flex items-center justify-center text-lg font-bold">
                {getDisplayName(activeThread).charAt(0).toUpperCase()}
              </div>
              <div className="text-center">
                <p className="font-semibold text-[#0D2B3E] text-sm">{getDisplayName(activeThread)}</p>
                {activeThread.user?.phone && (
                  <p className="text-xs text-[#5B6670] mt-0.5">{activeThread.user.phone}</p>
                )}
                {activeThread._contactName && (
                  <p className="text-xs text-[#5B6670] mt-1">{activeThread._contactName}</p>
                )}
              </div>
            </div>

            {/* Quick actions */}
            <div className="flex gap-2 mt-3">
              <button
                onClick={() => { setShowEscalarForm((v) => !v); setContextTab("solicitudes"); }}
                className="flex-1 flex items-center justify-center gap-1.5 text-xs font-medium bg-[#00BFAE]/15 hover:bg-[#00BFAE]/22 text-[#00BFAE] py-1.5 px-2 rounded-lg transition"
              >
                <UserCheck size={13} />
                {t("quickActions.escalate")}
              </button>
              <button
                onClick={handleMarcarUrgente}
                className="flex-1 flex items-center justify-center gap-1.5 text-xs font-medium bg-red-50 hover:bg-red-100 text-red-600 py-1.5 px-2 rounded-lg transition"
              >
                <AlertTriangle size={13} />
                {t("quickActions.urgent")}
              </button>
            </div>
            <div className="mt-2">
              <button
                onClick={() => {
                  if (!activeConversation) return;
                  closeConversationMutation.mutate(activeConversation.id);
                }}
                disabled={!activeConversation || closeConversationMutation.isPending}
                className="w-full flex items-center justify-center gap-1.5 text-xs font-medium bg-white hover:bg-[#F4F7F9] text-[#0D2B3E] py-1.5 px-2 rounded-lg border border-[#D9E5EB] transition disabled:opacity-50"
              >
                <X size={13} />
                {closeConversationMutation.isPending ? t("quickActions.closing") : t("quickActions.closeConversation")}
              </button>
              {!activeConversation && (
                <p className="mt-1 text-[11px] text-[#7A8792] text-center">
                  {t("quickActions.noActiveConversation")}
                </p>
              )}
            </div>

            {/* Escalation form */}
            {showEscalarForm && (
              <div className="mt-3 p-3 bg-white rounded-xl border border-[#D9E5EB] space-y-2 shadow-sm">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-semibold text-[#5B6670]">{t("escalationForm.title")}</p>
                  <button onClick={() => setShowEscalarForm(false)} className="text-[#5B6670] hover:text-[#0D2B3E]">
                    <X size={13} />
                  </button>
                </div>
                <div className="relative">
                  <select
                    value={escalarAgenteId}
                    onChange={(e) => setEscalarAgenteId(e.target.value ? Number(e.target.value) : "")}
                    className="w-full text-xs bg-white text-[#0D2B3E] border border-[#D9E5EB] rounded-lg px-2 py-1.5 pr-6 appearance-none focus:outline-none focus:ring-2 focus:ring-[#00BFAE]/25"
                  >
                    <option value="">{t("escalationForm.placeholder")}</option>
                    {agentes.map((a) => (
                      <option key={a.id} value={a.id}>{a.nombre}</option>
                    ))}
                  </select>
                  <ChevronDown size={12} className="absolute right-2 top-1/2 -translate-y-1/2 text-[#5B6670] pointer-events-none" />
                </div>
                <button
                  disabled={!escalarAgenteId || !!escalandoId}
                  onClick={handleEscalar}
                  className="w-full text-xs font-medium bg-gradient-to-r from-[#00BFAE] to-[#39E6D2] hover:brightness-105 text-[#063743] py-1.5 rounded-lg transition disabled:opacity-50"
                >
                  {escalandoId ? t("escalationForm.creating") : t("escalationForm.createAndAssign")}
                </button>
              </div>
            )}
          </div>

          {/* Tabs */}
          <div className="flex border-b border-[#D9E5EB] bg-white">
            {(["solicitudes", "agentes", "notas", "historial"] as const).map((tab) => {
              const icons = { solicitudes: ClipboardList, agentes: UserCheck, notas: StickyNote, historial: GitBranch };
              const labels = { solicitudes: t("tabs.solicitudes"), agentes: t("tabs.agentes"), notas: t("tabs.notas"), historial: t("tabs.historial") };
              const Icon = icons[tab];
              return (
                <button
                  key={tab}
                  onClick={() => setContextTab(tab)}
                  className={cn(
                    "flex-1 flex flex-col items-center gap-0.5 py-2 text-xs transition",
                    contextTab === tab
                      ? "text-[#00BFAE] border-b-2 border-[#00BFAE] font-medium bg-[#EEF9F7]"
                      : "text-[#5B6670] hover:text-[#0D2B3E] hover:bg-[#F4F7F9]"
                  )}
                >
                  <Icon size={13} />
                  {labels[tab]}
                </button>
              );
            })}
          </div>

          {/* Tab content */}
          <div className="flex-1 overflow-y-auto">
            {/* Solicitudes tab */}
            {contextTab === "solicitudes" && (
              <div className="p-3 space-y-2">
                {solicitudesLoading && (
                  <div className="space-y-2">
                    {[1, 2].map((i) => (
                      <div key={i} className="animate-pulse h-14 bg-[#E7EEF2] rounded-xl" />
                    ))}
                  </div>
                )}
                {!solicitudesLoading && solicitudes.length === 0 && (
                  <div className="flex flex-col items-center justify-center py-8 text-[#5B6670] text-xs text-center gap-2">
                    <ClipboardList size={24} className="text-[#4D7686]" />
                    <p>{t("solicitudesTab.empty")}</p>
                    <p className="text-[#7A8792]">{t("solicitudesTab.emptySub")}</p>
                  </div>
                )}
                {solicitudes.map((s) => (
                  <div key={s.id} className="p-2.5 bg-white rounded-xl border border-[#D9E5EB] space-y-1.5 shadow-sm">
                    <div className="flex items-start justify-between gap-1">
                      <p className="text-xs font-medium text-[#0D2B3E] truncate flex-1">
                        {s.nombre ?? `Solicitud #${s.id}`}
                      </p>
                      <span className={cn(
                        "text-[10px] font-semibold px-1.5 py-0.5 rounded-full shrink-0",
                        s.estado === "in_progress" ? "bg-red-50 text-red-600" :
                        s.estado === "completed" ? "bg-[#00BFAE]/18 text-[#00BFAE]" :
                        s.estado === "rejected" ? "bg-[#F4F7F9] text-[#5B6670]" :
                        "bg-[#FFF7E6] text-[#B26B00]"
                      )}>
                        {s.estado ? (solicitudStatusLabels[s.estado] ?? s.estado) : solicitudStatusLabels["open"]}
                      </span>
                    </div>
                    {s.agente && (
                      <p className="text-[11px] text-[#5B6670] flex items-center gap-1">
                        <UserCheck size={10} /> {s.agente.nombre}
                      </p>
                    )}
                    <div className="flex gap-1 items-center">
                      <button
                        onClick={() => router.push("/solicitudes")}
                        title="Ver en solicitudes"
                        className="text-[10px] text-[#00BFAE] hover:text-[#6FF5E8] flex items-center gap-0.5"
                      >
                        <ExternalLink size={9} />
                        {t("solicitudesTab.view")}
                      </button>
                      {s.estado !== "completed" && (
                        <button
                          onClick={() => updateEstadoMutation.mutate({ id: s.id, estado: "completed" })}
                          className="text-[10px] text-[#00BFAE] hover:underline ml-1"
                        >
                          {t("solicitudesTab.markAttended")}
                        </button>
                      )}
                      {s.estado !== "rejected" && (
                        <button
                          onClick={() => updateEstadoMutation.mutate({ id: s.id, estado: "rejected" })}
                          className="text-[10px] text-[#5B6670] hover:underline ml-auto"
                        >
                          {t("solicitudesTab.cancel")}
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Agentes tab */}
            {contextTab === "agentes" && (
              <div className="p-3 space-y-2">
                {agentes.length === 0 && (
                  <div className="flex flex-col items-center justify-center py-8 text-[#5B6670] text-xs text-center gap-2">
                    <UserCheck size={24} className="text-[#4D7686]" />
                    <p>{t("agentesTab.empty")}</p>
                  </div>
                )}
                {agentes.map((a) => (
                  <div key={a.id} className="flex items-center gap-2.5 p-2.5 bg-white rounded-xl border border-[#D9E5EB]">
                    <div className="w-7 h-7 rounded-full bg-[#0D2B3E] text-white border border-[#00BFAE]/18 flex items-center justify-center text-xs font-bold shrink-0">
                      {a.nombre.charAt(0).toUpperCase()}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium text-[#0D2B3E] truncate">{a.nombre}</p>
                      {a.estado && (
                        <p className={cn(
                          "text-[10px]",
                          a.estado === "online" ? "text-[#00BFAE]" : "text-[#5B6670]"
                        )}>
                          {a.estado}
                        </p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Notas tab */}
            {contextTab === "notas" && (
              <div className="p-3 space-y-2">
                {savedNota && (
                  <div className="p-2.5 bg-[#EEF9F7] border border-[#CDEFEA] rounded-xl">
                    <p className="text-xs text-[#0D2B3E] whitespace-pre-wrap">{savedNota}</p>
                  </div>
                )}
                <textarea
                  value={nota}
                  onChange={(e) => setNota(e.target.value)}
                  placeholder={t("notasTab.placeholder")}
                  rows={4}
                  className="w-full text-xs bg-white border border-[#D9E5EB] rounded-xl px-3 py-2 resize-none text-[#0D2B3E] placeholder:text-[#5B6670] focus:outline-none focus:ring-2 focus:ring-[#00BFAE]/25"
                />
                <button
                  onClick={() => { if (nota.trim()) { setSavedNota(nota.trim()); setNota(""); } }}
                  disabled={!nota.trim()}
                  className="w-full text-xs font-medium bg-gradient-to-r from-[#00BFAE] to-[#39E6D2] hover:brightness-105 text-[#063743] py-1.5 rounded-lg transition disabled:opacity-40"
                >
                  {t("notasTab.save")}
                </button>
              </div>
            )}

            {/* Historial del flujo tab */}
            {contextTab === "historial" && (
              <div className="p-3 space-y-3">
                {convHistory.length === 0 && (
                  <div className="flex flex-col items-center justify-center py-8 text-[#5B6670] text-xs text-center gap-2">
                    <GitBranch size={24} className="text-[#4D7686]" />
                    <p>{t("historialTab.empty")}</p>
                    <p className="text-[#7A8792]">{t("historialTab.emptySub")}</p>
                  </div>
                )}

                {convHistory.length > 0 && (
                  <div className="p-3 bg-white rounded-2xl border border-[#D9E5EB] shadow-sm space-y-2">
                    <p className="text-xs font-semibold text-[#5B6670] uppercase tracking-[0.12em]">Conversation Trace</p>
                    <div className="relative">
                      <select
                        value={traceConversationId || (activeConversation?.id ?? convHistory[0].id)}
                        onChange={(e) => setTraceConversationId(e.target.value)}
                        className="w-full text-xs bg-white text-[#0D2B3E] border border-[#D9E5EB] rounded-lg px-2 py-1.5 pr-6 appearance-none focus:outline-none focus:ring-2 focus:ring-[#00BFAE]/25"
                      >
                        {convHistory.map((conv) => (
                          <option key={conv.id} value={conv.id}>
                            {conv.status} · {new Date(conv.startedAt).toLocaleString("es", { dateStyle: "short", timeStyle: "short" })}
                          </option>
                        ))}
                      </select>
                      <ChevronDown size={12} className="absolute right-2 top-1/2 -translate-y-1/2 text-[#5B6670] pointer-events-none" />
                    </div>

                    <ApiTracePanel
                      conversationId={traceConversationId || activeConversation?.id || convHistory[0].id}
                      tenantSlug={effectiveTenantSlug ?? null}
                    />
                  </div>
                )}

                {convHistory.map((conv) => (
                  <ConvHistoryCard key={conv.id} conv={conv} />
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
