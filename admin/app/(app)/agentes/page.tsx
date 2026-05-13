"use client";

import { agentePuestosApi, agentesApi, adminUsersApi, calendarsApi } from "@/lib/api";
import { useAuthStore } from "@/store/auth";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
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

interface AgentePuesto {
  id: number;
  nombre: string;
}

export default function AgentesPage() {
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
    onError: () => setFormError("No se pudo crear el agente. Intentá de nuevo."),
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
    onError: () => setEditFormError("No se pudo actualizar el agente."),
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
      setFormError("Completá nombre, email, WhatsApp y puesto.");
      return;
    }
    if (form.password.trim() && form.password.trim().length < 8) {
      setFormError("La contraseña del agente debe tener al menos 8 caracteres.");
      return;
    }

    if (form.calendarLink.trim()) {
      try {
        const parsed = new URL(form.calendarLink);
        if (!["http:", "https:"].includes(parsed.protocol)) {
          setFormError("La liga del calendario debe iniciar con http:// o https://");
          return;
        }
      } catch {
        setFormError("La liga del calendario no es valida.");
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
    setEditModal(true);
  }

  function handleUpdate(e: React.FormEvent) {
    e.preventDefault();
    setEditFormError("");
    if (!editForm.nombre.trim() || !editForm.email.trim() || !editForm.whatsapp.trim() || !editForm.puestoId) {
      setEditFormError("Completá nombre, email, WhatsApp y puesto.");
      return;
    }
    if (editForm.password.trim() && editForm.password.trim().length < 8) {
      setEditFormError("La contraseña del agente debe tener al menos 8 caracteres.");
      return;
    }

    if (editForm.calendarLink.trim()) {
      try {
        const parsed = new URL(editForm.calendarLink);
        if (!["http:", "https:"].includes(parsed.protocol)) {
          setEditFormError("La liga del calendario debe iniciar con http:// o https://");
          return;
        }
      } catch {
        setEditFormError("La liga del calendario no es valida.");
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
            {activos} activos · {agentes.length} en total
          </p>
        </div>
        <Button onClick={() => setModal(true)}>
          <Plus size={16} />
          Nuevo agente
        </Button>
      </div>

      {/* Cards grid */}
      {isLoading ? (
        <p className="text-slate-400 text-sm">Cargando agentes...</p>
      ) : agentes.length === 0 ? (
        <Card>
          <div className="py-16 text-center">
            <p className="text-slate-400 text-sm">No hay agentes registrados.</p>
            <button
              onClick={() => setModal(true)}
              className="mt-3 text-blue-600 text-sm font-medium hover:text-blue-700"
            >
              Crear el primero →
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
                    {a.whatsapp && <p className="text-xs text-slate-500">WhatsApp: {a.whatsapp}</p>}
                    {a.puesto?.nombre && <p className="text-xs text-slate-500">Puesto: {a.puesto.nombre}</p>}
                    {a.jefeAdmin?.nombre && <p className="text-xs text-slate-500">Jefe: {a.jefeAdmin.nombre}</p>}
                    <p className="text-xs text-slate-500">
                      Acceso agente: {a.passwordConfigured ? "habilitado" : "sin credenciales"}
                    </p>
                    {a.calendarLink && (
                      <a
                        href={a.calendarLink}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-1 inline-flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700"
                      >
                        Ver calendario <ExternalLink size={12} />
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
                  title={a.estado === "activo" ? "Desactivar" : "Activar"}
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
                  title="Editar agente"
                >
                  Editar
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
        title="Nuevo agente"
      >
        <form onSubmit={handleCreate} className="space-y-4">
          <Input
            label="Nombre completo"
            value={form.nombre}
            onChange={(e) => setForm((f) => ({ ...f, nombre: e.target.value }))}
            placeholder="Ej: María González"
          />
          <Input
            label="Email"
            type="email"
            value={form.email}
            onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
            placeholder="maria@clinica.com"
          />
          <Input
            label="Contraseña de acceso"
            type="password"
            value={form.password}
            onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
            placeholder="Mínimo 8 caracteres"
          />
          <p className="-mt-2 text-xs text-slate-500">Si la definís, el agente podrá entrar por /agente/login con su tenant, email y contraseña.</p>
          <Input
            label="WhatsApp"
            value={form.whatsapp}
            onChange={(e) => setForm((f) => ({ ...f, whatsapp: e.target.value }))}
            placeholder="+5215512345678"
          />
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Puesto</label>
            <div className="flex gap-2">
              <select
                value={form.puestoId}
                onChange={(e) => setForm((f) => ({ ...f, puestoId: e.target.value }))}
                className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500"
              >
                <option value="">Selecciona un puesto...</option>
                {puestos.map((p) => (
                  <option key={p.id} value={p.id}>{p.nombre}</option>
                ))}
              </select>
            </div>
            <p className="mt-2 text-xs text-slate-500">Administrá el catálogo en Configuración.</p>
          </div>
          <Input
            label="Liga de calendario"
            value={form.calendarLink}
            onChange={(e) => setForm((f) => ({ ...f, calendarLink: e.target.value }))}
            placeholder="https://calendar.google.com/..."
          />
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Calendario interno (opcional)</label>
            <select
              value={form.calendarId}
              onChange={(e) => setForm((f) => ({ ...f, calendarId: e.target.value }))}
              className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500"
            >
              <option value="">Sin calendario interno</option>
              {calendars.map((c) => (
                <option key={c.id} value={c.id} disabled={usedCalendarIds.has(c.id)}>
                  {c.name}{usedCalendarIds.has(c.id) ? " (asignado)" : ""}
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
              Cancelar
            </Button>
            <Button type="submit" disabled={create.isPending}>
              {create.isPending ? "Creando..." : "Crear agente 💙"}
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
        title="Editar agente"
      >
        <form onSubmit={handleUpdate} className="space-y-4">
          <Input
            label="Nombre completo"
            value={editForm.nombre}
            onChange={(e) => setEditForm((f) => ({ ...f, nombre: e.target.value }))}
            placeholder="Ej: María González"
          />
          <Input
            label="Email"
            type="email"
            value={editForm.email}
            onChange={(e) => setEditForm((f) => ({ ...f, email: e.target.value }))}
            placeholder="maria@clinica.com"
          />
          <Input
            label="Nueva contraseña de acceso"
            type="password"
            value={editForm.password}
            onChange={(e) => setEditForm((f) => ({ ...f, password: e.target.value }))}
            placeholder="Dejala vacía para conservar la actual"
          />
          <p className="-mt-2 text-xs text-slate-500">Este perfil usa un acceso único sin módulos adicionales: solo login y perfil de agente.</p>
          <Input
            label="WhatsApp"
            value={editForm.whatsapp}
            onChange={(e) => setEditForm((f) => ({ ...f, whatsapp: e.target.value }))}
            placeholder="+5215512345678"
          />
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Puesto</label>
            <select
              value={editForm.puestoId}
              onChange={(e) => setEditForm((f) => ({ ...f, puestoId: e.target.value }))}
              className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500"
            >
              <option value="">Selecciona un puesto...</option>
              {puestos.map((p) => (
                <option key={p.id} value={p.id}>{p.nombre}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Jefe (supervisor admin)</label>
            <select
              value={editForm.jefeAdminId}
              onChange={(e) => setEditForm((f) => ({ ...f, jefeAdminId: e.target.value }))}
              className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500"
            >
              <option value="">Sin jefe asignado</option>
              {adminUsers.map((u) => (
                <option key={u.id} value={u.id}>{u.nombre} ({u.email})</option>
              ))}
            </select>
          </div>
          <Input
            label="Liga de calendario"
            value={editForm.calendarLink}
            onChange={(e) => setEditForm((f) => ({ ...f, calendarLink: e.target.value }))}
            placeholder="https://calendar.google.com/..."
          />
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Calendario interno (opcional)</label>
            <select
              value={editForm.calendarId}
              onChange={(e) => setEditForm((f) => ({ ...f, calendarId: e.target.value }))}
              className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500"
            >
              <option value="">Sin calendario interno</option>
              {calendars.map((c) => {
                const currentlyAssigned = c.agenteId === editingId;
                const disabled = !!c.agenteId && !currentlyAssigned;
                return (
                  <option key={c.id} value={c.id} disabled={disabled}>
                    {c.name}{disabled ? " (asignado)" : ""}
                  </option>
                );
              })}
            </select>
          </div>
          {editFormError && <p className="text-sm text-red-600">{editFormError}</p>}
          <div className="flex justify-end gap-3 pt-2">
            <Button
              type="button"
              variant="secondary"
              onClick={() => setEditModal(false)}
            >
              Cancelar
            </Button>
            <Button type="submit" disabled={update.isPending}>
              {update.isPending ? "Guardando..." : "Guardar cambios"}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
