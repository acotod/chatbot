import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AgendaEventModal, type AgendaEventFormData } from "@/components/agenda/AgendaEventModal";
import { vi } from "vitest";

vi.mock("@/lib/i18n/client", () => ({
  useTranslations: () => (key: string, params?: Record<string, unknown>) => {
    if (key === "messages.titleRequired") return "El titulo es obligatorio";
    if (key === "messages.invalidRange") return "El rango de tiempo es invalido";
    if (key === "messages.webhookJsonInvalid") return "Webhook headers/payload deben ser JSON valido";
    if (key === "messages.saveFailed") return "No se pudo guardar el evento. Intenta de nuevo.";
    if (key === "messages.saveSuccess") return "Evento guardado correctamente.";
    if (key === "messages.sessionExpired") return "La sesion expiro. Vuelve a iniciar sesion.";
    if (key === "messages.selectSlotRequired") return "Selecciona un horario disponible para reprogramar la cita";
    if (key === "messages.rescheduleFailed") return "No se pudo reprogramar la cita. Intenta de nuevo.";
    if (key === "messages.rescheduleSuccess") return "Cita reprogramada correctamente.";
    if (key === "messages.cancelFailed") return "No se pudo cancelar la cita. Intenta de nuevo.";
    if (key === "messages.cancelSuccess") return "Cita cancelada correctamente.";
    if (key === "messages.deleteFailed") return "No se pudo eliminar el evento. Intenta de nuevo.";
    if (key === "messages.deleteSuccess") return "Evento eliminado correctamente.";
    if (key === "messages.triggerFailed") return "No se pudo disparar el webhook. Intenta de nuevo.";
    if (key === "messages.triggerSuccess") return "Webhook disparado correctamente.";
    if (key === "modal.currentStatus") return `Estado actual: ${String(params?.status ?? "")}.`;

    const dictionary: Record<string, string> = {
      "modal.appointmentDetail": "Detalle de cita",
      newEvent: "Nuevo evento",
      editEvent: "Editar evento",
      title: "Titulo",
      description: "Descripcion",
      "table.type": "Tipo",
      "table.status": "Estado",
      "table.start": "Inicio",
      "table.end": "Fin",
      "types.reunion": "Reunion",
      "types.tarea": "Tarea",
      "types.automatizacion": "Automatizacion",
      "types.webhook": "Webhook",
      "statuses.pendiente": "Pendiente",
      "statuses.en_progreso": "En progreso",
      "statuses.completado": "Completado",
      "modal.color": "Color",
      "modal.reminderMinutes": "Notificar antes (min)",
      "modal.save": "Guardar",
      "modal.cancel": "Cancelar",
      "modal.close": "Cerrar",
      "modal.saving": "Guardando...",
      "modal.editAppointment": "Editar cita",
      "modal.rescheduleHint": "Puedes reprogramar la cita a un horario disponible o cancelarla.",
      "modal.newSchedule": "Nuevo horario",
      "modal.loadingSchedules": "Cargando horarios...",
      "modal.selectAvailableSchedule": "Selecciona un horario disponible",
      "modal.noSchedules": "No hay horarios disponibles para reprogramar esta cita.",
      "modal.cancelling": "Cancelando...",
      "modal.cancelAppointment": "Cancelar cita",
      "modal.rescheduling": "Reprogramando...",
      "modal.saveAppointment": "Guardar cita",
      "modal.triggerWebhookOnStart": "Disparar webhook al iniciar",
      "modal.triggerWebhookHint": "Se ejecuta cuando el estado cambia a En progreso o manualmente.",
      "modal.webhookUrl": "Webhook URL",
      "modal.webhookMethod": "Metodo del webhook",
      "modal.webhookHeaders": "Cabeceras del webhook (JSON)",
      "modal.webhookPayload": "Carga util del webhook (JSON)",
      "modal.owners": "Responsables",
      "modal.noOwners": "No hay agentes disponibles para asignar.",
      "modal.triggerWebhook": "Disparar webhook",
      deleteEvent: "Eliminar evento",
    };

    return dictionary[key] ?? key;
  },
}));

const defaultEvent: AgendaEventFormData = {
  id: 1,
  titulo: "",
  descripcion: "",
  tipo: "reunion",
  color: "#60A5FA",
  estado: "pendiente",
  startAt: "2026-06-08T08:00",
  endAt: "2026-06-08T08:30",
  reminderMinutes: 15,
  flowId: null,
  triggerWebhookOnStart: false,
  webhookUrl: "",
  webhookMethod: "POST",
  webhookHeadersJson: "{}",
  webhookPayloadJson: "{}",
  assignments: [],
};

function renderModal(overrides?: Partial<React.ComponentProps<typeof AgendaEventModal>>) {
  return render(
    <AgendaEventModal
      open
      event={defaultEvent}
      agentes={[]}
      saving={false}
      onClose={vi.fn()}
      onSave={vi.fn(async () => undefined)}
      {...overrides}
    />
  );
}

describe("AgendaEventModal", () => {
  test("shows invalid range message on submit", async () => {
    renderModal({
      event: {
        ...defaultEvent,
        titulo: "Cita demo",
        startAt: "2026-06-08T08:30",
        endAt: "2026-06-08T08:00",
      },
    });

    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));

    expect(screen.getByText("El rango de tiempo es invalido")).toBeInTheDocument();
  });

  test("shows backend api error message when save fails", async () => {
    const onSave = vi.fn(async () => {
      throw {
        response: {
          data: {
            error: "No hay disponibilidad para este horario",
          },
        },
      };
    });

    renderModal({
      event: { ...defaultEvent, titulo: "Cita demo" },
      onSave,
    });

    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));

    await waitFor(() => {
      expect(screen.getByText("No hay disponibilidad para este horario")).toBeInTheDocument();
    });
  });

  test("shows session expired message when api returns unauthorized", async () => {
    const onSave = vi.fn(async () => {
      throw {
        response: {
          status: 401,
        },
      };
    });

    renderModal({
      event: { ...defaultEvent, titulo: "Cita demo" },
      onSave,
    });

    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));

    await waitFor(() => {
      expect(screen.getByText("La sesion expiro. Vuelve a iniciar sesion.")).toBeInTheDocument();
    });
  });

  test("renders appointment slots load error message", async () => {
    renderModal({
      readOnly: true,
      appointmentMode: true,
      onRescheduleAppointment: vi.fn(async () => undefined),
      onCancelAppointment: vi.fn(async () => undefined),
      appointmentSlotsError: "No se pudieron cargar los horarios disponibles.",
    });

    expect(screen.getByText("No se pudieron cargar los horarios disponibles.")).toBeInTheDocument();
  });

  test("shows success message after trigger webhook action", async () => {
    renderModal({
      event: { ...defaultEvent, titulo: "Webhook demo", tipo: "webhook" },
      onTriggerStart: vi.fn(async () => undefined),
    });

    fireEvent.click(screen.getByRole("button", { name: "Disparar webhook" }));

    await waitFor(() => {
      expect(screen.getByText("Webhook disparado correctamente.")).toBeInTheDocument();
    });
  });
});
