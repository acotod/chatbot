"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { agentAuthApi, type AgentKpisResponse, type AgentSolicitud, type AgentAgendaEvent } from "@/lib/agentApi";
import { Header } from "@/components/layout/Header";
import { useCurrentLocale } from "@/lib/i18n/client";
import { useAgentAuthStore } from "@/store/agentAuth";

type AgentProfile = {
  agenteId: number;
  tenantId: string;
  tenantSlug: string;
  tenantNombre: string | null;
  nombre: string;
  email: string;
  whatsapp: string | null;
  estado: string;
  puesto: { id: number; nombre: string } | null;
  calendarLink: string | null;
  lastSeenAt: string | null;
};

function KpiCard({
  label,
  value,
  sublabel,
  accent,
  href,
}: {
  label: string;
  value: number | string;
  sublabel?: string;
  accent?: "cyan" | "emerald" | "amber" | "rose";
  href?: string;
}) {
  const accentClasses: Record<string, string> = {
    cyan:    "bg-cyan-50   border-cyan-200   text-cyan-700",
    emerald: "bg-emerald-50 border-emerald-200 text-emerald-700",
    amber:   "bg-amber-50  border-amber-200  text-amber-700",
    rose:    "bg-rose-50   border-rose-200   text-rose-700",
  };
  const valueClasses: Record<string, string> = {
    cyan:    "text-cyan-700",
    emerald: "text-emerald-700",
    amber:   "text-amber-700",
    rose:    "text-rose-700",
  };
  const cls = accentClasses[accent ?? "cyan"];
  const vcls = valueClasses[accent ?? "cyan"];

  const inner = (
    <div className={`rounded-2xl border p-5 flex flex-col gap-1 ${cls} transition hover:shadow-sm`}>
      <p className="text-xs font-semibold uppercase tracking-widest opacity-70">{label}</p>
      <p className={`text-4xl font-bold tracking-tight ${vcls}`}>{value}</p>
      {sublabel && <p className="text-xs opacity-60 mt-0.5">{sublabel}</p>}
    </div>
  );

  if (href) {
    return <Link href={href}>{inner}</Link>;
  }
  return inner;
}

function priorityLabel(p: string | null, isEn: boolean) {
  if (!p) return null;
  const map: Record<string, string> = isEn
    ? { alta: "High", media: "Medium", baja: "Low" }
    : { alta: "Alta", media: "Media", baja: "Baja" };
  return map[p.toLowerCase()] ?? p;
}

function priorityColor(p: string | null) {
  if (!p) return "text-slate-400";
  const map: Record<string, string> = {
    alta: "text-rose-600",
    media: "text-amber-600",
    baja: "text-slate-400",
  };
  return map[p.toLowerCase()] ?? "text-slate-500";
}

function estadoColor(e: string | null) {
  if (!e) return "bg-slate-100 text-slate-500";
  const map: Record<string, string> = {
    asignado: "bg-cyan-100 text-cyan-700",
    en_progreso: "bg-blue-100 text-blue-700",
    pendiente: "bg-amber-100 text-amber-700",
    completado: "bg-emerald-100 text-emerald-700",
    cancelado: "bg-rose-100 text-rose-700",
  };
  return map[e.toLowerCase()] ?? "bg-slate-100 text-slate-600";
}

function requestStatusLabel(status: string | null, isEn: boolean) {
  if (!status) return "";
  const normalized = status.toLowerCase();
  const map: Record<string, string> = isEn
    ? {
        asignado: "Assigned",
        en_progreso: "In progress",
        pendiente: "Pending",
        completado: "Completed",
        cancelado: "Cancelled",
        open: "Open",
        in_progress: "In progress",
        pending_info: "Pending info",
        completed: "Completed",
        rejected: "Rejected",
      }
    : {
        asignado: "Asignado",
        en_progreso: "En progreso",
        pendiente: "Pendiente",
        completado: "Completado",
        cancelado: "Cancelado",
        open: "Abierta",
        in_progress: "En progreso",
        pending_info: "Pendiente info",
        completed: "Completada",
        rejected: "Rechazada",
      };

  return map[normalized] ?? status.replace(/_/g, " ");
}

function agendaStatusLabel(status: string, isEn: boolean) {
  const normalized = status.toLowerCase();
  const map: Record<string, string> = isEn
    ? {
        programado: "Scheduled",
        confirmado: "Confirmed",
        cancelado: "Cancelled",
        completado: "Completed",
      }
    : {
        programado: "Programado",
        confirmado: "Confirmado",
        cancelado: "Cancelado",
        completado: "Completado",
      };

  return map[normalized] ?? status;
}

