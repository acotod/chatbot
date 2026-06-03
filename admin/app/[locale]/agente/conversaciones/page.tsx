"use client";

import { Header } from "@/components/layout/Header";
import {
  agentAuthApi,
  type AgentConversationMessage,
  type AgentConversationThread,
} from "@/lib/agentApi";
import { whatsappApi } from "@/lib/api";
import { useCurrentLocale } from "@/lib/i18n/client";
import { cn, formatDate } from "@/lib/utils";
import { Search, Send } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuthStore } from "@/store/auth";

function extractText(msg: Pick<AgentConversationMessage | AgentConversationThread, "tipo" | "contenido">): string {
  const c = (msg.contenido ?? {}) as Record<string, unknown>;

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
  const transcript = getAudioTranscript(msg.contenido);
  if (transcript) return transcript;
  const mediaType = inferMediaType(msg);
  if (mediaType === "image") return "Imagen";
  if (mediaType === "sticker") return "Sticker";
  if (mediaType === "audio") return "Audio";
  if (mediaType === "document") return "Documento";
  return `[${msg.tipo}]`;
}

function getAudioTranscript(contenido: unknown): string | null {
  if (!contenido || typeof contenido !== "object") return null;
  const transcriptRaw = (contenido as Record<string, unknown>).audioTranscript;
  if (!transcriptRaw || typeof transcriptRaw !== "object") return null;
  const text = (transcriptRaw as Record<string, unknown>).text;
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  return trimmed || null;
}

function inferMediaType(msg: Pick<AgentConversationMessage | AgentConversationThread, "tipo" | "contenido">): "image" | "audio" | "document" | "sticker" | null {
  const normalizedTipo = String(msg.tipo ?? "").trim().toLowerCase();
  if (normalizedTipo === "image" || normalizedTipo === "audio" || normalizedTipo === "document" || normalizedTipo === "sticker") {
    return normalizedTipo as "image" | "audio" | "document" | "sticker";
  }

  const contenido = (msg.contenido && typeof msg.contenido === "object")
    ? (msg.contenido as Record<string, unknown>)
    : {};

  if (contenido.image && typeof contenido.image === "object") return "image";
  if (contenido.sticker && typeof contenido.sticker === "object") return "sticker";
  if (contenido.audio && typeof contenido.audio === "object") return "audio";
  if (contenido.document && typeof contenido.document === "object") return "document";

  const raw = (contenido.raw && typeof contenido.raw === "object")
    ? (contenido.raw as Record<string, unknown>)
    : null;
  if (raw?.image && typeof raw.image === "object") return "image";
  if (raw?.sticker && typeof raw.sticker === "object") return "sticker";
  if (raw?.audio && typeof raw.audio === "object") return "audio";
  if (raw?.document && typeof raw.document === "object") return "document";

  return null;
}

function getDisplayName(thread: AgentConversationThread, isEn: boolean): string {
  return thread._contactName ?? thread.user?.phone ?? `${isEn ? "User" : "Usuario"} ${thread.userId}`;
}

