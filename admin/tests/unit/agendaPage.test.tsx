import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { vi } from "vitest";

const mocks = vi.hoisted(() => {
  return {
    agendaFeatureGet: vi.fn(async () => ({ data: { enabled: true } })),
    agendaList: vi.fn(async () => ({
      data: {
        data: [
          {
            id: "apt-event-1",
            titulo: "Booked appointment",
            descripcion: "",
            tipo: "reunion",
            color: "#60A5FA",
            estado: "pendiente",
            startAt: "2026-06-10T10:00:00.000Z",
            endAt: "2026-06-10T10:30:00.000Z",
            reminderMinutes: 15,
            flowId: null,
            triggerWebhookOnStart: false,
            webhookUrl: null,
            webhookMethod: null,
            webhookHeaders: null,
            webhookPayload: null,
            source: "appointment",
            appointmentId: "apt-1",
            calendarId: "cal-1",
            assignments: [],
          },
        ],
      },
    })),
    agendaCreate: vi.fn(async () => ({ data: {} })),
    agendaUpdate: vi.fn(async () => ({ data: {} })),
    agendaSetAssignments: vi.fn(async () => ({ data: {} })),
    agendaRemove: vi.fn(async () => ({ data: {} })),
    agendaTriggerStart: vi.fn(async () => ({ data: {} })),
    agentesList: vi.fn(async () => ({ data: [] })),
    calendarSlots: vi.fn(async () => ({
      data: {
        slots: [
          {
            id: "slot-2",
            startTime: "2026-06-10T11:00:00.000Z",
            endTime: "2026-06-10T11:30:00.000Z",
          },
        ],
      },
    })),
    calendarReschedule: vi.fn(async () => ({ data: {} })),
    calendarCancel: vi.fn(async () => ({ data: {} })),
    configGet: vi.fn(async () => ({ data: { valor: null } })),
    tenantList: vi.fn(async () => ({ data: [] })),
    getMe: vi.fn(() => ({ tenantId: "tenant-id-1" })),
    useAuthStore: vi.fn(() => ({ tenantSlug: "tenant-a" })),
  };
});

vi.mock("@/lib/i18n/client", () => ({
  useCurrentLocale: () => "en",
  useTranslations: () => (key: string) => {
    const dictionary: Record<string, string> = {
      "messages.tenantRequired": "Tenant not selected",
      "messages.saveSuccess": "Event saved successfully.",
      "messages.deleteSuccess": "Event deleted successfully.",
      "messages.triggerSuccess": "Webhook triggered successfully.",
      "messages.rescheduleSuccess": "Appointment rescheduled successfully.",
      "messages.cancelSuccess": "Appointment cancelled successfully.",
      "messages.slotsLoadFailed": "Could not load available schedules.",
      pageTitle: "Agenda",
      weeklyAgendaSubtitle: "Weekly subtitle",
    };

    return dictionary[key] ?? key;
  },
}));

vi.mock("@/lib/api", () => ({
  agendaApi: {
    feature: {
      get: mocks.agendaFeatureGet,
    },
    list: mocks.agendaList,
    create: mocks.agendaCreate,
    update: mocks.agendaUpdate,
    setAssignments: mocks.agendaSetAssignments,
    remove: mocks.agendaRemove,
    triggerStart: mocks.agendaTriggerStart,
  },
  agentesApi: {
    list: mocks.agentesList,
  },
  calendarAppointmentsApi: {
    slots: mocks.calendarSlots,
    reschedule: mocks.calendarReschedule,
    cancel: mocks.calendarCancel,
  },
  configApi: {
    get: mocks.configGet,
  },
  tenantApi: {
    list: mocks.tenantList,
  },
}));

vi.mock("@/lib/agentApi", () => ({
  agentAuthApi: {
    agenda: vi.fn(async () => ({ data: { data: [], total: 0 } })),
  },
}));

vi.mock("@/store/auth", () => ({
  useAuthStore: mocks.useAuthStore,
  getStoredAccessToken: () => "token",
  getStoredAgentAccessToken: () => null,
}));

vi.mock("@/lib/useMe", () => ({
  getMe: mocks.getMe,
}));

vi.mock("@/hooks/useSocket", () => ({
  useSocket: vi.fn(),
}));

