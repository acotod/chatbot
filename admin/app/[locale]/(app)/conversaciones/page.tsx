"use client";

import { cn, formatDate } from "@/lib/utils";
import {
  AlertTriangle,
  ChevronDown,
  ClipboardList,
  ExternalLink,
  GitBranch,
  Search,
  Send,
  StickyNote,
  UserCheck,
  Wifi,
  WifiOff,
  X,
  Zap,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
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
  return `[${msg.tipo}]`;
}

function getDisplayName(thread: Thread): string {
  return thread._contactName ?? thread.user?.phone ?? `Usuario ${thread.userId}`;
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
        connected ? "bg-green-50 text-green-600" : "bg-slate-100 text-slate-400"
      )}
    >
      {connected ? <Wifi size={12} /> : <WifiOff size={12} />}
      {connected ? t("socket.live") : t("socket.offline")}
    </span>
  );
}

// ── ConvHistoryCard ────────────────────────────────────────────────────────────

const EVENT_COLORS: Record<string, string> = {
  conversation_started:  "text-green-600 bg-green-50 border-green-200",
  message_sent:          "text-blue-600 bg-blue-50 border-blue-200",
  user_input:            "text-slate-600 bg-slate-50 border-slate-200",
  condition_evaluated:   "text-violet-600 bg-violet-50 border-violet-200",
  api_call:              "text-orange-600 bg-orange-50 border-orange-200",
  task_status_change:    "text-yellow-700 bg-yellow-50 border-yellow-200",
  conversation_ended:    "text-slate-500 bg-slate-100 border-slate-200",
};