function agendaTypeLabel(type: string | null | undefined, isEn: boolean) {
  if (!type) return "";
  const normalized = type.toLowerCase();
  const map: Record<string, string> = isEn
    ? {
        llamada: "Call",
        reunion: "Meeting",
        visita: "Visit",
        seguimiento: "Follow-up",
        recordatorio: "Reminder",
      }
    : {
        llamada: "Llamada",
        reunion: "Reunion",
        visita: "Visita",
        seguimiento: "Seguimiento",
        recordatorio: "Recordatorio",
      };

  return map[normalized] ?? type;
}

function agendaEstadoColor(e: string) {
  const map: Record<string, string> = {
    programado: "bg-cyan-100 text-cyan-700",
    confirmado: "bg-emerald-100 text-emerald-700",
    cancelado: "bg-rose-100 text-rose-700",
    completado: "bg-slate-100 text-slate-500",
  };
  return map[e.toLowerCase()] ?? "bg-slate-100 text-slate-600";
}

export default function AgentDashboardPage() {
  const router = useRouter();
  const locale = useCurrentLocale();
  const isEn = locale === "en";
  const { logout } = useAgentAuthStore();
  const [profile, setProfile] = useState<AgentProfile | null>(null);
  const [kpis, setKpis] = useState<AgentKpisResponse | null>(null);
  const [solicitudes, setSolicitudes] = useState<AgentSolicitud[]>([]);
  const [agenda, setAgenda] = useState<AgentAgendaEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;

    async function loadData() {
      try {
        const [profileRes, kpisRes, solicitudesRes, agendaRes] = await Promise.all([
          agentAuthApi.me(),
          agentAuthApi.kpis(),
          agentAuthApi.solicitudes({ status: "assigned", limit: 5 }),
          agentAuthApi.agenda({ estado: "programado" }),
        ]);
        if (!cancelled) {
          setProfile(profileRes.data);
          setKpis(kpisRes.data);
          setSolicitudes(solicitudesRes.data.data.slice(0, 5));
          // Sort upcoming events ascending and take first 5
          const now = new Date();
          const upcoming = agendaRes.data.data
            .filter((e) => new Date(e.startAt) >= now)
            .sort((a, b) => new Date(a.startAt).getTime() - new Date(b.startAt).getTime())
            .slice(0, 5);
          setAgenda(upcoming);
        }
      } catch {
        if (!cancelled) {
          setError(isEn ? "Could not load the dashboard." : "No se pudo cargar el dashboard.");
          logout();
          router.replace("/agente/login?reason=expired");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void loadData();

    return () => {
      cancelled = true;
    };
  }, [logout, router]);

  async function handleLogout() {
    try {
      await agentAuthApi.logout();
    } catch {
      // Best effort.
    } finally {
      logout();
      router.replace("/agente/login");
    }
  }

  const today = new Date();
  const dateLabel = today.toLocaleDateString(isEn ? "en-US" : "es-ES", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });

  return (
    <div className="min-h-screen bg-slate-100">
      <Header />
      <div className="mx-auto max-w-5xl space-y-6 px-4 py-8 sm:px-6 lg:px-8">

        {/* Header */}
        <div className="rounded-3xl bg-white border border-slate-200 shadow-sm p-6 sm:p-8">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-sm font-medium uppercase tracking-[0.2em] text-cyan-600 capitalize">{dateLabel}</p>
              {profile ? (
                <>
                  <h1 className="mt-1 text-2xl font-semibold tracking-tight text-slate-900">
                    {isEn ? "Hi" : "Hola"}, {profile.nombre.split(" ")[0]} 👋
                  </h1>
                  <p className="mt-1 text-sm text-slate-500">
                    {profile.puesto?.nombre ?? (isEn ? "Agent" : "Agente")} · {profile.tenantNombre || profile.tenantSlug}
                  </p>
                </>
              ) : (
                <h1 className="mt-1 text-2xl font-semibold tracking-tight text-slate-900">
                  {isEn ? "Agent panel" : "Panel de agente"}
                </h1>
              )}
            </div>
            <button
              type="button"
              onClick={handleLogout}
              className="self-start rounded-xl border border-slate-200 px-4 py-2 text-sm font-medium text-slate-600 hover:border-red-200 hover:bg-red-50 hover:text-red-600 transition"
            >
              {isEn ? "Sign out" : "Cerrar sesión"}
            </button>
          </div>
        </div>

        {loading ? (
          <div className="rounded-3xl bg-white border border-slate-200 shadow-sm p-8 text-center text-sm text-slate-400">
            {isEn ? "Loading data..." : "Cargando datos..."}
          </div>
        ) : error ? (
          <div className="rounded-3xl bg-white border border-red-200 shadow-sm p-6 text-sm text-red-600">
            {error}
          </div>
        ) : (
          <>
            {/* KPI Cards */}
            {kpis && (
              <div className="grid gap-4 grid-cols-2 sm:grid-cols-4">
                <KpiCard
                  label={isEn ? "Active requests" : "Solicitudes activas"}
                  value={kpis.solicitudesActivas}
                  sublabel={isEn ? "assigned to you" : "asignadas a ti"}
                  accent="cyan"
                  href="/agente/solicitudes"
                />
                <KpiCard
                  label={isEn ? "Completed this month" : "Completadas este mes"}
                  value={kpis.solicitudesCompletadasMes}
                  sublabel={isEn ? "closed requests" : "solicitudes cerradas"}
                  accent="emerald"
                  href="/agente/solicitudes?status=completed"
                />
                <KpiCard
                  label={isEn ? "Agenda next 7 days" : "Agenda próximos 7 días"}
                  value={kpis.agendaProximos7Dias}
                  sublabel={isEn ? "scheduled events" : "eventos programados"}
                  accent="amber"
                  href="/agente/agenda"
                />
                <KpiCard
                  label={isEn ? "Overdue events" : "Eventos vencidos"}
                  value={kpis.agendaVencida}
                  sublabel={
                    kpis.agendaVencida > 0
                      ? (isEn ? "require attention" : "requieren atención")
                      : (isEn ? "all up to date" : "todo al día")
                  }
                  accent={kpis.agendaVencida > 0 ? "rose" : "emerald"}
                  href="/agente/agenda"
                />
              </div>
            )}

            <div className="grid gap-4 lg:grid-cols-2">
              {/* Solicitudes recientes */}
              <div className="rounded-3xl bg-white border border-slate-200 shadow-sm p-6 flex flex-col gap-4">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-semibold uppercase tracking-widest text-slate-400">
                    {isEn ? "Assigned requests" : "Solicitudes asignadas"}
                  </p>
                  <Link
                    href="/agente/solicitudes"
                    className="text-xs font-medium text-cyan-600 hover:text-cyan-700 transition"
                  >
                    {isEn ? "View all" : "Ver todas"} →
                  </Link>
                </div>
                {solicitudes.length === 0 ? (
                  <p className="text-sm text-slate-400 py-4 text-center">
                    {isEn ? "No active requests" : "Sin solicitudes activas"}
                  </p>
                ) : (
                  <ul className="divide-y divide-slate-100">
                    {solicitudes.map((s) => (
                      <li key={s.id} className="py-3">
                        <Link
                          href={`/agente/solicitudes?id=${s.id}`}
                          className="flex items-start justify-between gap-3 group"
                        >
                          <div className="min-w-0">
                            <p className="text-sm font-medium text-slate-800 truncate group-hover:text-cyan-700 transition">
                              {s.titulo || s.nombre || `${isEn ? "Request" : "Solicitud"} #${s.id}`}
                            </p>
                            <div className="flex items-center gap-2 mt-1 flex-wrap">
                              {s.estado && (
                                <span className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-semibold ${estadoColor(s.estado)}`}>
                                  {requestStatusLabel(s.estado, isEn)}
                                </span>
                              )}
                              {s.prioridad && (
                                <span className={`text-[11px] font-medium ${priorityColor(s.prioridad)}`}>
                                  {priorityLabel(s.prioridad, isEn)}
                                </span>
                              )}
                              {s.categoria && (
                                <span className="text-[11px] text-slate-400">{s.categoria}</span>
                              )}
                            </div>
                          </div>
                          <span className="shrink-0 text-[11px] text-slate-400 pt-0.5">
                            {new Date(s.updatedAt).toLocaleDateString(isEn ? "en-US" : "es-ES", { day: "numeric", month: "short" })}
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {/* Próximos eventos */}
              <div className="rounded-3xl bg-white border border-slate-200 shadow-sm p-6 flex flex-col gap-4">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-semibold uppercase tracking-widest text-slate-400">
                    {isEn ? "Upcoming events" : "Próximos eventos"}
                  </p>
                  <Link
                    href="/agente/agenda"
                    className="text-xs font-medium text-cyan-600 hover:text-cyan-700 transition"
                  >
                    {isEn ? "View agenda" : "Ver agenda"} →
                  </Link>
                </div>
                {agenda.length === 0 ? (
                  <p className="text-sm text-slate-400 py-4 text-center">
                    {isEn ? "No upcoming events" : "Sin eventos próximos"}
                  </p>
                ) : (
                  <ul className="divide-y divide-slate-100">
                    {agenda.map((e) => {
                      const start = new Date(e.startAt);
                      const isToday =
                        start.getDate() === today.getDate() &&
                        start.getMonth() === today.getMonth() &&
                        start.getFullYear() === today.getFullYear();
                      return (
                        <li key={e.id} className="py-3">
                          <div className="flex items-start justify-between gap-3">
                            <div className="flex items-start gap-3 min-w-0">
                              <div
                                className="mt-0.5 h-2.5 w-2.5 shrink-0 rounded-full"
                                style={{ backgroundColor: e.color || "#06b6d4" }}
                              />
                              <div className="min-w-0">
                                <p className="text-sm font-medium text-slate-800 truncate">{e.titulo}</p>
                                <div className="flex items-center gap-2 mt-1 flex-wrap">
                                  <span className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-semibold ${agendaEstadoColor(e.estado)}`}>
                                    {agendaStatusLabel(e.estado, isEn)}
                                  </span>
                                  <span className="text-[11px] text-slate-400">{agendaTypeLabel(e.tipo, isEn)}</span>
                                </div>
                              </div>
                            </div>
                            <div className="shrink-0 text-right">
                              <p className={`text-[11px] font-semibold ${isToday ? "text-cyan-600" : "text-slate-500"}`}>
                                {isToday ? (isEn ? "Today" : "Hoy") : start.toLocaleDateString(isEn ? "en-US" : "es-ES", { day: "numeric", month: "short" })}
                              </p>
                              <p className="text-[11px] text-slate-400">
                                {start.toLocaleTimeString(isEn ? "en-US" : "es-ES", { hour: "2-digit", minute: "2-digit" })}
                              </p>
                            </div>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </div>

            {/* Quick actions */}
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Link
                href="/agente/conversaciones"
                className="rounded-2xl bg-white border border-slate-200 px-5 py-4 flex items-center gap-3 hover:border-blue-300 hover:bg-blue-50 transition group"
              >
                <span className="text-2xl">💬</span>
                <div>
                  <p className="text-sm font-semibold text-slate-800 group-hover:text-blue-700">
                    {isEn ? "Conversations" : "Conversaciones"}
                  </p>
                  <p className="text-xs text-slate-400">{isEn ? "Real-time chat" : "Chat en tiempo real"}</p>
                </div>
              </Link>
              <Link
                href="/agente/solicitudes"
                className="rounded-2xl bg-white border border-slate-200 px-5 py-4 flex items-center gap-3 hover:border-cyan-300 hover:bg-cyan-50 transition group"
              >
                <span className="text-2xl">📋</span>
                <div>
                  <p className="text-sm font-semibold text-slate-800 group-hover:text-cyan-700">
                    {isEn ? "My requests" : "Mis solicitudes"}
                  </p>
                  <p className="text-xs text-slate-400">{isEn ? "Manage and respond" : "Gestionar y responder"}</p>
                </div>
              </Link>
              <Link
                href="/agente/agenda"
                className="rounded-2xl bg-white border border-slate-200 px-5 py-4 flex items-center gap-3 hover:border-amber-300 hover:bg-amber-50 transition group"
              >
                <span className="text-2xl">📅</span>
                <div>
                  <p className="text-sm font-semibold text-slate-800 group-hover:text-amber-700">{isEn ? "Agenda" : "Agenda"}</p>
                  <p className="text-xs text-slate-400">{isEn ? "Appointments and events" : "Citas y eventos"}</p>
                </div>
              </Link>
              <Link
                href="/agente/contactos"
                className="rounded-2xl bg-white border border-slate-200 px-5 py-4 flex items-center gap-3 hover:border-emerald-300 hover:bg-emerald-50 transition group"
              >
                <span className="text-2xl">👥</span>
                <div>
                  <p className="text-sm font-semibold text-slate-800 group-hover:text-emerald-700">
                    {isEn ? "Contacts" : "Contactos"}
                  </p>
                  <p className="text-xs text-slate-400">{isEn ? "Customers and leads" : "Clientes y leads"}</p>
                </div>
              </Link>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
