"use client";

import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { useMemo, useState } from "react";

export type AgendaTipo = "reunion" | "tarea" | "automatizacion" | "webhook";
export type AgendaEstado = "pendiente" | "en_progreso" | "completado";

export interface AgendaAssignment {
  agenteId: number;
}

export interface AgendaEventFormData {
  id?: number;
  titulo: string;
  descripcion: string;
  tipo: AgendaTipo;
  color: string;
  estado: AgendaEstado;
  startAt: string;
  endAt: string;
  reminderMinutes: number | null;
  flowId: number | null;
  triggerWebhookOnStart: boolean;
  webhookUrl: string;
  webhookMethod: string;
  webhookHeadersJson: string;
  webhookPayloadJson: string;
  assignments: AgendaAssignment[];
}

interface AgenteOption {
  id: number;
  nombre: string;
  email: string;
  estado: string;
}

export interface AppointmentSlotOption {
  id: string;
  label: string;
  startAt: string;
  endAt: string;
}

interface AgendaEventModalProps {
  open: boolean;
  event: AgendaEventFormData | null;
  agentes: AgenteOption[];
  saving: boolean;
  readOnly?: boolean;
  hideTechnicalSections?: boolean;
  appointmentMode?: boolean;
  appointmentStatusLabel?: string;
  appointmentSlots?: AppointmentSlotOption[];
  appointmentSlotsLoading?: boolean;
  appointmentRescheduling?: boolean;
  appointmentCancelling?: boolean;
  onClose: () => void;
  onSave: (payload: AgendaEventFormData) => Promise<void>;
  onDelete?: (id: number) => Promise<void>;
  onTriggerStart?: (id: number) => Promise<void>;
  onRescheduleAppointment?: (slotId: string) => Promise<void>;
  onCancelAppointment?: () => Promise<void>;
}

const EMPTY_EVENT: AgendaEventFormData = {
  titulo: "",
  descripcion: "",
  tipo: "reunion",
  color: "#60A5FA",
  estado: "pendiente",
  startAt: "",
  endAt: "",
  reminderMinutes: 15,
  flowId: null,
  triggerWebhookOnStart: false,
  webhookUrl: "",
  webhookMethod: "POST",
  webhookHeadersJson: "{}",
  webhookPayloadJson: "{}",
  assignments: [],
};

