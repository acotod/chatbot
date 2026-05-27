"use client";

import { agentePuestosApi, agentesApi, adminUsersApi, calendarsApi } from "@/lib/api";
import { useAuthStore } from "@/store/auth";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { Modal } from "@/components/ui/Modal";
import { Input } from "@/components/ui/Input";
import { ExternalLink, Plus, ToggleLeft, ToggleRight } from "lucide-react";

interface Agente {
  id: number;
  nombre: string;
  email: string;
  passwordConfigured?: boolean;
  whatsapp?: string | null;
  calendarLink?: string | null;
  puestoId?: number | null;
  puesto?: { id: number; nombre: string } | null;
  jefeAdminId?: number | null;
  jefeAdmin?: { id: number; nombre: string } | null;
  estado: string;
}

interface AdminUserItem {
  id: number;
  nombre: string;
  email: string;
}

interface Calendar {
  id: string;
  name: string;
  agenteId: number | null;
}

interface GoogleCalendarItem {
  id: string;
  summary: string;
  primary: boolean;
  accessRole: string | null;
}

interface AgentePuesto {
  id: number;
  nombre: string;
}

function getApiErrorMessage(error: unknown, fallback: string) {
  const message = (error as { response?: { data?: { error?: unknown } } })?.response?.data?.error;
  if (typeof message === "string" && message.trim()) {
    return message;
  }
  return fallback;
}