vi.mock("@fullcalendar/react", () => ({
  default: (props: {
    eventClick?: (arg: { event: { id: string; extendedProps: Record<string, unknown> } }) => void;
  }) => (
    <div>
      <button
        type="button"
        onClick={() =>
          props.eventClick?.({
            event: {
              id: "apt-event-1",
              extendedProps: {
                raw: {
                  id: "apt-event-1",
                  titulo: "Booked appointment",
                  descripcion: "",
                  tipo: "reunion",
                  color: "#60A5FA",
                  estado: "pendiente",
                  startAt: "2026-06-10T10:00:00.000Z",
                  endAt: "2026-06-10T10:30:00.000Z",
                  reminderMinutes: 15,
                  flowId: null,
                  triggerWebhookOnStart: false,
                  webhookUrl: null,
                  webhookMethod: null,
                  webhookHeaders: null,
                  webhookPayload: null,
                  source: "appointment",
                  appointmentId: "apt-1",
                  calendarId: "cal-1",
                  assignments: [],
                },
              },
            },
          })
        }
      >
        open-appointment
      </button>
    </div>
  ),
}));

vi.mock("@/components/agenda/AgendaEventModal", () => ({
  AgendaEventModal: (props: {
    onSave: (payload: {
      titulo: string;
      descripcion: string;
      tipo: "reunion" | "tarea" | "automatizacion" | "webhook";
      color: string;
      estado: "pendiente" | "en_progreso" | "completado";
      startAt: string;
      endAt: string;
      reminderMinutes: number | null;
      flowId: number | null;
      triggerWebhookOnStart: boolean;
      webhookUrl: string;
      webhookMethod: string;
      webhookHeadersJson: string;
      webhookPayloadJson: string;
      assignments: Array<{ agenteId: number }>;
    }) => Promise<void>;
    onDelete?: (id: number) => Promise<void>;
    onTriggerStart?: (id: number) => Promise<void>;
    onRescheduleAppointment?: (slotId: string) => Promise<void>;
    onCancelAppointment?: () => Promise<void>;
  }) => (
    <div>
      <button type="button" onClick={() => props.onSave({
        titulo: "Event",
        descripcion: "",
        tipo: "reunion",
        color: "#60A5FA",
        estado: "pendiente",
        startAt: "2026-06-10T09:00",
        endAt: "2026-06-10T09:30",
        reminderMinutes: 15,
        flowId: null,
        triggerWebhookOnStart: false,
        webhookUrl: "",
        webhookMethod: "POST",
        webhookHeadersJson: "{}",
        webhookPayloadJson: "{}",
        assignments: [],
      })}>modal-save</button>
      <button type="button" onClick={() => props.onDelete?.(7)}>modal-delete</button>
      <button type="button" onClick={() => props.onTriggerStart?.(9)}>modal-trigger</button>
      <button type="button" onClick={() => props.onRescheduleAppointment?.("slot-2")}>modal-reschedule</button>
      <button type="button" onClick={() => props.onCancelAppointment?.()}>modal-cancel</button>
    </div>
  ),
}));

import AgendaPage from "@/app/[locale]/(app)/agenda/page";

function renderWithQuery(ui: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

describe("Agenda page success feedback", () => {
  test("shows success banner for save and trigger actions", async () => {
    renderWithQuery(<AgendaPage />);

    await waitFor(() => {
      expect(screen.getByText("modal-save")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("modal-save"));

    await waitFor(() => {
      expect(screen.getByText("Event saved successfully.")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("modal-trigger"));

    await waitFor(() => {
      expect(screen.getByText("Webhook triggered successfully.")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("modal-delete"));

    await waitFor(() => {
      expect(screen.getByText("Event deleted successfully.")).toBeInTheDocument();
      expect(mocks.agendaRemove).toHaveBeenCalledWith("tenant-a", 7);
    });
  });

  test("shows success banner for appointment reschedule and cancel", async () => {
    renderWithQuery(<AgendaPage />);

    await waitFor(() => {
      expect(screen.getAllByText("open-appointment").length).toBeGreaterThan(1);
    });

    fireEvent.click(screen.getAllByText("open-appointment")[1]);

    await waitFor(() => {
      expect(mocks.calendarSlots).toHaveBeenCalled();
    });

    fireEvent.click(screen.getByText("modal-reschedule"));

    await waitFor(() => {
      expect(screen.getByText("Appointment rescheduled successfully.")).toBeInTheDocument();
    });

    fireEvent.click(screen.getAllByText("open-appointment")[1]);
    fireEvent.click(screen.getByText("modal-cancel"));

    await waitFor(() => {
      expect(screen.getByText("Appointment cancelled successfully.")).toBeInTheDocument();
    });
  });
});