function ConvHistoryCard({ conv }: { conv: ConvRecord }) {
  const t = useTranslations("conversaciones");
  const eventLabels: Record<string, string> = {
    conversation_started: t("eventLabels.conversation_started"),
    message_sent: t("eventLabels.message_sent"),
    user_input: t("eventLabels.user_input"),
    condition_evaluated: t("eventLabels.condition_evaluated"),
    api_call: t("eventLabels.api_call"),
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
    conv.status === "active"     ? "text-green-600 bg-green-50"  :
    conv.status === "completed"  ? "text-slate-500 bg-slate-100" :
    conv.status === "abandoned"  ? "text-yellow-700 bg-yellow-50":
    "text-red-600 bg-red-50";

  return (
    <div className="border border-slate-200 rounded-xl overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-start gap-2 p-2.5 text-left hover:bg-slate-50 transition"
      >
        <GitBranch size={13} className="mt-0.5 text-slate-400 shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-medium text-slate-800 truncate">
              {conv.flow?.nombre ?? t("historialTab.unknownFlow")}
            </span>
            <span className={cn("text-[10px] font-semibold px-1.5 py-0.5 rounded-full shrink-0", statusColor)}>
              {conv.status}
            </span>
          </div>
          <p className="text-[11px] text-slate-400 mt-0.5">
            {new Date(conv.startedAt).toLocaleString("es", { dateStyle: "short", timeStyle: "short" })}
          </p>
        </div>
        <ChevronDown size={13} className={cn("text-slate-400 shrink-0 transition-transform mt-0.5", open && "rotate-180")} />
      </button>

      {open && (
        <div className="border-t border-slate-100 divide-y divide-slate-50">
          {events.length === 0 && (
            <p className="text-xs text-slate-400 px-3 py-3 text-center">{t("historialTab.noEvents")}</p>
          )}
          {events.map((ev) => {
            const color = EVENT_COLORS[ev.eventType] ?? "text-slate-500 bg-slate-50 border-slate-200";
            const label = eventLabels[ev.eventType] ?? ev.eventType;
            const payload = ev.payload as Record<string, unknown>;
            const detail =
              (payload.content as string) ??
              (payload.input as string) ??
              (payload.toStatus ? `→ ${payload.toStatus}` : null) ??
              null;
            return (
              <div key={ev.id} className="flex items-start gap-2 px-3 py-2">
                <Zap size={11} className="mt-0.5 text-slate-300 shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className={cn("text-[10px] font-semibold px-1.5 py-px rounded border", color)}>
                      {label}
                    </span>
                    {ev.nodeRef && (
                      <span className="text-[10px] text-slate-400 truncate">{ev.nodeRef}</span>
                    )}
                  </div>
                  {detail && (
                    <p className="text-[11px] text-slate-600 mt-0.5 truncate">{detail}</p>
                  )}
                  <p className="text-[10px] text-slate-300 mt-0.5">
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
  const { data: tenantWithThreads } = useQuery({
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
    <div className="flex gap-0 h-[calc(100vh-7rem)] bg-white rounded-2xl border border-slate-200 overflow-hidden shadow-sm">

      {/* ── Thread list ── */}
      <div className="w-80 shrink-0 border-r border-slate-200 flex flex-col">
        <div className="p-4 border-b border-slate-100 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide">
              {t("header")}
            </span>
            <SocketIndicator tenantId={tenantId} />
          </div>
          <div className="relative">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              placeholder={t("searchPlaceholder")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-9 pr-3 py-2 rounded-xl bg-slate-50 border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/30"
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {threadsLoading && (
            <div className="flex flex-col gap-2 p-4">
              {[1, 2, 3].map((i) => (
                <div key={i} className="animate-pulse flex gap-3 p-1">
                  <div className="w-10 h-10 rounded-full bg-slate-200 shrink-0" />
                  <div className="flex-1 space-y-2 py-1">
                    <div className="h-3 bg-slate-200 rounded w-3/4" />
                    <div className="h-2 bg-slate-100 rounded w-full" />
                  </div>
                </div>
              ))}
            </div>
          )}

          {!threadsLoading && filtered.length === 0 && (
            <div className="flex flex-col items-center justify-center h-40 text-slate-400 text-sm gap-2 px-4 text-center">
              <p>{t("emptyList")}</p>
              <p className="text-xs text-slate-300">
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
                  "w-full flex items-start gap-3 px-4 py-3.5 hover:bg-slate-50 transition text-left border-b border-slate-50",
                  isActive && "bg-blue-50 hover:bg-blue-50"
                )}
              >
                <div className="w-10 h-10 rounded-full bg-slate-200 flex items-center justify-center text-slate-600 font-semibold text-sm shrink-0">
                  {name.charAt(0).toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between">
                    <span className={cn("text-sm font-medium truncate", isActive ? "text-blue-700" : "text-slate-900")}>
                      {name}
                    </span>
                    <span className="text-xs text-slate-400 shrink-0 ml-2">
                      {formatDate(thread.createdAt)}
                    </span>
                  </div>
                  <p className="text-xs text-slate-500 truncate mt-0.5">{lastText}</p>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Active conversation ── */}
      {!activeThread ? (
        <div className="flex-1 flex flex-col items-center justify-center text-slate-400 gap-3">
          <div className="w-16 h-16 rounded-2xl bg-slate-100 flex items-center justify-center text-3xl">💬</div>
          <p className="font-medium text-slate-600">{t("selectConversation")}</p>
          <p className="text-sm text-slate-400">{t("selectConversationSub")}</p>
        </div>
      ) : (
        <div className="flex-1 flex flex-col min-w-0">
          {/* Header */}
          <div className="h-16 px-5 border-b border-slate-200 flex items-center bg-white">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-full bg-slate-200 flex items-center justify-center text-slate-600 font-semibold text-sm">
                {getDisplayName(activeThread).charAt(0).toUpperCase()}
              </div>
              <div>
                <p className="font-semibold text-slate-900 text-sm">{getDisplayName(activeThread)}</p>
                <p className="text-xs text-slate-400">{activeThread.user?.phone ?? ""}</p>
              </div>
            </div>
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto p-5 space-y-3 bg-slate-50">
            {mensajesLoading && (
              <div className="flex flex-col gap-3">
                {[1, 2, 3].map((i) => (
                  <div key={i} className={cn("animate-pulse flex", i % 2 === 0 ? "justify-end" : "justify-start")}>
                    <div className="h-10 w-48 bg-slate-200 rounded-2xl" />
                  </div>
                ))}
              </div>
            )}

            {!mensajesLoading && messages.length === 0 && (
              <div className="flex items-center justify-center h-32 text-slate-400 text-sm">
                {t("noMessages")}
              </div>
            )}

            {messages.map((msg) => {
              const isOutbound = msg.direccion === "salida";
              return (
                <div key={msg.id} className={cn("flex", isOutbound ? "justify-end" : "justify-start")}>
                  <div
                    className={cn(
                      "max-w-xs lg:max-w-md px-4 py-2.5 rounded-2xl text-sm shadow-sm",
                      isOutbound
                        ? "bg-blue-600 text-white rounded-tr-sm"
                        : "bg-white text-slate-800 rounded-tl-sm border border-slate-200"
                    )}
                  >
                    <p className="whitespace-pre-wrap">{extractText(msg)}</p>
                    <p className={cn("text-xs mt-1", isOutbound ? "text-blue-200" : "text-slate-400")}>
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
                  className="text-xs text-blue-600 hover:text-blue-800 bg-blue-50 hover:bg-blue-100 px-4 py-1.5 rounded-full border border-blue-200 transition disabled:opacity-50"
                >
                  {loadingMore ? t("loading") : t("loadMore")}
                </button>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* Input */}
          <div className="px-4 py-3 bg-white border-t border-slate-200">
            {!activeThread.user?.phone ? (
              <p className="text-xs text-slate-400 text-center py-1">
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
                  className="flex-1 px-4 py-2.5 rounded-xl bg-slate-50 border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/30 disabled:opacity-60"
                />
                <button
                  onClick={handleSend}
                  disabled={!input.trim() || sendMutation.isPending}
                  className="w-10 h-10 rounded-xl bg-blue-600 hover:bg-blue-700 text-white flex items-center justify-center transition disabled:opacity-50"
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
        <div className="w-72 shrink-0 border-l border-slate-200 bg-white flex flex-col overflow-hidden hidden xl:flex">
          {/* Contact header */}
          <div className="p-4 border-b border-slate-100">
            <div className="flex flex-col items-center gap-2">
              <div className="w-12 h-12 rounded-full bg-blue-100 text-blue-700 flex items-center justify-center text-lg font-bold">
                {getDisplayName(activeThread).charAt(0).toUpperCase()}
              </div>
              <div className="text-center">
                <p className="font-semibold text-slate-900 text-sm">{getDisplayName(activeThread)}</p>
                {activeThread.user?.phone && (
                  <p className="text-xs text-slate-500 mt-0.5">{activeThread.user.phone}</p>
                )}
              </div>
            </div>

            {/* Quick actions */}
            <div className="flex gap-2 mt-3">
              <button
                onClick={() => { setShowEscalarForm((v) => !v); setContextTab("solicitudes"); }}
                className="flex-1 flex items-center justify-center gap-1.5 text-xs font-medium bg-blue-50 hover:bg-blue-100 text-blue-700 py-1.5 px-2 rounded-lg transition"
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

            {/* Escalation form */}
            {showEscalarForm && (
              <div className="mt-3 p-3 bg-slate-50 rounded-xl border border-slate-200 space-y-2">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-semibold text-slate-600">{t("escalationForm.title")}</p>
                  <button onClick={() => setShowEscalarForm(false)} className="text-slate-400 hover:text-slate-600">
                    <X size={13} />
                  </button>
                </div>
                <div className="relative">
                  <select
                    value={escalarAgenteId}
                    onChange={(e) => setEscalarAgenteId(e.target.value ? Number(e.target.value) : "")}
                    className="w-full text-xs bg-white border border-slate-200 rounded-lg px-2 py-1.5 pr-6 appearance-none focus:outline-none focus:ring-2 focus:ring-blue-500/30"
                  >
                    <option value="">{t("escalationForm.placeholder")}</option>
                    {agentes.map((a) => (
                      <option key={a.id} value={a.id}>{a.nombre}</option>
                    ))}
                  </select>
                  <ChevronDown size={12} className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
                </div>
                <button
                  disabled={!escalarAgenteId || !!escalandoId}
                  onClick={handleEscalar}
                  className="w-full text-xs font-medium bg-blue-600 hover:bg-blue-700 text-white py-1.5 rounded-lg transition disabled:opacity-50"
                >
                  {escalandoId ? t("escalationForm.creating") : t("escalationForm.createAndAssign")}
                </button>
              </div>
            )}
          </div>

          {/* Tabs */}
          <div className="flex border-b border-slate-100">
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
                      ? "text-blue-600 border-b-2 border-blue-600 font-medium"
                      : "text-slate-400 hover:text-slate-600"
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
                      <div key={i} className="animate-pulse h-14 bg-slate-100 rounded-xl" />
                    ))}
                  </div>
                )}
                {!solicitudesLoading && solicitudes.length === 0 && (
                  <div className="flex flex-col items-center justify-center py-8 text-slate-400 text-xs text-center gap-2">
                    <ClipboardList size={24} className="text-slate-200" />
                    <p>{t("solicitudesTab.empty")}</p>
                    <p className="text-slate-300">{t("solicitudesTab.emptySub")}</p>
                  </div>
                )}
                {solicitudes.map((s) => (
                  <div key={s.id} className="p-2.5 bg-slate-50 rounded-xl border border-slate-200 space-y-1.5">
                    <div className="flex items-start justify-between gap-1">
                      <p className="text-xs font-medium text-slate-800 truncate flex-1">
                        {s.nombre ?? `Solicitud #${s.id}`}
                      </p>
                      <span className={cn(
                        "text-[10px] font-semibold px-1.5 py-0.5 rounded-full shrink-0",
                        s.estado === "in_progress" ? "bg-red-100 text-red-600" :
                        s.estado === "completed" ? "bg-green-100 text-green-600" :
                        s.estado === "rejected" ? "bg-slate-100 text-slate-500" :
                        "bg-yellow-100 text-yellow-700"
                      )}>
                        {s.estado ? (solicitudStatusLabels[s.estado] ?? s.estado) : solicitudStatusLabels["open"]}
                      </span>
                    </div>
                    {s.agente && (
                      <p className="text-[11px] text-slate-500 flex items-center gap-1">
                        <UserCheck size={10} /> {s.agente.nombre}
                      </p>
                    )}
                    <div className="flex gap-1 items-center">
                      <button
                        onClick={() => router.push("/solicitudes")}
                        title="Ver en solicitudes"
                        className="text-[10px] text-blue-500 hover:text-blue-700 flex items-center gap-0.5"
                      >
                        <ExternalLink size={9} />
                        {t("solicitudesTab.view")}
                      </button>
                      {s.estado !== "completed" && (
                        <button
                          onClick={() => updateEstadoMutation.mutate({ id: s.id, estado: "completed" })}
                          className="text-[10px] text-green-600 hover:underline ml-1"
                        >
                          {t("solicitudesTab.markAttended")}
                        </button>
                      )}
                      {s.estado !== "rejected" && (
                        <button
                          onClick={() => updateEstadoMutation.mutate({ id: s.id, estado: "rejected" })}
                          className="text-[10px] text-slate-400 hover:underline ml-auto"
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
                  <div className="flex flex-col items-center justify-center py-8 text-slate-400 text-xs text-center gap-2">
                    <UserCheck size={24} className="text-slate-200" />
                    <p>{t("agentesTab.empty")}</p>
                  </div>
                )}
                {agentes.map((a) => (
                  <div key={a.id} className="flex items-center gap-2.5 p-2.5 bg-slate-50 rounded-xl border border-slate-200">
                    <div className="w-7 h-7 rounded-full bg-blue-100 text-blue-700 flex items-center justify-center text-xs font-bold shrink-0">
                      {a.nombre.charAt(0).toUpperCase()}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium text-slate-800 truncate">{a.nombre}</p>
                      {a.estado && (
                        <p className={cn(
                          "text-[10px]",
                          a.estado === "online" ? "text-green-500" : "text-slate-400"
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
                  <div className="p-2.5 bg-yellow-50 border border-yellow-200 rounded-xl">
                    <p className="text-xs text-yellow-800 whitespace-pre-wrap">{savedNota}</p>
                  </div>
                )}
                <textarea
                  value={nota}
                  onChange={(e) => setNota(e.target.value)}
                  placeholder={t("notasTab.placeholder")}
                  rows={4}
                  className="w-full text-xs bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 resize-none focus:outline-none focus:ring-2 focus:ring-blue-500/30"
                />
                <button
                  onClick={() => { if (nota.trim()) { setSavedNota(nota.trim()); setNota(""); } }}
                  disabled={!nota.trim()}
                  className="w-full text-xs font-medium bg-slate-800 hover:bg-slate-900 text-white py-1.5 rounded-lg transition disabled:opacity-40"
                >
                  {t("notasTab.save")}
                </button>
              </div>
            )}

            {/* Historial del flujo tab */}
            {contextTab === "historial" && (
              <div className="p-3 space-y-3">
                {convHistory.length === 0 && (
                  <div className="flex flex-col items-center justify-center py-8 text-slate-400 text-xs text-center gap-2">
                    <GitBranch size={24} className="text-slate-200" />
                    <p>{t("historialTab.empty")}</p>
                    <p className="text-slate-300">{t("historialTab.emptySub")}</p>
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