export default function AgentesPage() {
  const t = useTranslations("agentes");
  const { tenantSlug } = useAuthStore();
  const qc = useQueryClient();
  const [modal, setModal] = useState(false);
  const [editModal, setEditModal] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState({
    nombre: "",
    email: "",
    password: "",
    whatsapp: "",
    puestoId: "",
    calendarLink: "",
    calendarId: "",
  });
  const [formError, setFormError] = useState("");
  const [editForm, setEditForm] = useState({
    nombre: "",
    email: "",
    password: "",
    whatsapp: "",
    puestoId: "",
    calendarLink: "",
    calendarId: "",
    jefeAdminId: "",
  });
  const [editFormError, setEditFormError] = useState("");
  const [googleCalendars, setGoogleCalendars] = useState<GoogleCalendarItem[]>([]);
  const [selectedGoogleCalendarId, setSelectedGoogleCalendarId] = useState("");
  const [googleCalendarError, setGoogleCalendarError] = useState("");
  const [googleCalendarInfo, setGoogleCalendarInfo] = useState("");

  const { data, isLoading } = useQuery({
    queryKey: ["agentes", tenantSlug],
    queryFn: () => agentesApi.list(tenantSlug).then((r) => r.data),
    enabled: !!tenantSlug,
  });

  const { data: puestosData } = useQuery({
    queryKey: ["agente-puestos", tenantSlug],
    queryFn: () => agentePuestosApi.list(tenantSlug).then((r) => r.data),
    enabled: !!tenantSlug,
  });

  const { data: calendarsData } = useQuery({
    queryKey: ["calendars", tenantSlug],
    queryFn: () => calendarsApi.list(tenantSlug).then((r) => r.data),
    enabled: !!tenantSlug,
  });

  const { data: adminUsersData } = useQuery({
    queryKey: ["admin-users", tenantSlug],
    queryFn: () => adminUsersApi.list(tenantSlug!).then((r) => r.data),
    enabled: !!tenantSlug,
  });

  const create = useMutation({
    mutationFn: () =>
      agentesApi.create(tenantSlug, {
        nombre: form.nombre,
        email: form.email,
        password: form.password.trim() || undefined,
        whatsapp: form.whatsapp,
        puestoId: Number(form.puestoId),
        calendarLink: form.calendarLink,
        calendarId: form.calendarId || null,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["agentes"] });
      setModal(false);
      setForm({ nombre: "", email: "", password: "", whatsapp: "", puestoId: "", calendarLink: "", calendarId: "" });
    },
    onError: (error) => setFormError(getApiErrorMessage(error, t("errors.createFailed"))),
  });

  const toggle = useMutation({
    mutationFn: ({ id, estado }: { id: number; estado: string }) =>
      agentesApi.updateEstado(tenantSlug, id, estado),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["agentes"] }),
  });

  const update = useMutation({
    mutationFn: () => {
      if (!editingId) throw new Error("Missing agent id");
      return agentesApi.update(tenantSlug, editingId, {
        nombre: editForm.nombre,
        email: editForm.email,
        password: editForm.password.trim() || undefined,
        whatsapp: editForm.whatsapp,
        puestoId: Number(editForm.puestoId),
        calendarLink: editForm.calendarLink,
        calendarId: editForm.calendarId || null,
        jefeAdminId: editForm.jefeAdminId ? Number(editForm.jefeAdminId) : null,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["agentes"] });
      setEditModal(false);
      setEditingId(null);
      setEditForm({ nombre: "", email: "", password: "", whatsapp: "", puestoId: "", calendarLink: "", calendarId: "", jefeAdminId: "" });
    },
    onError: (error) => setEditFormError(getApiErrorMessage(error, t("errors.updateFailed"))),
  });

  const startGoogleOauth = useMutation({
    mutationFn: async () => {
      if (!tenantSlug) throw new Error("Missing tenant slug");
      if (!editForm.calendarId) throw new Error("Select an internal calendar first");
      return calendarsApi.googleOauthStart(tenantSlug, editForm.calendarId);
    },
    onSuccess: (response) => {
      const authUrl = response.data?.authorizationUrl;
      if (!authUrl) {
        setGoogleCalendarError("No se pudo obtener la URL de autorizacion de Google.");
        return;
      }
      setGoogleCalendarError("");
      setGoogleCalendarInfo("Ventana de autorizacion abierta. Completa el consentimiento y luego pulsa 'Cargar calendarios Google'.");
      window.open(authUrl, "google-calendar-oauth", "width=560,height=720");
    },
    onError: (error) => setGoogleCalendarError(getApiErrorMessage(error, "No se pudo iniciar OAuth con Google.")),
  });

  const loadGoogleCalendars = useMutation({
    mutationFn: async () => {
      if (!tenantSlug) throw new Error("Missing tenant slug");
      if (!editForm.calendarId) throw new Error("Select an internal calendar first");
      return calendarsApi.googleListCalendars(tenantSlug, editForm.calendarId);
    },
    onSuccess: (response) => {
      const items = response.data?.data ?? [];
      setGoogleCalendars(items);
      const preferred = items.find((item) => item.primary) ?? items[0];
      setSelectedGoogleCalendarId(preferred?.id ?? "");
      setGoogleCalendarError("");
      setGoogleCalendarInfo(items.length > 0
        ? "Calendarios de Google cargados. Selecciona uno y pulsa 'Vincular calendario Google'."
        : "No se encontraron calendarios disponibles en la cuenta conectada.");
    },
    onError: (error) => setGoogleCalendarError(getApiErrorMessage(error, "No se pudieron cargar calendarios de Google.")),
  });

  const connectGoogleCalendar = useMutation({
    mutationFn: async () => {
      if (!tenantSlug) throw new Error("Missing tenant slug");
      if (!editForm.calendarId) throw new Error("Select an internal calendar first");
      if (!selectedGoogleCalendarId) throw new Error("Select a Google calendar");
      return calendarsApi.googleConnect(tenantSlug, editForm.calendarId, selectedGoogleCalendarId);
    },
    onSuccess: () => {
      setGoogleCalendarError("");
      setGoogleCalendarInfo("Calendario de Google vinculado correctamente.");
    },
    onError: (error) => setGoogleCalendarError(getApiErrorMessage(error, "No se pudo vincular el calendario de Google.")),
  });

  const disconnectGoogleCalendar = useMutation({
    mutationFn: async () => {
      if (!tenantSlug) throw new Error("Missing tenant slug");
      if (!editForm.calendarId) throw new Error("Select an internal calendar first");
      return calendarsApi.googleDisconnect(tenantSlug, editForm.calendarId);
    },
    onSuccess: () => {
      setGoogleCalendarError("");
      setGoogleCalendarInfo("Conexion de Google Calendar eliminada.");
      setGoogleCalendars([]);
      setSelectedGoogleCalendarId("");
    },
    onError: (error) => setGoogleCalendarError(getApiErrorMessage(error, "No se pudo desconectar Google Calendar.")),
  });

  const agentes: Agente[] = data?.data ?? data ?? [];
  const puestos: AgentePuesto[] = puestosData?.data ?? puestosData ?? [];
  const calendars: Calendar[] = calendarsData?.data ?? calendarsData ?? [];
  const adminUsers: AdminUserItem[] = adminUsersData?.data ?? adminUsersData ?? [];
  const usedCalendarIds = new Set(
    calendars
      .filter((c) => c.agenteId !== null)
      .map((c) => c.id),
  );
  const activos = agentes.filter((a) => a.estado === "activo").length;

  function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setFormError("");
    if (!form.nombre.trim() || !form.email.trim() || !form.whatsapp.trim() || !form.puestoId) {
      setFormError(t("errors.requiredFields"));
      return;
    }
    if (form.password.trim() && form.password.trim().length < 8) {
      setFormError(t("errors.passwordMin"));
      return;
    }

    if (form.calendarLink.trim()) {
      try {
        const parsed = new URL(form.calendarLink);
        if (!["http:", "https:"].includes(parsed.protocol)) {
          setFormError(t("errors.calendarProtocol"));
          return;
        }
      } catch {
        setFormError(t("errors.calendarInvalid"));
        return;
      }
    }

    create.mutate();
  }

  function openEdit(agent: Agente) {
    setEditFormError("");
    setEditingId(agent.id);
    setEditForm({
      nombre: agent.nombre ?? "",
      email: agent.email ?? "",
      password: "",
      whatsapp: agent.whatsapp ?? "",
      puestoId: agent.puestoId ? String(agent.puestoId) : "",
      calendarLink: agent.calendarLink ?? "",
      calendarId: calendars.find((c) => c.agenteId === agent.id)?.id ?? "",
      jefeAdminId: agent.jefeAdminId ? String(agent.jefeAdminId) : "",
    });
    setGoogleCalendars([]);
    setSelectedGoogleCalendarId("");
    setGoogleCalendarError("");
    setGoogleCalendarInfo("");
    setEditModal(true);
  }

  function handleUpdate(e: React.FormEvent) {
    e.preventDefault();
    setEditFormError("");
    if (!editForm.nombre.trim() || !editForm.email.trim() || !editForm.whatsapp.trim() || !editForm.puestoId) {
      setEditFormError(t("errors.requiredFields"));
      return;
    }
    if (editForm.password.trim() && editForm.password.trim().length < 8) {
      setEditFormError(t("errors.passwordMin"));
      return;
    }

    if (editForm.calendarLink.trim()) {
      try {
        const parsed = new URL(editForm.calendarLink);
        if (!["http:", "https:"].includes(parsed.protocol)) {
          setEditFormError(t("errors.calendarProtocol"));
          return;
        }
      } catch {
        setEditFormError(t("errors.calendarInvalid"));
        return;
      }
    }

    update.mutate();
  }

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm text-slate-500">
            {t("header.stats", { active: activos, total: agentes.length })}
          </p>
        </div>
        <Button onClick={() => setModal(true)}>
          <Plus size={16} />
          {t("header.newAgent")}
        </Button>
      </div>

      {/* Cards grid */}
      {isLoading ? (
        <p className="text-slate-400 text-sm">{t("list.loading")}</p>
      ) : agentes.length === 0 ? (
        <Card>
          <div className="py-16 text-center">
            <p className="text-slate-400 text-sm">{t("list.empty")}</p>
            <button
              onClick={() => setModal(true)}
              className="mt-3 text-blue-600 text-sm font-medium hover:text-blue-700"
            >
              {t("list.createFirst")}
            </button>
          </div>
        </Card>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
          {agentes.map((a) => (
            <Card key={a.id}>
              <div className="p-5 flex items-start justify-between gap-4">
                <div className="flex items-start gap-3">
                  {/* Avatar */}
                  <div className="w-10 h-10 rounded-full bg-blue-100 text-blue-700 flex items-center justify-center text-sm font-semibold shrink-0">
                    {a.nombre.charAt(0).toUpperCase()}
                  </div>
                  <div>
                    <p className="font-medium text-slate-900">{a.nombre}</p>
                    <p className="text-xs text-slate-500 mt-0.5">{a.email}</p>
                    {a.whatsapp && <p className="text-xs text-slate-500">{t("card.whatsapp", { value: a.whatsapp })}</p>}
                    {a.puesto?.nombre && <p className="text-xs text-slate-500">{t("card.position", { value: a.puesto.nombre })}</p>}
                    {a.jefeAdmin?.nombre && <p className="text-xs text-slate-500">{t("card.manager", { value: a.jefeAdmin.nombre })}</p>}
                    <p className="text-xs text-slate-500">
                      {t("card.agentAccess", {
                        status: a.passwordConfigured ? t("card.accessEnabled") : t("card.accessMissing"),
                      })}
                    </p>
                    {a.calendarLink && (
                      <a
                        href={a.calendarLink}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-1 inline-flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700"
                      >
                        {t("card.viewCalendar")} <ExternalLink size={12} />
                      </a>
                    )}
                    <StatusBadge status={a.estado} className="mt-2" />
                  </div>
                </div>
                <button
                  onClick={() =>
                    toggle.mutate({
                      id: a.id,
                      estado: a.estado === "activo" ? "inactivo" : "activo",
                    })
                  }
                  className="mt-0.5 text-slate-400 hover:text-blue-600 transition"
                  title={a.estado === "activo" ? t("actions.deactivate") : t("actions.activate")}
                >
                  {a.estado === "activo" ? (
                    <ToggleRight size={24} className="text-blue-600" />
                  ) : (
                    <ToggleLeft size={24} />
                  )}
                </button>
                <button
                  onClick={() => openEdit(a)}
                  className="mt-0.5 text-slate-400 hover:text-blue-600 transition text-xs"
                  title={t("actions.editAgent")}
                >
                  {t("actions.edit")}
                </button>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* Create modal */}
      <Modal
        open={modal}
        onClose={() => {
          setModal(false);
          setFormError("");
        }}
        title={t("modalCreate.title")}
      >
        <form onSubmit={handleCreate} className="space-y-4">
          <Input
            label={t("fields.fullName")}
            value={form.nombre}
            onChange={(e) => setForm((f) => ({ ...f, nombre: e.target.value }))}
            placeholder={t("fields.fullNamePlaceholder")}
          />
          <Input
            label={t("fields.email")}
            type="email"
            value={form.email}
            onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
            placeholder={t("fields.emailPlaceholder")}
          />
          <Input
            label={t("fields.accessPassword")}
            type="password"
            value={form.password}
            onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
            placeholder={t("fields.passwordPlaceholder")}
          />
          <p className="-mt-2 text-xs text-slate-500">{t("modalCreate.passwordHint")}</p>
          <Input
            label={t("fields.whatsapp")}
            value={form.whatsapp}
            onChange={(e) => setForm((f) => ({ ...f, whatsapp: e.target.value }))}
            placeholder="+5215512345678"
          />
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">{t("fields.position")}</label>
            <div className="flex gap-2">
              <select
                value={form.puestoId}
                onChange={(e) => setForm((f) => ({ ...f, puestoId: e.target.value }))}
                className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500"
              >
                <option value="">{t("fields.selectPosition")}</option>
                {puestos.map((p) => (
                  <option key={p.id} value={p.id}>{p.nombre}</option>
                ))}
              </select>
            </div>
            <p className="mt-2 text-xs text-slate-500">{t("modalCreate.positionHint")}</p>
          </div>
          <Input
            label={t("fields.calendarLink")}
            value={form.calendarLink}
            onChange={(e) => setForm((f) => ({ ...f, calendarLink: e.target.value }))}
            placeholder="https://calendar.google.com/..."
          />
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">{t("fields.internalCalendarOptional")}</label>
            <select
              value={form.calendarId}
              onChange={(e) => setForm((f) => ({ ...f, calendarId: e.target.value }))}
              className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500"
            >
              <option value="">{t("fields.noInternalCalendar")}</option>
              {calendars.map((c) => (
                <option key={c.id} value={c.id} disabled={usedCalendarIds.has(c.id)}>
                  {c.name}{usedCalendarIds.has(c.id) ? t("fields.assignedSuffix") : ""}
                </option>
              ))}
            </select>
          </div>
          {formError && <p className="text-sm text-red-600">{formError}</p>}
          <div className="flex justify-end gap-3 pt-2">
            <Button
              type="button"
              variant="secondary"
              onClick={() => setModal(false)}
            >
              {t("actions.cancel")}
            </Button>
            <Button type="submit" disabled={create.isPending}>
              {create.isPending ? t("actions.creating") : t("actions.createAgent")}
            </Button>
          </div>
        </form>
      </Modal>

      {/* Edit modal */}
      <Modal
        open={editModal}
        onClose={() => {
          setEditModal(false);
          setEditingId(null);
          setEditFormError("");
        }}
        title={t("modalEdit.title")}
      >
        <form onSubmit={handleUpdate} className="space-y-4">
          <Input
            label={t("fields.fullName")}
            value={editForm.nombre}
            onChange={(e) => setEditForm((f) => ({ ...f, nombre: e.target.value }))}
            placeholder={t("fields.fullNamePlaceholder")}
          />
          <Input
            label={t("fields.email")}
            type="email"
            value={editForm.email}
            onChange={(e) => setEditForm((f) => ({ ...f, email: e.target.value }))}
            placeholder={t("fields.emailPlaceholder")}
          />
          <Input
            label={t("fields.newAccessPassword")}
            type="password"
            value={editForm.password}
            onChange={(e) => setEditForm((f) => ({ ...f, password: e.target.value }))}
            placeholder={t("fields.newPasswordPlaceholder")}
          />
          <p className="-mt-2 text-xs text-slate-500">{t("modalEdit.profileHint")}</p>
          <Input
            label={t("fields.whatsapp")}
            value={editForm.whatsapp}
            onChange={(e) => setEditForm((f) => ({ ...f, whatsapp: e.target.value }))}
            placeholder="+5215512345678"
          />
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">{t("fields.position")}</label>
            <select
              value={editForm.puestoId}
              onChange={(e) => setEditForm((f) => ({ ...f, puestoId: e.target.value }))}
              className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500"
            >
              <option value="">{t("fields.selectPosition")}</option>
              {puestos.map((p) => (
                <option key={p.id} value={p.id}>{p.nombre}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">{t("fields.manager")}</label>
            <select
              value={editForm.jefeAdminId}
              onChange={(e) => setEditForm((f) => ({ ...f, jefeAdminId: e.target.value }))}
              className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500"
            >
              <option value="">{t("fields.noManagerAssigned")}</option>
              {adminUsers.map((u) => (
                <option key={u.id} value={u.id}>{u.nombre} ({u.email})</option>
              ))}
            </select>
          </div>
          <Input
            label={t("fields.calendarLink")}
            value={editForm.calendarLink}
            onChange={(e) => setEditForm((f) => ({ ...f, calendarLink: e.target.value }))}
            placeholder="https://calendar.google.com/..."
          />
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">{t("fields.internalCalendarOptional")}</label>
            <select
              value={editForm.calendarId}
              onChange={(e) => {
                const value = e.target.value;
                setEditForm((f) => ({ ...f, calendarId: value }));
                setGoogleCalendars([]);
                setSelectedGoogleCalendarId("");
                setGoogleCalendarError("");
                setGoogleCalendarInfo("");
              }}
              className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500"
            >
              <option value="">{t("fields.noInternalCalendar")}</option>
              {calendars.map((c) => {
                const currentlyAssigned = c.agenteId === editingId;
                const disabled = !!c.agenteId && !currentlyAssigned;
                return (
                  <option key={c.id} value={c.id} disabled={disabled}>
                    {c.name}{disabled ? t("fields.assignedSuffix") : ""}
                  </option>
                );
              })}
            </select>
          </div>
          {editForm.calendarId && (
            <div className="rounded-md border border-slate-200 bg-slate-50 p-3 space-y-3">
              <p className="text-sm font-medium text-slate-800">Google Calendar OAuth</p>
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="secondary" onClick={() => startGoogleOauth.mutate()} disabled={startGoogleOauth.isPending}>
                  {startGoogleOauth.isPending ? "Abriendo OAuth..." : "Conectar con Google"}
                </Button>
                <Button type="button" variant="secondary" onClick={() => loadGoogleCalendars.mutate()} disabled={loadGoogleCalendars.isPending}>
                  {loadGoogleCalendars.isPending ? "Cargando..." : "Cargar calendarios Google"}
                </Button>
                <Button type="button" variant="secondary" onClick={() => disconnectGoogleCalendar.mutate()} disabled={disconnectGoogleCalendar.isPending}>
                  {disconnectGoogleCalendar.isPending ? "Desconectando..." : "Desconectar Google"}
                </Button>
              </div>

              {googleCalendars.length > 0 && (
                <div className="space-y-2">
                  <label className="block text-sm font-medium text-slate-700">Calendario Google destino</label>
                  <select
                    value={selectedGoogleCalendarId}
                    onChange={(e) => setSelectedGoogleCalendarId(e.target.value)}
                    className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500"
                  >
                    {googleCalendars.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.summary}{item.primary ? " (primary)" : ""}
                      </option>
                    ))}
                  </select>
                  <Button
                    type="button"
                    onClick={() => connectGoogleCalendar.mutate()}
                    disabled={connectGoogleCalendar.isPending || !selectedGoogleCalendarId}
                  >
                    {connectGoogleCalendar.isPending ? "Vinculando..." : "Vincular calendario Google"}
                  </Button>
                </div>
              )}

              {googleCalendarInfo && <p className="text-xs text-emerald-700">{googleCalendarInfo}</p>}
              {googleCalendarError && <p className="text-xs text-rose-600">{googleCalendarError}</p>}
            </div>
          )}
          {editFormError && <p className="text-sm text-red-600">{editFormError}</p>}
          <div className="flex justify-end gap-3 pt-2">
            <Button
              type="button"
              variant="secondary"
              onClick={() => setEditModal(false)}
            >
              {t("actions.cancel")}
            </Button>
            <Button type="submit" disabled={update.isPending}>
              {update.isPending ? t("actions.saving") : t("actions.saveChanges")}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
