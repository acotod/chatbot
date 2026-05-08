import axios from "axios";
import { API_BASE } from "./api";
import { getStoredAgentAccessToken } from "@/store/agentAuth";
import { getTabId } from "./tabManager";

export const agentApiClient = axios.create({
  baseURL: API_BASE,
  headers: { "Content-Type": "application/json" },
  timeout: 10000,
});

agentApiClient.interceptors.request.use((config) => {
  const token = getStoredAgentAccessToken();
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  
  // Add tab ID to every request for tab-level access control
  if (typeof window !== "undefined") {
    const tabId = getTabId();
    if (tabId) config.headers["x-tab-id"] = tabId;
  }
  
  return config;
});

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
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

export type AgentSolicitudesResponse = {
  page: number;
  limit: number;
  total: number;
  status: string;
  data: AgentSolicitud[];
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
    const tabId = getTabId();
    return agentApiClient.post<AgentLoginResponse>("/auth/agent/login", {
      tenantSlug,
      email,
      password,
      tabId,
    });
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
  agenda: (params?: { start?: string; end?: string; estado?: string }) =>
    agentApiClient.get<AgentAgendaResponse>("/auth/agent/agenda", { params }),
  contactos: (params?: { q?: string; page?: number; limit?: number }) =>
    agentApiClient.get<AgentContactosResponse>("/auth/agent/contactos", { params }),
  logout: () =>
    agentApiClient.post("/auth/agent/logout"),
};