function MessageMediaContent({
  msg,
  tenantSlug,
}: {
  msg: Pick<AgentConversationMessage, "id" | "tipo" | "contenido">;
  tenantSlug: string | null;
}) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mediaType = inferMediaType(msg);
  const isMedia = mediaType !== null;
  const transcript = mediaType === "audio" ? getAudioTranscript(msg.contenido) : null;

  useEffect(() => {
    if (!isMedia || !tenantSlug) return;

    let cancelled = false;
    let localUrl: string | null = null;

    (async () => {
      setLoading(true);
      setError(null);
      try {
        const response = await whatsappApi.getMediaBlob(msg.id, { tenantSlug });
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
  }, [isMedia, msg.id, tenantSlug]);

  if (mediaType === "image" || mediaType === "sticker") {
    if (loading) return <p className="text-xs text-[#5B6670]">{mediaType === "sticker" ? "Cargando sticker..." : "Cargando imagen..."}</p>;
    if (error || !blobUrl) return <p className="text-xs text-[#5B6670]">{mediaType === "sticker" ? "Sticker no disponible" : "Imagen no disponible"}</p>;
    return <img src={blobUrl} alt={mediaType === "sticker" ? "WhatsApp sticker" : "WhatsApp media"} className="max-h-72 rounded-xl border border-[#00BFAE]/20 object-contain" />;
  }

  if (mediaType === "audio") {
    return (
      <div className="space-y-1.5">
        {loading && <p className="text-xs text-[#5B6670]">Cargando audio...</p>}
        {!loading && blobUrl && <audio controls src={blobUrl} className="max-w-full" preload="metadata" />}
        {!loading && !blobUrl && <p className="text-xs text-[#5B6670]">Audio no disponible</p>}
        {transcript?.text && <p className="text-xs text-[#0D2B3E] whitespace-pre-wrap">{transcript.text}</p>}
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

export default function AgentConversacionesPage() {
  const qc = useQueryClient();
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const locale = useCurrentLocale();
  const isEn = locale === "en";
  const { tenantSlug } = useAuthStore();

  const [activeThread, setActiveThread] = useState<AgentConversationThread | null>(null);
  const [input, setInput] = useState("");
  const [search, setSearch] = useState("");
  const [msgPage, setMsgPage] = useState(1);
  const [olderMessages, setOlderMessages] = useState<AgentConversationMessage[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);

  const { data: threadsData, isLoading: threadsLoading } = useQuery({
    queryKey: ["agent-conversation-threads", search],
    queryFn: () =>
      agentAuthApi
        .conversationThreads({ q: search || undefined, limit: 50 })
        .then((r) => r.data),
    staleTime: 30_000,
  });
  const threads: AgentConversationThread[] = threadsData?.data ?? [];

  const { data: mensajesData, isLoading: mensajesLoading } = useQuery({
    queryKey: ["agent-conversation-messages", activeThread?.userId],
    queryFn: () =>
      agentAuthApi
        .conversationMessages({ userId: activeThread!.userId!, page: 1, limit: 100 })
        .then((r) => {
          setHasMore((r.data?.count ?? r.data?.data?.length ?? 0) >= 100);
          setOlderMessages([]);
          setMsgPage(1);
          return r.data;
        }),
    enabled: !!activeThread?.userId,
    staleTime: 0,
  });
  const latestMessages: AgentConversationMessage[] = mensajesData?.data ?? [];
  const messages: AgentConversationMessage[] = [...latestMessages, ...olderMessages];

  async function loadMoreMessages() {
    if (!activeThread?.userId || loadingMore) return;
    setLoadingMore(true);
    try {
      const nextPage = msgPage + 1;
      const r = await agentAuthApi.conversationMessages({
        userId: activeThread.userId,
        page: nextPage,
        limit: 100,
      });
      const older: AgentConversationMessage[] = r.data?.data ?? [];
      setOlderMessages((prev) => [...prev, ...older]);
      setMsgPage(nextPage);
      setHasMore((r.data?.count ?? older.length) >= 100);
    } finally {
      setLoadingMore(false);
    }
  }

  useEffect(() => {
    if (messages.length > 0) {
      const container = messagesEndRef.current?.parentElement;
      if (container) container.scrollTop = 0;
    }
  }, [activeThread?.userId, messages.length]);

  const sendMutation = useMutation({
    mutationFn: (text: string) =>
      agentAuthApi.sendConversationMessage({
        userId: activeThread!.userId!,
        text,
        solicitudId: activeThread?._assignedSolicitudId ?? undefined,
      }),
    onMutate: async (text) => {
      const optimistic: AgentConversationMessage = {
        id: Date.now(),
        userId: activeThread?.userId ?? null,
        waMsgId: null,
        direccion: "salida",
        tipo: "text",
        contenido: { text },
        createdAt: new Date().toISOString(),
      };
      qc.setQueryData(
        ["agent-conversation-messages", activeThread?.userId],
        (old: { data: AgentConversationMessage[] } | undefined) =>
          old ? { ...old, data: [...old.data, optimistic] } : { data: [optimistic], count: 1, page: 1, limit: 100 },
      );
      return { optimistic };
    },
    onError: (_err, _vars, ctx) => {
      qc.setQueryData(
        ["agent-conversation-messages", activeThread?.userId],
        (old: { data: AgentConversationMessage[] } | undefined) =>
          old ? { ...old, data: old.data.filter((m) => m.id !== ctx?.optimistic.id) } : old,
      );
    },
  });

  function handleSend() {
    const text = input.trim();
    if (!text || !activeThread?.userId) return;
    setInput("");
    sendMutation.mutate(text);
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <Header />
      <main className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
        <div className="flex h-[calc(100vh-10rem)] gap-0 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
          <div className="flex w-80 shrink-0 flex-col border-r border-slate-200">
            <div className="space-y-2 border-b border-slate-100 p-4">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">Conversaciones</span>
                <span className="rounded-full bg-cyan-50 px-2 py-0.5 text-xs text-cyan-700">{isEn ? "Assigned" : "Asignadas"}</span>
              </div>
              <div className="relative">
                <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <input
                  placeholder={isEn ? "Search..." : "Buscar..."}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="w-full rounded-xl border border-slate-200 bg-slate-50 py-2 pl-9 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/30"
                />
              </div>
            </div>

            <div className="flex-1 overflow-y-auto">
              {threadsLoading && (
                <div className="flex flex-col gap-2 p-4">
                  {[1, 2, 3].map((i) => (
                    <div key={i} className="flex animate-pulse gap-3 p-1">
                      <div className="h-10 w-10 shrink-0 rounded-full bg-slate-200" />
                      <div className="flex-1 space-y-2 py-1">
                        <div className="h-3 w-3/4 rounded bg-slate-200" />
                        <div className="h-2 w-full rounded bg-slate-100" />
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {!threadsLoading && threads.length === 0 && (
                <div className="flex h-40 flex-col items-center justify-center gap-2 px-4 text-center text-sm text-slate-400">
                  <p>{isEn ? "There are no conversations for your assigned contacts" : "No hay conversaciones de tus contactos asignados"}</p>
                  <p className="text-xs text-slate-300">{isEn ? "Messages will appear here in real time" : "Los mensajes aparecerán aquí en tiempo real"}</p>
                </div>
              )}

              {threads.map((thread) => {
                const name = getDisplayName(thread, isEn);
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
                      "w-full border-b border-slate-50 px-4 py-3.5 text-left transition hover:bg-slate-50",
                      isActive && "bg-blue-50 hover:bg-blue-50",
                    )}
                  >
                    <div className="flex items-start gap-3">
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-slate-200 text-sm font-semibold text-slate-600">
                        {name.charAt(0).toUpperCase()}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between">
                          <span className={cn("truncate text-sm font-medium", isActive ? "text-blue-700" : "text-slate-900")}>{name}</span>
                          <span className="ml-2 shrink-0 text-xs text-slate-400">{formatDate(thread.createdAt)}</span>
                        </div>
                        <p className="mt-0.5 truncate text-xs text-slate-500">{lastText}</p>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {!activeThread ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 text-slate-400">
              <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-slate-100 text-3xl">💬</div>
              <p className="font-medium text-slate-600">{isEn ? "Select a conversation" : "Seleccioná una conversación"}</p>
              <p className="text-sm text-slate-400">{isEn ? "You will only see contacts assigned to your requests" : "Solo verás contactos asignados a tus solicitudes"}</p>
            </div>
          ) : (
            <div className="flex min-w-0 flex-1 flex-col">
              <div className="flex h-16 items-center border-b border-slate-200 bg-white px-5">
                <div className="flex items-center gap-3">
                  <div className="flex h-9 w-9 items-center justify-center rounded-full bg-slate-200 text-sm font-semibold text-slate-600">
                    {getDisplayName(activeThread, isEn).charAt(0).toUpperCase()}
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-slate-900">{getDisplayName(activeThread, isEn)}</p>
                    <p className="text-xs text-slate-400">{activeThread.user?.phone ?? ""}</p>
                    {activeThread._contactName && (
                      <p className="text-xs text-slate-600 mt-1">{activeThread._contactName}</p>
                    )}
                  </div>
                </div>
              </div>

              <div className="flex-1 space-y-3 overflow-y-auto bg-slate-50 p-5">
                {mensajesLoading && (
                  <div className="flex flex-col gap-3">
                    {[1, 2, 3].map((i) => (
                      <div key={i} className={cn("flex animate-pulse", i % 2 === 0 ? "justify-end" : "justify-start")}>
                        <div className="h-10 w-48 rounded-2xl bg-slate-200" />
                      </div>
                    ))}
                  </div>
                )}

                {!mensajesLoading && messages.length === 0 && (
                  <div className="flex h-32 items-center justify-center text-sm text-slate-400">{isEn ? "No messages yet" : "No hay mensajes aún"}</div>
                )}

                {messages.map((msg) => {
                  const isOutbound = msg.direccion === "salida";
                  return (
                    <div key={msg.id} className={cn("flex", isOutbound ? "justify-end" : "justify-start")}>
                      <div
                        className={cn(
                          "max-w-xs rounded-2xl px-4 py-2.5 text-sm shadow-sm lg:max-w-md",
                          isOutbound
                            ? "rounded-tr-sm bg-blue-600 text-white"
                            : "rounded-tl-sm border border-slate-200 bg-white text-slate-800",
                        )}
                      >
                        <MessageMediaContent msg={msg} tenantSlug={tenantSlug ?? null} />
                        <p className={cn("mt-1 text-xs", isOutbound ? "text-blue-200" : "text-slate-400")}>
                          {new Date(msg.createdAt).toLocaleTimeString(isEn ? "en-US" : "es-ES", { hour: "2-digit", minute: "2-digit" })}
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
                      className="rounded-full border border-blue-200 bg-blue-50 px-4 py-1.5 text-xs text-blue-600 transition hover:bg-blue-100 hover:text-blue-800 disabled:opacity-50"
                    >
                      {loadingMore ? (isEn ? "Loading..." : "Cargando...") : (isEn ? "Load earlier messages" : "Cargar mensajes anteriores")}
                    </button>
                  </div>
                )}
                <div ref={messagesEndRef} />
              </div>

              <div className="border-t border-slate-200 bg-white px-4 py-3">
                {!activeThread.user?.phone ? (
                  <p className="py-1 text-center text-xs text-slate-400">{isEn ? "This contact does not have a registered phone number" : "Este contacto no tiene número de teléfono registrado"}</p>
                ) : (
                  <div className="flex items-center gap-3">
                    <input
                      value={input}
                      onChange={(e) => setInput(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && handleSend()}
                      placeholder={isEn ? "Write a message..." : "Escribí un mensaje..."}
                      disabled={sendMutation.isPending}
                      className="flex-1 rounded-xl border border-slate-200 bg-slate-50 px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/30 disabled:opacity-60"
                    />
                    <button
                      onClick={handleSend}
                      disabled={!input.trim() || sendMutation.isPending}
                      className="flex h-10 w-10 items-center justify-center rounded-xl bg-blue-600 text-white transition hover:bg-blue-700 disabled:opacity-50"
                    >
                      <Send size={16} />
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