export function AgendaEventModal({
  open,
  event,
  agentes,
  saving,
  readOnly = false,
  hideTechnicalSections = false,
  appointmentMode = false,
  appointmentStatusLabel,
  appointmentSlots = [],
  appointmentSlotsLoading = false,
  appointmentRescheduling = false,
  appointmentCancelling = false,
  onClose,
  onSave,
  onDelete,
  onTriggerStart,
  onRescheduleAppointment,
  onCancelAppointment,
}: AgendaEventModalProps) {
  const [form, setForm] = useState<AgendaEventFormData>(event ?? EMPTY_EVENT);
  const [error, setError] = useState("");
  const [selectedAppointmentSlotId, setSelectedAppointmentSlotId] = useState("");

  const isEdit = useMemo(() => Boolean(form.id), [form.id]);
  const showWebhookSections = !hideTechnicalSections && form.tipo === "webhook";

  function set<K extends keyof AgendaEventFormData>(key: K, value: AgendaEventFormData[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function toggleAssignment(agenteId: number) {
    setForm((prev) => {
      const exists = prev.assignments.some((a) => a.agenteId === agenteId);
      return {
        ...prev,
        assignments: exists
          ? prev.assignments.filter((a) => a.agenteId !== agenteId)
          : [...prev.assignments, { agenteId }],
      };
    });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (readOnly) return;
    setError("");

    if (!form.titulo.trim()) {
      setError("El titulo es obligatorio");
      return;
    }
    if (!form.startAt || !form.endAt || new Date(form.startAt) >= new Date(form.endAt)) {
      setError("El rango de tiempo es invalido");
      return;
    }

    try {
      JSON.parse(form.webhookHeadersJson || "{}");
      JSON.parse(form.webhookPayloadJson || "{}");
    } catch {
      setError("Webhook headers/payload deben ser JSON valido");
      return;
    }

    await onSave(form);
  }

  async function handleAppointmentReschedule() {
    if (!onRescheduleAppointment) return;
    if (!selectedAppointmentSlotId) {
      setError("Selecciona un horario disponible para reprogramar la cita");
      return;
    }
    setError("");
    await onRescheduleAppointment(selectedAppointmentSlotId);
  }

  return (
    <Modal open={open} onClose={onClose} title={appointmentMode || readOnly ? "Detalle de cita" : isEdit ? "Editar evento" : "Nuevo evento"} className="max-w-3xl">
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Input label="Titulo" value={form.titulo} onChange={(e) => set("titulo", e.target.value)} required disabled={readOnly} />
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-slate-700">Color</label>
            <input
              type="color"
              className="h-11 w-full rounded-xl border border-slate-200 bg-white px-2"
              value={form.color}
              onChange={(e) => set("color", e.target.value)}
              disabled={readOnly}
            />
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium text-slate-700">Descripcion</label>
          <textarea
            className="min-h-20 rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500/40"
            value={form.descripcion}
            onChange={(e) => set("descripcion", e.target.value)}
            readOnly={readOnly}
          />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-slate-700">Tipo</label>
            <select
              className="h-11 rounded-xl border border-slate-200 px-3 text-sm"
              value={form.tipo}
              onChange={(e) => set("tipo", e.target.value as AgendaTipo)}
              disabled={readOnly}
            >
              <option value="reunion">Reunion</option>
              <option value="tarea">Tarea</option>
              <option value="automatizacion">Automatizacion</option>
              <option value="webhook">Webhook</option>
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-slate-700">Estado</label>
            <select
              className="h-11 rounded-xl border border-slate-200 px-3 text-sm"
              value={form.estado}
              onChange={(e) => set("estado", e.target.value as AgendaEstado)}
              disabled={readOnly}
            >
              <option value="pendiente">Pendiente</option>
              <option value="en_progreso">En progreso</option>
              <option value="completado">Completado</option>
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-slate-700">Notificar antes (min)</label>
            <input
              type="number"
              min={0}
              className="h-11 rounded-xl border border-slate-200 px-3 text-sm"
              value={form.reminderMinutes ?? ""}
              onChange={(e) => {
                const next = e.target.value === "" ? null : Number(e.target.value);
                set("reminderMinutes", Number.isNaN(next) ? null : next);
              }}
              disabled={readOnly}
            />
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Input
            type="datetime-local"
            label="Inicio"
            value={form.startAt}
            onChange={(e) => set("startAt", e.target.value)}
            required
            disabled={readOnly}
          />
          <Input
            type="datetime-local"
            label="Fin"
            value={form.endAt}
            onChange={(e) => set("endAt", e.target.value)}
            required
            disabled={readOnly}
          />
        </div>

        {appointmentMode && (
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 space-y-3">
            <div>
              <h4 className="text-sm font-semibold text-slate-900">Editar cita</h4>
              <p className="mt-1 text-xs text-slate-500">
                {appointmentStatusLabel ? `Estado actual: ${appointmentStatusLabel}. ` : ""}
                Puedes reprogramar la cita a un horario disponible o cancelarla.
              </p>
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium text-slate-700">Nuevo horario</label>
              <select
                value={selectedAppointmentSlotId}
                onChange={(e) => setSelectedAppointmentSlotId(e.target.value)}
                disabled={appointmentSlotsLoading || appointmentRescheduling || appointmentCancelling || appointmentSlots.length === 0}
                className="h-11 rounded-xl border border-slate-200 px-3 text-sm bg-white"
              >
                <option value="">{appointmentSlotsLoading ? "Cargando horarios..." : "Selecciona un horario disponible"}</option>
                {appointmentSlots.map((slot) => (
                  <option key={slot.id} value={slot.id}>
                    {slot.label}
                  </option>
                ))}
              </select>
              {!appointmentSlotsLoading && appointmentSlots.length === 0 && (
                <p className="text-xs text-slate-500">No hay horarios disponibles para reprogramar esta cita.</p>
              )}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
              <Button
                type="button"
                variant="danger"
                size="sm"
                onClick={() => onCancelAppointment?.()}
                disabled={appointmentCancelling || appointmentRescheduling || !onCancelAppointment}
              >
                {appointmentCancelling ? "Cancelando..." : "Cancelar cita"}
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={handleAppointmentReschedule}
                disabled={appointmentRescheduling || appointmentCancelling || !selectedAppointmentSlotId || !onRescheduleAppointment}
              >
                {appointmentRescheduling ? "Reprogramando..." : "Guardar cita"}
              </Button>
            </div>
          </div>
        )}

        {showWebhookSections && (
          <>
            <div className="rounded-xl border border-slate-200 px-3.5 py-2.5">
                <label className="flex items-center gap-2 text-sm font-medium text-slate-700">
                  <input
                    type="checkbox"
                    checked={form.triggerWebhookOnStart}
                    onChange={(e) => set("triggerWebhookOnStart", e.target.checked)}
                    disabled={readOnly}
                  />
                  Disparar webhook al iniciar
                </label>
                <p className="mt-1 text-xs text-slate-500">
                  Se ejecuta cuando el estado cambia a En progreso o manualmente.
                </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Input
                label="Webhook URL"
                value={form.webhookUrl}
                onChange={(e) => set("webhookUrl", e.target.value)}
                placeholder="https://api.tu-dominio.com/hook"
                disabled={readOnly}
              />
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium text-slate-700">Método del webhook</label>
                <select
                  className="h-11 rounded-xl border border-slate-200 px-3 text-sm"
                  value={form.webhookMethod}
                  onChange={(e) => set("webhookMethod", e.target.value)}
                  disabled={readOnly}
                >
                  <option value="POST">POST</option>
                  <option value="PUT">PUT</option>
                  <option value="PATCH">PATCH</option>
                </select>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium text-slate-700">Cabeceras del webhook (JSON)</label>
                <textarea
                  className="min-h-20 rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500/40 font-mono"
                  value={form.webhookHeadersJson}
                  onChange={(e) => set("webhookHeadersJson", e.target.value)}
                  readOnly={readOnly}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium text-slate-700">Carga útil del webhook (JSON)</label>
                <textarea
                  className="min-h-20 rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500/40 font-mono"
                  value={form.webhookPayloadJson}
                  onChange={(e) => set("webhookPayloadJson", e.target.value)}
                  readOnly={readOnly}
                />
              </div>
            </div>
          </>
        )}

        <div className="rounded-xl border border-slate-200 p-3.5">
          <h4 className="text-sm font-semibold text-slate-900 mb-2">Responsables</h4>
          <div className="max-h-36 overflow-y-auto space-y-1.5">
            {agentes.length === 0 && (
              <p className="text-xs text-slate-500">No hay agentes disponibles para asignar.</p>
            )}
            {agentes.map((agente) => {
              const checked = form.assignments.some((a) => a.agenteId === agente.id);
              return (
                <label key={agente.id} className="flex items-center justify-between rounded-lg px-2 py-1.5 hover:bg-slate-50">
                  <span className="text-sm text-slate-700">{agente.nombre} ({agente.email})</span>
                  <input type="checkbox" checked={checked} onChange={() => toggleAssignment(agente.id)} disabled={readOnly} />
                </label>
              );
            })}
          </div>
        </div>

        {error && (
          <p className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>
        )}

        <div className="flex items-center justify-between gap-2 pt-1">
          <div className="flex items-center gap-2">
            {!readOnly && !appointmentMode && isEdit && onDelete && form.id && (
              <Button
                type="button"
                variant="danger"
                size="sm"
                onClick={() => onDelete(form.id!)}
                disabled={saving}
              >
                Eliminar
              </Button>
            )}
            {!readOnly && !appointmentMode && isEdit && onTriggerStart && form.id && (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => onTriggerStart(form.id!)}
                disabled={saving}
              >
                Disparar webhook
              </Button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>{readOnly ? "Cerrar" : "Cancelar"}</Button>
            {!readOnly && !appointmentMode && (
              <Button type="submit" disabled={saving}>{saving ? "Guardando..." : "Guardar"}</Button>
            )}
          </div>
        </div>
      </form>
    </Modal>
  );
}
