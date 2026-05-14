"use client";

import { AgendaEventFormData, AgendaEventModal, AgendaTipo } from "@/components/agenda/AgendaEventModal";
import { Button } from "@/components/ui/Button";
import { Card, CardContent, CardHeader } from "@/components/ui/Card";
import { agentAuthApi, type AgentAgendaEvent } from "@/lib/agentApi";
import { agendaApi, agentesApi, tenantApi } from "@/lib/api";
import { getMe } from "@/lib/useMe";
import { getStoredAgentAccessToken } from "@/store/agentAuth";
import { useAuthStore } from "@/store/auth";
import { getStoredAccessToken } from "@/store/auth";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import dayGridPlugin from "@fullcalendar/daygrid";
import interactionPlugin from "@fullcalendar/interaction";
import FullCalendar from "@fullcalendar/react";
import timeGridPlugin from "@fullcalendar/timegrid";
import { EventInput } from "@fullcalendar/core";
import { CalendarDays, Moon, Plus, Sun } from "lucide-react";
import { useSocket } from "@/hooks/useSocket";
import { useCurrentLocale, useTranslations } from "@/lib/i18n/client";
import { useMemo, useRef, useState } from "react";

type AgendaApiAssignment = {
  agenteId: number;
  nombre: string | null;
  email: string | null;
  estado: string | null;
};

type AgendaApiEvent = {
  id: number;
  titulo: string;
  descripcion: string | null;
  tipo: AgendaTipo;
  color: string;
  estado: "pendiente" | "en_progreso" | "completado";
  startAt: string;
  endAt: string;
  reminderMinutes: number | null;
  flowId: number | null;
  triggerWebhookOnStart: boolean;
  webhookUrl: string | null;
  webhookMethod: string | null;
  webhookHeaders: Record<string, unknown> | null;
  webhookPayload: Record<string, unknown> | null;
  assignments: AgendaApiAssignment[];
};

type SlotMinutes = 15 | 30 | 60;

