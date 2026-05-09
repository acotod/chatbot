import axios from "axios";
import { API_BASE } from "./api";
import { getStoredAgentAccessToken } from "@/store/agentAuth";
import { getTabId } from "./tabManager";

let inMemoryRequestTabId = "";

function getRequestTabId(): string {
  const fromManager = getTabId();
  if (fromManager) {
    inMemoryRequestTabId = fromManager;
    return fromManager;
  }
  if (inMemoryRequestTabId) return inMemoryRequestTabId;
  inMemoryRequestTabId = `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
  return inMemoryRequestTabId;
}

export const agentApiClient = axios.create({
  baseURL: API_BASE,
  headers: { "Content-Type": "application/json" },
  timeout: 10000,
});

agentApiClient.interceptors.request.use((config) => {
  const token = getStoredAgentAccessToken();
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  } else {
    // Abort silently when no agent token is available to prevent 401 floods
    // caused by the race between useQuery/useEffect evaluated before the
    // session is cleared by providers.tsx on hard reload.
    const url = config.url ?? "";
    const isAuthEndpoint = url.includes("/auth/agent/");
    if (!isAuthEndpoint) {
      const controller = new AbortController();
      controller.abort();
      config.signal = controller.signal;
    }
  }

  // Add tab ID to every request for tab-level access control
  if (typeof window !== "undefined") {
    const tabId = getRequestTabId();
    if (tabId) config.headers["x-tab-id"] = tabId;
  }

  return config;
});

// Add 401 response interceptor for agent session expiry.
// Auth endpoints (login, forgot-password, reset-password) return 401 for bad
// credentials — don't treat those as expired sessions or we'd loop back to the
// login page with the misleading amber "session expired" banner.
agentApiClient.interceptors.response.use(
  (response) => response,
  (error) => {
    // Silently drop aborted requests (no token race condition)
    if (error.code === "ERR_CANCELED") {
      return Promise.reject(error);
    }

    if (error.response?.status === 401) {
      const requestUrl: string = error.config?.url ?? "";
      const isAuthEndpoint =
        requestUrl.includes("/auth/agent/login") ||
        requestUrl.includes("/auth/agent/forgot-password") ||
        requestUrl.includes("/auth/agent/reset-password");

      if (!isAuthEndpoint && typeof window !== "undefined") {
        // Clear agent auth and redirect to agent login with session-expired reason
        (async () => {
          const { clearStoredAgentAuth } = await import("@/store/agentAuth");
          clearStoredAgentAuth();
          window.location.href = "/agente/login?reason=expired";
        })();
      }
    }
    return Promise.reject(error);
  }
);

export type AgentLoginResponse = {
  accessToken: string;
  expiresIn: number;
  profile: {
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
};

export type AgentKpisResponse = {
  solicitudesActivas: number;
  solicitudesCompletadasMes: number;
  agendaProximos7Dias: number;
  agendaVencida: number;
  lastSeenAt: string | null;
};

export type AgentSolicitud = {
  id: number;
  titulo: string | null;
  nombre: string | null;
  telefonoContacto: string | null;
  estado: string | null;
  prioridad: string | null;
  categoria: string | null;
  subcategoria: string | null;
  dueAt: string | null;
  firstResponseAt: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  user?: { id: number; phone: string | null } | null;
  conversation?: { id: string; status: string; startedAt: string; endedAt: string | null } | null;
};

export type AgentSolicitudesResponse = {
  page: number;
  limit: number;
  total: number;
  status: string;
  data: AgentSolicitud[];
};

export type AgentSolicitudMessage = {
  id: number;
  tenantId: string;
  userId: number | null;
  conversationId: string | null;
  waMsgId: string | null;
  direccion: string;
  tipo: string;
  contenido: unknown;
  leido: boolean;
  createdAt: string;
};

export type AgentSolicitudMessagesResponse = {
  solicitud: {
    id: number;
    tenantId: string;
    userId: number | null;
    agenteId: number | null;
    conversationId: string | null;
    estado: string;
    user: { id: number; phone: string | null; nombre: string | null } | null;
    conversation: { id: string; status: string } | null;
  };
  data: AgentSolicitudMessage[];
  total: number;
  page: number;
  limit: number;
};

export type AgentConversation = {
  id: string;
  userKey: string;
  status: string;
  startedAt: string;
  endedAt: string | null;
  flow?: { id: number; nombre: string } | null;
  solicitudes?: Array<{ id: number; estado: string; createdAt: string }>;
};

export type AgentConversationsResponse = {
  data: AgentConversation[];
  total: number;
  page: number;
  limit: number;
};

export type AgentAgendaEvent = {
  id: number;
  titulo: string;
  descripcion: string | null;
  tipo: string;
  color: string;
  estado: string;
  startAt: string;
  endAt: string;
};

export type AgentAgendaResponse = {
  total: number;
  data: AgentAgendaEvent[];
};

export type AgentContacto = {
  id: number;
  phone: string | null;
  nombre: string | null;
  email: string | null;
  empresa: string | null;
  cargo: string | null;
  canalOrigen: string | null;
  etiquetas: string[];
  leadScore: number;
  ultimoContacto: string | null;
  createdAt: string;
  _count?: { solicitudes: number };
};

export type AgentContactosResponse = {
  page: number;
  limit: number;
  total: number;
  data: AgentContacto[];
};

export const agentAuthApi = {
  login: (tenantSlug: string, email: string, password: string) => {
    const tabId = getRequestTabId();
    return agentApiClient.post<AgentLoginResponse>(
      "/auth/agent/login",
      {
        tenantSlug,
        email,
        password,
        tabId,
      },
      {
        headers: { "x-tab-id": tabId },
      }
    );
  },
  loginNoTenant: (email: string, password: string) => {
    const tabId = getRequestTabId();
    return agentApiClient.post<
      | AgentLoginResponse
      | {
          requiresTenantSelection: boolean;
          email: string;
          tenants: Array<{ tenantId: string; tenantSlug: string; tenantNombre: string; agenteId: number }>;
        }
    >(
      "/auth/agent/login",
      {
        email,
        password,
        tabId,
      },
      {
        headers: { "x-tab-id": tabId },
      }
    );
  },
  loginWithTenant: (tenantSlug: string, email: string, password: string) => {
    const tabId = getRequestTabId();
    return agentApiClient.post<AgentLoginResponse>(
      "/auth/agent/login/with-tenant",
      {
        tenantSlug,
        email,
        password,
        tabId,
      },
      {
        headers: { "x-tab-id": tabId },
      }
    );
  },
  forgotPassword: (tenantSlug: string, email: string) =>
    agentApiClient.post<{ message: string; deliveryChannels?: string[]; resetToken?: string; resetUrl?: string; expiresAt?: string }>("/auth/agent/forgot-password", {
      tenantSlug,
      email,
    }),
  resetPassword: (token: string, password: string) =>
    agentApiClient.post<{ message: string }>("/auth/agent/reset-password", {
      token,
      password,
    }),
  me: () =>
    agentApiClient.get<AgentLoginResponse["profile"]>("/auth/agent/me"),
  kpis: () =>
    agentApiClient.get<AgentKpisResponse>("/auth/agent/kpis"),
  solicitudes: (params?: { status?: "assigned" | "completed"; page?: number; limit?: number }) =>
    agentApiClient.get<AgentSolicitudesResponse>("/auth/agent/solicitudes", { params }),
  conversations: (params: { userKey: string; page?: number; limit?: number }) =>
    agentApiClient.get<AgentConversationsResponse>("/auth/agent/conversations", { params }),
  updateSolicitud: (id: number, data: {
    estado?: string;
    prioridad?: string | null;
    categoria?: string | null;
    subcategoria?: string | null;
    followUpDate?: string | null;
    dueAt?: string | null;
    resolutionNotes?: string | null;
    customerNotes?: string | null;
  }) => agentApiClient.patch<AgentSolicitud>(`/auth/agent/solicitudes/${id}`, data),
  solicitudMessages: (id: number, params?: { page?: number; limit?: number; q?: string; direccion?: "entrada" | "salida"; start?: string; end?: string }) =>
    agentApiClient.get<AgentSolicitudMessagesResponse>(`/auth/agent/solicitudes/${id}/messages`, { params }),
  sendSolicitudMessage: (id: number, text: string) =>
    agentApiClient.post<{ ok: boolean; solicitudId: number; mensaje: AgentSolicitudMessage; waResponse: unknown }>(
      `/auth/agent/solicitudes/${id}/messages`,
      { text },
    ),
  agenda: (params?: { start?: string; end?: string; estado?: string }) =>
    agentApiClient.get<AgentAgendaResponse>("/auth/agent/agenda", { params }),
  contactos: (params?: { q?: string; page?: number; limit?: number }) =>
    agentApiClient.get<AgentContactosResponse>("/auth/agent/contactos", { params }),
  logout: () =>
    agentApiClient.post("/auth/agent/logout"),
};