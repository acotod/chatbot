import axios from "axios";
import { API_BASE } from "./api";
import { getStoredAgentAccessToken } from "@/store/agentAuth";

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

export const agentAuthApi = {
  login: (tenantSlug: string, email: string, password: string) =>
    agentApiClient.post<AgentLoginResponse>("/auth/agent/login", {
      tenantSlug,
      email,
      password,
    }),
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
  logout: () =>
    agentApiClient.post("/auth/agent/logout"),
};