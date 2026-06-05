"use client";

import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { useTranslations } from "@/lib/i18n/client";
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
  appointmentSlotsError?: string | null;
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
  appointmentSlotsError = null,
  appointmentRescheduling = false,
  appointmentCancelling = false,
  onClose,
  onSave,
  onDelete,
  onTriggerStart,
  onRescheduleAppointment,
  onCancelAppointment,
}: AgendaEventModalProps) {
  const t = useTranslations("agenda");
  const [form, setForm] = useState<AgendaEventFormData>(event ?? EMPTY_EVENT);
  const [error, setError] = useState("");
  const [selectedAppointmentSlotId, setSelectedAppointmentSlotId] = useState("");

  const isEdit = useMemo(() => Boolean(form.id), [form.id]);
  const showWebhookSections = !hideTechnicalSections && form.tipo === "webhook";

  function getErrorMessage(err: unknown, fallback: string) {
    if (typeof err === "string" && err.trim()) return err;
    if (err && typeof err === "object") {
      const maybeAxios = err as {
        response?: { data?: { message?: unknown; error?: unknown } };
        message?: unknown;
      };
      const apiMessage = maybeAxios.response?.data?.message;
      if (typeof apiMessage === "string" && apiMessage.trim()) return apiMessage;
      const apiError = maybeAxios.response?.data?.error;
      if (typeof apiError === "string" && apiError.trim()) return apiError;
      if (typeof maybeAxios.message === "string" && maybeAxios.message.trim()) return maybeAxios.message;
    }
    if (err instanceof Error && err.message.trim()) return err.message;
    return fallback;
  }

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
      setError(t("messages.titleRequired"));
      return;
    }
    const startDate = form.startAt ? new Date(form.startAt) : null;
    const endDate = form.endAt ? new Date(form.endAt) : null;
    const startTs = startDate?.getTime() ?? Number.NaN;
    const endTs = endDate?.getTime() ?? Number.NaN;
    if (!form.startAt || !form.endAt || Number.isNaN(startTs) || Number.isNaN(endTs) || startTs >= endTs) {
      setError(t("messages.invalidRange"));
      return;
    }

    try {
      JSON.parse(form.webhookHeadersJson || "{}");
      JSON.parse(form.webhookPayloadJson || "{}");
    } catch {
      setError(t("messages.webhookJsonInvalid"));
      return;
    }

    try {
      await onSave(form);
    } catch (err) {
      setError(getErrorMessage(err, t("messages.saveFailed")));
    }
  }

  async function handleAppointmentReschedule() {
    if (!onRescheduleAppointment) return;
    if (!selectedAppointmentSlotId) {
      setError(t("messages.selectSlotRequired"));
      return;
    }
    try {
      setError("");
      await onRescheduleAppointment(selectedAppointmentSlotId);
    } catch (err) {
      setError(getErrorMessage(err, t("messages.rescheduleFailed")));
    }
  }

  async function handleAppointmentCancel() {
    if (!onCancelAppointment) return;
    try {
      setError("");
      await onCancelAppointment();
    } catch (err) {
      setError(getErrorMessage(err, t("messages.cancelFailed")));
    }
  }

  async function handleDelete() {
    if (!onDelete || !form.id) return;
    try {
      setError("");
      await onDelete(form.id);
    } catch (err) {
      setError(getErrorMessage(err, t("messages.deleteFailed")));
    }
  }

  async function handleTriggerStart() {
    if (!onTriggerStart || !form.id) return;
    try {
      setError("");
      await onTriggerStart(form.id);
    } catch (err) {
      setError(getErrorMessage(err, t("messages.triggerFailed")));
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={appointmentMode || readOnly ? t("modal.appointmentDetail") : isEdit ? t("editEvent") : t("newEvent")} className="max-w-3xl">
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Input label={t("title")} value={form.titulo} onChange={(e) => set("titulo", e.target.value)} required disabled={readOnly} />
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-slate-700">{t("modal.color")}</label>
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
          <label className="text-sm font-medium text-slate-700">{t("description")}</label>
          <textarea
            className="min-h-20 rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500/40"
            value={form.descripcion}
            onChange={(e) => set("descripcion", e.target.value)}
            readOnly={readOnly}
          />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-slate-700">{t("table.type")}</label>
            <select
              className="h-11 rounded-xl border border-slate-200 px-3 text-sm"
              value={form.tipo}
              onChange={(e) => set("tipo", e.target.value as AgendaTipo)}
              disabled={readOnly}
            >
              <option value="reunion">{t("types.reunion")}</option>
              <option value="tarea">{t("types.tarea")}</option>
              <option value="automatizacion">{t("types.automatizacion")}</option>
              <option value="webhook">{t("types.webhook")}</option>
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-slate-700">{t("table.status")}</label>
            <select
              className="h-11 rounded-xl border border-slate-200 px-3 text-sm"
              value={form.estado}
              onChange={(e) => set("estado", e.target.value as AgendaEstado)}
              disabled={readOnly}
            >
              <option value="pendiente">{t("statuses.pendiente")}</option>
              <option value="en_progreso">{t("statuses.en_progreso")}</option>
              <option value="completado">{t("statuses.completado")}</option>
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-slate-700">{t("modal.reminderMinutes")}</label>
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
            label={t("table.start")}
            value={form.startAt}
            onChange={(e) => set("startAt", e.target.value)}
            required
            disabled={readOnly}
          />
          <Input
            type="datetime-local"
            label={t("table.end")}
            value={form.endAt}
            onChange={(e) => set("endAt", e.target.value)}
            required
            disabled={readOnly}
          />
        </div>

        {appointmentMode && (
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 space-y-3">
            <div>
              <h4 className="text-sm font-semibold text-slate-900">{t("modal.editAppointment")}</h4>
              <p className="mt-1 text-xs text-slate-500">
                {appointmentStatusLabel ? t("modal.currentStatus", { status: appointmentStatusLabel }) : ""}
                {" "}
                {t("modal.rescheduleHint")}
              </p>
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium text-slate-700">{t("modal.newSchedule")}</label>
              <select
                value={selectedAppointmentSlotId}
                onChange={(e) => setSelectedAppointmentSlotId(e.target.value)}
                disabled={appointmentSlotsLoading || appointmentRescheduling || appointmentCancelling || appointmentSlots.length === 0}
                className="h-11 rounded-xl border border-slate-200 px-3 text-sm bg-white"
              >
                <option value="">{appointmentSlotsLoading ? t("modal.loadingSchedules") : t("modal.selectAvailableSchedule")}</option>
                {appointmentSlots.map((slot) => (
                  <option key={slot.id} value={slot.id}>
                    {slot.label}
                  </option>
                ))}
              </select>
              {!appointmentSlotsLoading && appointmentSlots.length === 0 && (
                <p className="text-xs text-slate-500">{t("modal.noSchedules")}</p>
              )}
              {appointmentSlotsError && (
                <p className="text-xs text-red-600">{appointmentSlotsError}</p>
              )}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
              <Button
                type="button"
                variant="danger"
                size="sm"
                onClick={handleAppointmentCancel}
                disabled={appointmentCancelling || appointmentRescheduling || !onCancelAppointment}
              >
                {appointmentCancelling ? t("modal.cancelling") : t("modal.cancelAppointment")}
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={handleAppointmentReschedule}
                disabled={appointmentRescheduling || appointmentCancelling || !selectedAppointmentSlotId || !onRescheduleAppointment}
              >
                {appointmentRescheduling ? t("modal.rescheduling") : t("modal.saveAppointment")}
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
                  {t("modal.triggerWebhookOnStart")}
                </label>
                <p className="mt-1 text-xs text-slate-500">
                  {t("modal.triggerWebhookHint")}
                </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Input
                label={t("modal.webhookUrl")}
                value={form.webhookUrl}
                onChange={(e) => set("webhookUrl", e.target.value)}
                placeholder="https://api.tu-dominio.com/hook"
                disabled={readOnly}
              />
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium text-slate-700">{t("modal.webhookMethod")}</label>
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
                <label className="text-sm font-medium text-slate-700">{t("modal.webhookHeaders")}</label>
                <textarea
                  className="min-h-20 rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500/40 font-mono"
                  value={form.webhookHeadersJson}
                  onChange={(e) => set("webhookHeadersJson", e.target.value)}
                  readOnly={readOnly}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium text-slate-700">{t("modal.webhookPayload")}</label>
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
          <h4 className="text-sm font-semibold text-slate-900 mb-2">{t("modal.owners")}</h4>
          <div className="max-h-36 overflow-y-auto space-y-1.5">
            {agentes.length === 0 && (
              <p className="text-xs text-slate-500">{t("modal.noOwners")}</p>
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
                onClick={handleDelete}
                disabled={saving}
              >
                {t("deleteEvent")}
              </Button>
            )}
            {!readOnly && !appointmentMode && isEdit && onTriggerStart && form.id && (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={handleTriggerStart}
                disabled={saving}
              >
                {t("modal.triggerWebhook")}
              </Button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>{readOnly ? t("modal.close") : t("modal.cancel")}</Button>
            {!readOnly && !appointmentMode && (
              <Button type="submit" disabled={saving}>{saving ? t("modal.saving") : t("modal.save")}</Button>
            )}
          </div>
        </div>
      </form>
    </Modal>
  );
}