function toLocalInputValue(date: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function startOfWeekMonday(value: Date) {
  const date = new Date(value);
  const day = date.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  date.setDate(date.getDate() + diff);
  date.setHours(0, 0, 0, 0);
  return date;
}

function toFormEvent(event: AgendaApiEvent): AgendaEventFormData {
  return {
    id: event.id,
    titulo: event.titulo,
    descripcion: event.descripcion ?? "",
    tipo: event.tipo,
    color: event.color,
    estado: event.estado,
    startAt: toLocalInputValue(new Date(event.startAt)),
    endAt: toLocalInputValue(new Date(event.endAt)),
    reminderMinutes: event.reminderMinutes,
    flowId: event.flowId,
    triggerWebhookOnStart: Boolean(event.triggerWebhookOnStart),
    webhookUrl: event.webhookUrl ?? "",
    webhookMethod: event.webhookMethod ?? "POST",
    webhookHeadersJson: JSON.stringify(event.webhookHeaders ?? {}, null, 2),
    webhookPayloadJson: JSON.stringify(event.webhookPayload ?? {}, null, 2),
    assignments: event.assignments.map((a) => ({ agenteId: a.agenteId })),
  };
}

export default function AgendaPage() {
  const t = useTranslations("agenda");
  const locale = useCurrentLocale();
  const dateLocale = locale === "en" ? "en-US" : "es-CR";

  const queryClient = useQueryClient();
  const calendarRef = useRef<FullCalendar | null>(null);
  const { tenantSlug } = useAuthStore();
  const me = getMe();
  const hasAccessToken = Boolean(getStoredAccessToken());
  const hasAgentAccessToken = Boolean(getStoredAgentAccessToken());
  const isAgentSession = hasAgentAccessToken && !hasAccessToken;

  const [slotMinutes, setSlotMinutes] = useState<SlotMinutes>(30);
  const [filterTipo, setFilterTipo] = useState<string>("");
  const [filterEstado, setFilterEstado] = useState<string>("");
  const [filterAgenteId, setFilterAgenteId] = useState<string>("");
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [agentAgendaRange] = useState(() => {
    const start = new Date();
    const end = new Date(start.getTime() + 30 * 24 * 60 * 60 * 1000);
    return { start, end };
  });
  const [range, setRange] = useState(() => {
    const start = startOfWeekMonday(new Date());
    const end = new Date(start);
    end.setDate(start.getDate() + 7);
    return { start, end };
  });

  const [modalOpen, setModalOpen] = useState(false);
  const [selectedEvent, setSelectedEvent] = useState<AgendaEventFormData | null>(null);

  const { data: agentAgenda, isLoading: agentAgendaLoading } = useQuery({
    queryKey: ["agent-agenda", agentAgendaRange.start.toISOString(), agentAgendaRange.end.toISOString()],
    queryFn: () =>
      agentAuthApi
        .agenda({ start: agentAgendaRange.start.toISOString(), end: agentAgendaRange.end.toISOString() })
        .then((r) => r.data),
    enabled: isAgentSession,
    staleTime: 30_000,
  });

  const { data: tenants = [] } = useQuery({
    queryKey: ["tenants"],
    queryFn: async () => {
      const res = await tenantApi.list();
      return Array.isArray(res.data) ? res.data : [];
    },
    enabled: hasAccessToken && !isAgentSession,
  });

  const activeTenantId = useMemo(() => {
    if (me?.tenantId) return me.tenantId;
    const match = tenants.find((t: { id: string; slug: string }) => t.slug === tenantSlug);
    return match?.id ?? null;
  }, [me?.tenantId, tenantSlug, tenants]);

  const featureQuery = useQuery({
    queryKey: ["agenda-feature", tenantSlug],
    enabled: Boolean(tenantSlug),
    queryFn: async () => {
      const res = await agendaApi.feature.get(tenantSlug);
      return Boolean(res.data?.enabled);
    },
    retry: false,
  });

  const agendaEnabled = Boolean(featureQuery.data);

  const { data: agentes = [] } = useQuery({
    queryKey: ["agentes", tenantSlug],
    enabled: Boolean(tenantSlug),
    queryFn: async () => {
      const res = await agentesApi.list(tenantSlug);
      return Array.isArray(res.data) ? res.data : [];
    },
  });

  const eventsQuery = useQuery({
    queryKey: ["agenda-events", tenantSlug, range.start.toISOString(), range.end.toISOString(), filterTipo, filterEstado, filterAgenteId],
    enabled: Boolean(tenantSlug && agendaEnabled),
    queryFn: async () => {
      const res = await agendaApi.list(tenantSlug, {
        start: range.start.toISOString(),
        end: range.end.toISOString(),
        tipo: filterTipo || undefined,
        estado: filterEstado || undefined,
        agenteId: filterAgenteId ? Number(filterAgenteId) : undefined,
      });
      return (res.data?.data || []) as AgendaApiEvent[];
    },
  });

  const saveMutation = useMutation({
    mutationFn: async (form: AgendaEventFormData) => {
      if (!tenantSlug) throw new Error(t("messages.tenantRequired"));
      const payload = {
        titulo: form.titulo,
        descripcion: form.descripcion,
        tipo: form.tipo,
        color: form.color,
        estado: form.estado,
        startAt: new Date(form.startAt).toISOString(),
        endAt: new Date(form.endAt).toISOString(),
        reminderMinutes: form.reminderMinutes,
        flowId: form.flowId,
        triggerWebhookOnStart: form.triggerWebhookOnStart,
        webhookUrl: form.webhookUrl || null,
        webhookMethod: form.webhookMethod || null,
        webhookHeaders: JSON.parse(form.webhookHeadersJson || "{}"),
        webhookPayload: JSON.parse(form.webhookPayloadJson || "{}"),
      };
      const assignmentIds = form.assignments.map((a) => a.agenteId);

      if (form.id) {
        await agendaApi.update(tenantSlug, form.id, payload);
        await agendaApi.setAssignments(tenantSlug, form.id, assignmentIds);
      } else {
        await agendaApi.create(tenantSlug, {
          ...payload,
          agenteIds: assignmentIds,
        });
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["agenda-events"] });
      setModalOpen(false);
      setSelectedEvent(null);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      if (!tenantSlug) throw new Error(t("messages.tenantRequired"));
      await agendaApi.remove(tenantSlug, id);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["agenda-events"] });
      setModalOpen(false);
      setSelectedEvent(null);
    },
  });

  const triggerMutation = useMutation({
    mutationFn: async (id: number) => {
      if (!tenantSlug) throw new Error(t("messages.tenantRequired"));
      await agendaApi.triggerStart(tenantSlug, id);
    },
  });

  function refreshEvents() {
    queryClient.invalidateQueries({ queryKey: ["agenda-events"] });
  }

  useSocket(activeTenantId, "agenda:event_created", refreshEvents);
  useSocket(activeTenantId, "agenda:event_updated", refreshEvents);
  useSocket(activeTenantId, "agenda:event_deleted", refreshEvents);
  useSocket(activeTenantId, "agenda:event_assignment_changed", refreshEvents);

  function openCreateFromRange(start: Date, end: Date) {
    setSelectedEvent({
      titulo: "",
      descripcion: "",
      tipo: "reunion",
      color: "#60A5FA",
      estado: "pendiente",
      startAt: toLocalInputValue(start),
      endAt: toLocalInputValue(end),
      reminderMinutes: 15,
      flowId: null,
      triggerWebhookOnStart: false,
      webhookUrl: "",
      webhookMethod: "POST",
      webhookHeadersJson: "{}",
      webhookPayloadJson: "{}",
      assignments: [],
    });
    setModalOpen(true);
  }

  function handleSelect(arg: { start: Date; end: Date }) {
    openCreateFromRange(arg.start, arg.end);
  }

  function handleDateClick(arg: { date: Date }) {
    const end = new Date(arg.date);
    end.setMinutes(end.getMinutes() + slotMinutes);
    openCreateFromRange(arg.date, end);
  }

  function handleEventClick(arg: { event: { id: string; extendedProps: Record<string, unknown> } }) {
    const raw = arg.event.extendedProps.raw as AgendaApiEvent | undefined;
    if (!raw) return;
    setSelectedEvent(toFormEvent(raw));
    setModalOpen(true);
  }

  async function handleMoveResize(arg: {
    event: { id: string; start: Date | null; end: Date | null };
    revert: () => void;
  }) {
    if (!tenantSlug) return;
    const id = Number(arg.event.id);
    if (!id || !arg.event.start || !arg.event.end) {
      arg.revert();
      return;
    }
    try {
      await agendaApi.update(tenantSlug, id, {
        startAt: arg.event.start.toISOString(),
        endAt: arg.event.end.toISOString(),
      });
      refreshEvents();
    } catch {
      arg.revert();
    }
  }

  function handleDatesSet(arg: { start: Date; end: Date }) {
    setRange({ start: arg.start, end: arg.end });
  }

  const calendarEvents: EventInput[] = useMemo(
    () =>
      (eventsQuery.data || []).map((event) => ({
        id: String(event.id),
        title: event.titulo,
        start: event.startAt,
        end: event.endAt,
        backgroundColor: event.color,
        borderColor: event.color,
        extendedProps: { raw: event },
      })),
    [eventsQuery.data]
  );

  if (isAgentSession) {
    const rows: AgentAgendaEvent[] = agentAgenda?.data ?? [];
    return (
      <div className="space-y-5">
        <div className="rounded-2xl border border-slate-200 bg-white p-5">
          <h1 className="text-xl font-semibold text-slate-900">{t("myAgendaTitle")}</h1>
          <p className="mt-1 text-sm text-slate-600">{t("myAgendaSubtitle")}</p>
          <p className="mt-3 text-sm text-slate-500">{t("eventsCount", { count: agentAgenda?.total ?? 0 })}</p>
        </div>

        <Card>
          <CardContent className="p-0">
            {agentAgendaLoading ? (
              <div className="py-16 text-center text-slate-400 text-sm">{t("loadingAgenda")}</div>
            ) : rows.length === 0 ? (
              <div className="py-16 text-center text-slate-400 text-sm">{t("noAssignedEvents")}</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="bg-slate-50 text-slate-600">
                    <tr>
                      <th className="px-4 py-3 text-left font-medium">{t("table.event")}</th>
                      <th className="px-4 py-3 text-left font-medium">{t("table.type")}</th>
                      <th className="px-4 py-3 text-left font-medium">{t("table.status")}</th>
                      <th className="px-4 py-3 text-left font-medium">{t("table.start")}</th>
                      <th className="px-4 py-3 text-left font-medium">{t("table.end")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((event) => (
                      <tr key={event.id} className="border-t border-slate-100">
                        <td className="px-4 py-3 text-slate-800">{event.titulo}</td>
                        <td className="px-4 py-3 text-slate-600">{t(`types.${event.tipo}`)}</td>
                        <td className="px-4 py-3 text-slate-600">{t(`statuses.${event.estado}`)}</td>
                        <td className="px-4 py-3 text-slate-600">{new Date(event.startAt).toLocaleString(dateLocale)}</td>
                        <td className="px-4 py-3 text-slate-600">{new Date(event.endAt).toLocaleString(dateLocale)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!tenantSlug) {
    return (
      <Card>
        <CardContent className="py-16 text-center text-slate-500">
          {t("selectTenant")}
        </CardContent>
      </Card>
    );
  }

  if (!agendaEnabled) {
    return (
      <Card>
        <CardContent className="py-20 flex flex-col items-center text-center gap-4">
          <div className="w-14 h-14 rounded-2xl bg-blue-100 flex items-center justify-center">
            <CalendarDays className="w-7 h-7 text-blue-600" />
          </div>
          <div>
            <h2 className="text-xl font-semibold text-slate-900">{t("pageTitle")}</h2>
            <p className="text-slate-500 text-sm mt-1 max-w-xs">
              {t("moduleInactive")}
            </p>
          </div>
          <span className="inline-flex items-center px-3 py-1 rounded-full bg-amber-100 text-amber-700 text-xs font-medium">
            {t("comingSoon")}
          </span>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className={theme === "dark" ? "agenda-dark" : ""}>
      <div className="grid grid-cols-1 xl:grid-cols-[320px_minmax(0,1fr)] gap-5">
        <Card className="h-fit">
          <CardHeader className="flex flex-row items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-900">{t("agendaPanel")}</h2>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setTheme((prev) => (prev === "light" ? "dark" : "light"))}
            >
              {theme === "light" ? <Moon size={14} /> : <Sun size={14} />}
              {theme === "light" ? t("darkMode") : t("lightMode")}
            </Button>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-xl border border-slate-200 overflow-hidden">
              <FullCalendar
                plugins={[dayGridPlugin, interactionPlugin]}
                initialView="dayGridMonth"
                headerToolbar={{ left: "", center: "title", right: "prev,next" }}
                fixedWeekCount={false}
                height={300}
                dateClick={(arg) => {
                  calendarRef.current?.getApi().gotoDate(arg.date);
                }}
              />
            </div>

            <div className="space-y-2">
              <label className="text-xs font-medium text-slate-600">{t("granularity")}</label>
              <select
                className="h-10 w-full rounded-xl border border-slate-200 px-3 text-sm"
                value={slotMinutes}
                onChange={(e) => setSlotMinutes(Number(e.target.value) as SlotMinutes)}
              >
                <option value={15}>15 min</option>
                <option value={30}>30 min</option>
                <option value={60}>60 min</option>
              </select>
            </div>

            <div className="space-y-2">
              <label className="text-xs font-medium text-slate-600">{t("filterByOwner")}</label>
              <select
                className="h-10 w-full rounded-xl border border-slate-200 px-3 text-sm"
                value={filterAgenteId}
                onChange={(e) => setFilterAgenteId(e.target.value)}
              >
                <option value="">{t("all")}</option>
                {agentes.map((agente: { id: number; nombre: string }) => (
                  <option key={agente.id} value={agente.id}>{agente.nombre}</option>
                ))}
              </select>
            </div>

            <div className="space-y-2">
              <label className="text-xs font-medium text-slate-600">{t("filterByType")}</label>
              <select
                className="h-10 w-full rounded-xl border border-slate-200 px-3 text-sm"
                value={filterTipo}
                onChange={(e) => setFilterTipo(e.target.value)}
              >
                <option value="">{t("all")}</option>
                <option value="reunion">{t("types.reunion")}</option>
                <option value="tarea">{t("types.tarea")}</option>
                <option value="automatizacion">{t("types.automatizacion")}</option>
                <option value="webhook">{t("types.webhook")}</option>
              </select>
            </div>

            <div className="space-y-2">
              <label className="text-xs font-medium text-slate-600">{t("filterByStatus")}</label>
              <select
                className="h-10 w-full rounded-xl border border-slate-200 px-3 text-sm"
                value={filterEstado}
                onChange={(e) => setFilterEstado(e.target.value)}
              >
                <option value="">{t("all")}</option>
                <option value="pendiente">{t("statuses.pendiente")}</option>
                <option value="en_progreso">{t("statuses.en_progreso")}</option>
                <option value="completado">{t("statuses.completado")}</option>
              </select>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <div>
              <h1 className="text-lg font-semibold text-slate-900">{t("weeklyAgenda")}</h1>
              <p className="text-xs text-slate-500 mt-0.5">{t("weeklyAgendaSubtitle")}</p>
            </div>
            <Button onClick={() => openCreateFromRange(new Date(), new Date(Date.now() + slotMinutes * 60 * 1000))}>
              <Plus size={14} />
              {t("newEvent")}
            </Button>
          </CardHeader>
          <CardContent className="px-2 pb-3">
            <div className="agenda-calendar rounded-xl border border-slate-200 overflow-hidden">
              <FullCalendar
                ref={calendarRef}
                plugins={[timeGridPlugin, interactionPlugin]}
                initialView="timeGridWeek"
                firstDay={1}
                height="auto"
                allDaySlot={false}
                slotDuration={`00:${String(slotMinutes).padStart(2, "0")}:00`}
                slotLabelInterval="01:00:00"
                selectable
                selectMirror
                editable
                nowIndicator
                eventDurationEditable
                eventStartEditable
                eventResizableFromStart
                events={calendarEvents}
                datesSet={handleDatesSet}
                select={handleSelect}
                dateClick={handleDateClick}
                eventClick={handleEventClick}
                eventDrop={handleMoveResize}
                eventResize={handleMoveResize}
                eventTimeFormat={{ hour: "2-digit", minute: "2-digit", meridiem: false }}
                headerToolbar={{ left: "prev,next today", center: "title", right: "" }}
              />
            </div>
            {eventsQuery.isLoading && <p className="text-xs text-slate-500 mt-2">{t("loadingEvents")}</p>}
          </CardContent>
        </Card>
      </div>

      <AgendaEventModal
        open={modalOpen}
        event={selectedEvent}
        agentes={agentes}
        saving={saveMutation.isPending || deleteMutation.isPending || triggerMutation.isPending}
        onClose={() => {
          setModalOpen(false);
          setSelectedEvent(null);
        }}
        onSave={async (payload) => {
          await saveMutation.mutateAsync(payload);
        }}
        onDelete={async (id) => {
          await deleteMutation.mutateAsync(id);
        }}
        onTriggerStart={async (id) => {
          await triggerMutation.mutateAsync(id);
        }}
      />

      <style jsx global>{`
        .agenda-calendar .fc .fc-timegrid-slot,
        .agenda-calendar .fc .fc-timegrid-col,
        .agenda-calendar .fc .fc-scrollgrid-section > * {
          background: var(--agenda-bg, #ffffff);
        }

        .agenda-calendar .fc .fc-event {
          border-radius: 10px;
          border-width: 1px;
          padding: 2px;
          box-shadow: 0 4px 10px rgba(2, 6, 23, 0.08);
          transition: transform 140ms ease, box-shadow 140ms ease;
        }

        .agenda-calendar .fc .fc-event:hover {
          transform: translateY(-1px);
          box-shadow: 0 10px 20px rgba(2, 6, 23, 0.12);
        }

        .agenda-calendar .fc .fc-now-indicator-line {
          border-color: #dc2626;
          border-width: 2px;
        }

        .agenda-dark {
          --agenda-bg: #111827;
        }

        .agenda-dark .bg-white,
        .agenda-dark .fc,
        .agenda-dark .fc-theme-standard td,
        .agenda-dark .fc-theme-standard th {
          background: #111827 !important;
          color: #e5e7eb;
          border-color: #1f2937 !important;
        }

        .agenda-dark .text-slate-900,
        .agenda-dark .text-slate-700,
        .agenda-dark .text-slate-600,
        .agenda-dark .text-slate-500 {
          color: #e5e7eb !important;
        }
      `}</style>
    </div>
  );
}
