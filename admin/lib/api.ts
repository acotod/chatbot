import axios from "axios";
import { addLog } from "./errorLogger";
import {
  clearStoredAuth,
  getStoredAccessToken,
  getStoredRefreshToken,
  scheduleProactiveRefresh,
  useAuthStore,
} from "@/store/auth";
import { getTabId } from "./tabManager";

// Set to true when an intentional logout is in progress so response-interceptor
// errors that race with session teardown are not surfaced in the console.
let _isLoggingOut = false;
export function markLoggingOut() { _isLoggingOut = true; }

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

function isLocalHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "0.0.0.0";
}

function parseHostname(rawUrl: string): string | null {
  try {
    return new URL(rawUrl).hostname;
  } catch {
    return null;
  }
}

function mapAdminOrAgentHostToApi(hostname: string): string | null {
  const labels = hostname.split(".");
  const roleIndex = labels.findIndex((label) => label === "admin" || label === "agente");
  if (roleIndex === -1) return null;
  labels[roleIndex] = "api";
  return labels.join(".");
}

function resolveApiBase(): string {
  const envBase = process.env.NEXT_PUBLIC_API_URL?.trim();
  if (envBase) {
    if (typeof window !== "undefined") {
      const currentHost = window.location.hostname;
      const envHost = parseHostname(envBase);

      // Ignore localhost/loopback API URLs when running on a real remote host.
      if (!(envHost && isLocalHostname(envHost) && !isLocalHostname(currentHost))) {
        return envBase.replace(/\/+$/, "");
      }
    } else {
      return envBase.replace(/\/+$/, "");
    }
  }

  if (typeof window !== "undefined") {
    const { hostname, origin, port, protocol } = window.location;
    if (hostname === "localhost" || hostname === "127.0.0.1") {
      return "http://127.0.0.1:3200";
    }
    const mappedApiHost = mapAdminOrAgentHostToApi(hostname);
    if (mappedApiHost) {
      return `${protocol}//${mappedApiHost}${port ? `:${port}` : ""}`;
    }
    // In production-like environments, prefer same-origin if explicit API URL is missing.
    return origin;
  }

  return "http://127.0.0.1:3200";
}

export const API_BASE = resolveApiBase();

export const apiClient = axios.create({
  baseURL: API_BASE,
  headers: { "Content-Type": "application/json" },
  timeout: 10000,
});

// Attach the per-tab JWT token on every request.
// If no token is found and this is not an auth endpoint, abort the request silently
// to avoid 401s caused by the race between useQuery's enabled guard (evaluated at
// render time when the token exists) and providers.tsx clearing the session on reload.
apiClient.interceptors.request.use((config) => {
  if (typeof window !== "undefined") {
    const token = getStoredAccessToken() ?? useAuthStore.getState().token;
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    } else {
      const url = config.url ?? "";
      const isAuthEndpoint = url.includes("/auth/");
      if (!isAuthEndpoint) {
        const controller = new AbortController();
        controller.abort();
        config.signal = controller.signal;
      }
    }

    // Add tab ID to every request for tab-level access control
    const tabId = getRequestTabId();
    if (tabId) config.headers["x-tab-id"] = tabId;
  }
  return config;
});

// Separate axios instance for token refresh — must NOT go through apiClient interceptors
const refreshClient = axios.create({
  baseURL: API_BASE,
  headers: { "Content-Type": "application/json" },
  timeout: 10000,
});

// Module-level promise to coalesce concurrent 401s into a single refresh call
let refreshPromise: Promise<string> | null = null;

function clearAuthAndRedirect() {
  if (typeof window === "undefined") return;
  clearStoredAuth();
  window.location.href = "/login";
}

// Auto-redirect to /login on 401, with silent token refresh when possible
apiClient.interceptors.response.use(
  (res) => res,
  async (err) => {
    const status = err.response?.status;
    const data = err.response?.data;
    const url = err.config?.url ?? "";
    const baseURL = err.config?.baseURL ?? API_BASE;
    const networkCode = err.code;
    const networkMessage = err.message;
    const method = err.config?.method?.toUpperCase();

    if (networkCode === "ERR_CANCELED") {
      return Promise.reject(err);
    }

    const normalizedBase = String(baseURL).replace(/\/+$/, "");
    const normalizedPath = url.startsWith("/") ? url : `/${url}`;
    const requestUrl = url.startsWith("http")
      ? url
      : `${normalizedBase}${normalizedPath}`;
    const isNetworkError = typeof status !== "number";
    const responseError =
      data?.error || data?.message || networkMessage || "Request failed";

    // Determine if this 401 can be silently recovered via refresh
    const isRecoverable401 =
      status === 401 &&
      typeof window !== "undefined" &&
      !window.location.pathname.startsWith("/login") &&
      !url.includes("/auth/refresh") &&
      !!getStoredRefreshToken();

    const isPostLogout =
      (status === 401 || status === 403) &&
      !getStoredAccessToken() &&
      !getStoredRefreshToken();

    if (!isRecoverable401 && !isPostLogout) {
      addLog({
        level: "error",
        source: "network",
        message: isNetworkError
          ? `NETWORK ${networkCode || "ERROR"}: ${requestUrl}`
          : `HTTP ${status}: ${requestUrl}`,
        details: {
          status,
          method,
          url: requestUrl,
          responseError,
          errorCode: data?.code,
          validationDetails: data?.details,
          networkCode,
          networkMessage,
          isNetworkError,
        },
      });
    }

    if (isRecoverable401) {
      const storedRefreshToken = getStoredRefreshToken();

      if (!storedRefreshToken) {
        clearAuthAndRedirect();
        return Promise.reject(err);
      }

      try {
        // Coalesce concurrent 401s into a single refresh request
        if (!refreshPromise) {
          refreshPromise = refreshClient
            .post<{ accessToken: string; expiresIn?: number }>("/auth/refresh", {
              refreshToken: storedRefreshToken,
            })
            .then((res) => {
              const { accessToken, expiresIn } = res.data;
              // Update store & schedule proactive refresh
              const { setToken } = useAuthStore.getState();
              setToken(accessToken, expiresIn);
              scheduleProactiveRefresh(expiresIn ?? 900, async () => {
                const currentRefreshToken = getStoredRefreshToken();
                if (!currentRefreshToken) return;
                const r = await refreshClient.post<{ accessToken: string; expiresIn?: number }>(
                  "/auth/refresh",
                  { refreshToken: currentRefreshToken }
                );
                useAuthStore.getState().setToken(r.data.accessToken, r.data.expiresIn);
                scheduleProactiveRefresh(r.data.expiresIn ?? 900, async () => {
                  // Recursive scheduling handled by next cycle
                });
              });
              return accessToken;
            })
            .finally(() => {
              refreshPromise = null;
            });
        }

        const newAccessToken = await refreshPromise;

        // Retry the original request with the refreshed token
        // Retry the original request with the new token
        err.config.headers.Authorization = `Bearer ${newAccessToken}`;
        return apiClient(err.config);
      } catch {
                // Refresh failed — log the original 401 now and redirect
                addLog({
                  level: "error",
                  source: "network",
                  message: `HTTP ${status}: ${requestUrl} (session expired)`,
                  details: { status, method, url: requestUrl, responseError, errorCode: data?.code },
                });
        clearAuthAndRedirect();
        return Promise.reject(err);
      }
    }

    return Promise.reject(err);
  }
);

// ── Auth ────────────────────────────────────────────────────────────────────
export const authApi = {
  login: (email: string, password: string) => {
    const tabId = getRequestTabId();
    return apiClient.post<{ accessToken: string; refreshToken?: string; expiresIn: number; superAdmin: boolean }>(
      "/auth/login",
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
  me: () =>
    apiClient.get<{
      adminUserId: number | null;
      email: string | null;
      nombre: string | null;
      tenantId: string | null;
      tenantSlug: string | null;
      superAdmin: boolean;
      permissions: string[];
    }>("/auth/me"),
  loginWithFacebook: (accessToken: string) =>
    apiClient.post<{ accessToken: string; refreshToken?: string; expiresIn: number; superAdmin: boolean }>("/auth/facebook", {
      accessToken,
    }),
  loginWithGoogle: (credential: string) =>
    apiClient.post<{ accessToken: string; refreshToken?: string; expiresIn: number; superAdmin: boolean }>("/auth/google", {
      credential,
    }),
  logout: (refreshToken?: string) =>
    refreshToken || getStoredAccessToken()
      ? apiClient.post("/auth/logout", refreshToken ? { refreshToken } : {})
      : Promise.resolve({ data: null }),
  refresh: (refreshToken: string) =>
    refreshClient.post<{ accessToken: string }>("/auth/refresh", { refreshToken }),
};

// ── Tenant-scoped helpers ────────────────────────────────────────────────────
export const tenantApi = {
  list: () => apiClient.get("/admin/tenants"),
  create: (data: Record<string, unknown>) =>
    apiClient.post("/admin/tenants", data),
  activate: (slug: string) =>
    apiClient.patch(`/admin/tenants/${slug}/activate`),
  deactivate: (slug: string) =>
    apiClient.patch(`/admin/tenants/${slug}/deactivate`),
  rotateApiKey: (slug: string) =>
    apiClient.post(`/admin/tenants/${slug}/rotate-api-key`),
  uploadLogo: (slug: string, file: File) => {
    const form = new FormData();
    form.append("logo", file);
    return apiClient.post(`/admin/tenants/${slug}/logo`, form, {
      headers: { "Content-Type": "multipart/form-data" },
    });
  },
};

export const notificationsApi = {
  list: (slug: string, params?: { page?: number; limit?: number }) =>
    apiClient.get(`/admin/tenants/${slug}/notifications`, { params }),
  markAsRead: (slug: string, id: number) =>
    apiClient.patch(`/admin/tenants/${slug}/notifications/${id}/read`),
  markAllAsRead: (slug: string) =>
    apiClient.patch(`/admin/tenants/${slug}/notifications/read-all`),
};

export const solicitudesApi = {
  list: (slug: string, params?: Record<string, unknown>) =>
    apiClient.get(`/admin/tenants/${slug}/solicitudes`, { params }),
  getConfig: (slug: string) =>
    apiClient.get(`/admin/tenants/${slug}/solicitudes/config`),
  updateConfig: (slug: string, data: Record<string, unknown>) =>
    apiClient.put(`/admin/tenants/${slug}/solicitudes/config`, data),
  search: (slug: string, params?: Record<string, unknown>) =>
    apiClient.get(`/admin/tenants/${slug}/solicitudes/search`, { params }),
  stats: (slug: string) =>
    apiClient.get(`/admin/tenants/${slug}/solicitudes/stats`),
  create: (
    slug: string,
    data: { userId: number; nombre?: string; telefonoContacto?: string; horario?: string; estado?: string }
  ) => apiClient.post(`/admin/tenants/${slug}/solicitudes`, data),
  updateEstado: (slug: string, id: number, estado: string) =>
    apiClient.patch(`/admin/tenants/${slug}/solicitudes/${id}/estado`, {
      estado,
    }),
  assignAgente: (slug: string, id: number, agenteId: number) =>
    apiClient.patch(`/admin/tenants/${slug}/solicitudes/${id}/agente`, {
      agenteId,
    }),
  escalate: (
    slug: string,
    id: number,
    payload?: { reason?: string; targetAdminUserId?: number }
  ) =>
    apiClient.post(`/admin/tenants/${slug}/solicitudes/${id}/escalate`, {
      reason: payload?.reason,
      targetAdminUserId: payload?.targetAdminUserId,
    }),
  createPortalToken: (slug: string, id: number) =>
    apiClient.post(`/admin/tenants/${slug}/solicitudes/${id}/portal-token`),
  listComments: (slug: string, id: number) =>
    apiClient.get(`/admin/tenants/${slug}/solicitudes/${id}/comments`),
  addComment: (slug: string, id: number, data: { content: string; visibility?: string; attachments?: unknown[] }) =>
    apiClient.post(`/admin/tenants/${slug}/solicitudes/${id}/comments`, data),
  history: (slug: string, id: number) =>
    apiClient.get(`/admin/tenants/${slug}/solicitudes/${id}/history`),
  messages: (slug: string, id: number, params?: { page?: number; limit?: number; q?: string; direccion?: "entrada" | "salida"; start?: string; end?: string; lectura?: "leido" | "no_leido" }) =>
    apiClient.get(`/admin/tenants/${slug}/solicitudes/${id}/messages`, { params }),
  sendMessage: (slug: string, id: number, text: string) =>
    apiClient.post(`/admin/tenants/${slug}/solicitudes/${id}/messages`, { text }),
  update: (slug: string, id: number, data: Record<string, unknown>) =>
    apiClient.patch(`/admin/tenants/${slug}/solicitudes/${id}`, data),
  bulkUpdate: (slug: string, ids: number[], updates: Record<string, unknown>) =>
    apiClient.post(`/admin/tenants/${slug}/solicitudes/bulk-update`, { ids, updates }),
  listWebhooks: (slug: string, params?: { event?: string }) =>
    apiClient.get(`/admin/tenants/${slug}/solicitudes/webhooks`, { params }),
  createWebhook: (slug: string, data: { event: string; url: string; active?: boolean }) =>
    apiClient.post(`/admin/tenants/${slug}/solicitudes/webhooks`, data),
  updateWebhook: (slug: string, id: number, data: { event?: string; url?: string; active?: boolean }) =>
    apiClient.patch(`/admin/tenants/${slug}/solicitudes/webhooks/${id}`, data),
  deleteWebhook: (slug: string, id: number) =>
    apiClient.delete(`/admin/tenants/${slug}/solicitudes/webhooks/${id}`),
  listWebhookDeliveries: (slug: string, params?: { event?: string; status?: string; limit?: number }) =>
    apiClient.get(`/admin/tenants/${slug}/solicitudes/webhooks/deliveries`, { params }),
  testWebhook: (slug: string, event?: string) =>
    apiClient.post(`/admin/tenants/${slug}/solicitudes/webhooks/test`, { event }),
};

export const portalApi = {
  list: (token: string) => apiClient.get(`/portal/${encodeURIComponent(token)}/solicitudes`),
  detail: (token: string, id: number) => apiClient.get(`/portal/${encodeURIComponent(token)}/solicitudes/${id}`),
  addComment: (token: string, id: number, content: string) =>
    apiClient.post(`/portal/${encodeURIComponent(token)}/solicitudes/${id}/comments`, { content }),
};

export const slaPoliciesApi = {
  list: (slug: string) => apiClient.get(`/admin/tenants/${slug}/sla-policies`),
  create: (slug: string, data: Record<string, unknown>) =>
    apiClient.post(`/admin/tenants/${slug}/sla-policies`, data),
  update: (slug: string, id: number, data: Record<string, unknown>) =>
    apiClient.patch(`/admin/tenants/${slug}/sla-policies/${id}`, data),
};

export const assignmentRulesApi = {
  list: (slug: string) => apiClient.get(`/admin/tenants/${slug}/assignment-rules`),
  create: (slug: string, data: Record<string, unknown>) =>
    apiClient.post(`/admin/tenants/${slug}/assignment-rules`, data),
  update: (slug: string, id: number, data: Record<string, unknown>) =>
    apiClient.patch(`/admin/tenants/${slug}/assignment-rules/${id}`, data),
};

export const agentesApi = {
  list: (slug: string) => apiClient.get(`/admin/tenants/${slug}/agentes`),
  create: (slug: string, data: Record<string, unknown>) =>
    apiClient.post(`/admin/tenants/${slug}/agentes`, data),
  update: (slug: string, id: number, data: Record<string, unknown>) =>
    apiClient.patch(`/admin/tenants/${slug}/agentes/${id}`, data),
  updateEstado: (slug: string, id: number, estado: string) =>
    apiClient.patch(`/admin/tenants/${slug}/agentes/${id}/estado`, { estado }),
};

export const adminUsersApi = {
  list: (slug: string) => apiClient.get(`/admin/tenants/${slug}/admin-users`),
  setJefe: (slug: string, id: number, jefeId: number | null) =>
    apiClient.patch(`/admin/tenants/${slug}/admin-users/${id}/jefe`, { jefeId }),
  escalationChain: (slug: string, id: number) =>
    apiClient.get(`/admin/tenants/${slug}/admin-users/${id}/escalation-chain`),
};

export const calendarsApi = {
  list: (slug: string) => apiClient.get(`/admin/tenants/${slug}/calendars`),
};

export const agentePuestosApi = {
  list: (slug: string) => apiClient.get(`/admin/tenants/${slug}/agente-puestos`),
  create: (slug: string, data: { nombre: string }) =>
    apiClient.post(`/admin/tenants/${slug}/agente-puestos`, data),
  update: (slug: string, id: number, data: { nombre: string }) =>
    apiClient.patch(`/admin/tenants/${slug}/agente-puestos/${id}`, data),
  remove: (slug: string, id: number) =>
    apiClient.delete(`/admin/tenants/${slug}/agente-puestos/${id}`),
};

export const metricsApi = {
  get: (slug: string) => apiClient.get(`/admin/tenants/${slug}/metrics`),
  solicitudesReport: (slug: string, params?: { from?: string; to?: string; groupBy?: "day" | "week" | "month" }) =>
    apiClient.get(`/admin/tenants/${slug}/solicitudes/report`, { params }),
};

export const agendaApi = {
  feature: {
    get: (slug: string) => apiClient.get(`/admin/tenants/${slug}/agenda/feature`),
    set: (slug: string, enabled: boolean) =>
      apiClient.put(`/admin/tenants/${slug}/agenda/feature`, { enabled }),
  },
  list: (slug: string, params: { start: string; end: string; tipo?: string; estado?: string; agenteId?: number }) =>
    apiClient.get(`/admin/tenants/${slug}/agenda`, { params }),
  create: (slug: string, data: Record<string, unknown>) =>
    apiClient.post(`/admin/tenants/${slug}/agenda`, data),
  update: (slug: string, id: number, data: Record<string, unknown>) =>
    apiClient.patch(`/admin/tenants/${slug}/agenda/${id}`, data),
  remove: (slug: string, id: number) =>
    apiClient.delete(`/admin/tenants/${slug}/agenda/${id}`),
  setAssignments: (slug: string, id: number, agenteIds: number[]) =>
    apiClient.post(`/admin/tenants/${slug}/agenda/${id}/assignments`, { agenteIds }),
  logs: (slug: string, id: number) =>
    apiClient.get(`/admin/tenants/${slug}/agenda/${id}/logs`),
  triggerStart: (slug: string, id: number) =>
    apiClient.post(`/admin/tenants/${slug}/agenda/${id}/trigger-start`),
};

// ── RBAC ─────────────────────────────────────────────────────────────────────
export const rbacApi = {
  listPermisos: () => apiClient.get("/rbac/permisos"),
  listRoles: () => apiClient.get("/rbac/roles"),
  createRole: (data: Record<string, unknown>) =>
    apiClient.post("/rbac/roles", data),
  updateRole: (id: number, data: Record<string, unknown>) =>
    apiClient.patch(`/rbac/roles/${id}`, data),
  deleteRole: (id: number) => apiClient.delete(`/rbac/roles/${id}`),
  listUsers: () => apiClient.get("/rbac/users"),
  createUser: (data: Record<string, unknown>) =>
    apiClient.post("/rbac/users", data),
  updateUser: (id: number, data: Record<string, unknown>) =>
    apiClient.patch(`/rbac/users/${id}`, data),
  deleteUser: (id: number) => apiClient.delete(`/rbac/users/${id}`),
};

// ── Audit ─────────────────────────────────────────────────────────────────────
export const auditApi = {
  list: (params?: Record<string, unknown>) =>
    apiClient.get("/audit", { params }),
};

// ── WhatsApp Business ─────────────────────────────────────────────────────────
export const whatsappApi = {
  /** One row per unique user — latest message per thread */
  listConversaciones: (params: { tenantId?: string; tenantSlug?: string }) =>
    apiClient.get("/whatsapp/conversaciones", { params }),
  /** Full message history for one user */
  listMensajes: (params: { tenantId?: string; tenantSlug?: string; userId: number; page?: number; limit?: number }) =>
    apiClient.get("/whatsapp/mensajes", {
      params: { page: 1, limit: 100, ...params },
    }),
  /** Send an outbound text message */
  send: (tenantId: string, to: string, text: string) =>
    apiClient.post("/whatsapp/send", { tenantId, to, text }),
};

// ── Config (per-tenant) ────────────────────────────────────────────────────────
export const configApi = {
  get: (slug: string, clave: string) =>
    apiClient.get(`/admin/tenants/${slug}/config/${clave}`).catch(() => null),
  set: (slug: string, clave: string, valor: unknown) =>
    apiClient.put(`/admin/tenants/${slug}/config/${clave}`, { valor }),
};

// ── Integrations ──────────────────────────────────────────────────────────────
export const integrationsApi = {
  list: (params?: { tipo?: string; activo?: boolean }) =>
    apiClient.get("/integrations", { params }),
  get: (id: number) => apiClient.get(`/integrations/${id}`),
  create: (data: { nombre: string; tipo: string; config: unknown; activo?: boolean }) =>
    apiClient.post("/integrations", data),
  update: (id: number, data: { nombre?: string; tipo?: string; config?: unknown; activo?: boolean }) =>
    apiClient.put(`/integrations/${id}`, data),
  remove: (id: number) => apiClient.delete(`/integrations/${id}`),
  test: (id: number) => apiClient.post(`/integrations/${id}/test`),
  getCatalog: () => apiClient.get("/integrations/catalog/endpoints"),
  saveCatalog: (endpoints: unknown[]) =>
    apiClient.put("/integrations/catalog/endpoints", { endpoints }),
};

// ── Flows ─────────────────────────────────────────────────────────────────────
export const flowsApi = {
  list: (params?: Record<string, unknown>) =>
    apiClient.get("/flows", { params }),
  get: (id: number) => apiClient.get(`/flows/${id}`),
  create: (data: { nombre: string; tenantId: string }) =>
    apiClient.post("/flows", data),
  update: (id: number, data: Record<string, unknown>) =>
    apiClient.put(`/flows/${id}`, data),
  delete: (id: number) => apiClient.delete(`/flows/${id}`),
  exportJson: (params?: Record<string, unknown>) =>
    apiClient.get("/flows/export", { params }),
  execute: (id: number, data: Record<string, unknown>) =>
    apiClient.post(`/flows/${id}/execute`, data),
  getEndpointsCatalog: (params?: Record<string, unknown>) =>
    apiClient.get("/integrations/catalog/endpoints", { params }),
};

// ── Variables ─────────────────────────────────────────────────────────────────
export const variablesApi = {
  list: (params?: { flowId?: number | null; scope?: string; tenantSlug?: string }) =>
    apiClient.get("/variables", { params }),
  create: (data: {
    nombre: string;
    tipo?: string;
    valorDefault?: unknown;
    descripcion?: string;
    scope?: string;
    flowId?: number | null;
    tenantSlug?: string;
  }) => apiClient.post("/variables", data),
  update: (
    id: number,
    data: {
      nombre?: string;
      tipo?: string;
      valorDefault?: unknown;
      descripcion?: string;
      scope?: string;
      tenantSlug?: string;
    }
  ) => apiClient.put(`/variables/${id}`, data),
  remove: (id: number, tenantSlug?: string) =>
    apiClient.delete(`/variables/${id}`, {
      params: tenantSlug ? { tenantSlug } : undefined,
    }),
  seedDefaults: (tenantSlug?: string) =>
    apiClient.post("/variables/seed-defaults", tenantSlug ? { tenantSlug } : {}),
};

// ── WABA Flow Integration ─────────────────────────────────────────────────────
export const wabaFlowsApi = {
  list: (params?: { activo?: boolean; page?: number; limit?: number; tenantSlug?: string }) =>
    apiClient.get("/waba-flows", { params }),
  get: (id: number) => apiClient.get(`/waba-flows/${id}`),
  create: (data: { nombre: string; definition?: unknown; changelog?: string; tenantSlug?: string }) =>
    apiClient.post("/waba-flows", data),
  update: (id: number, data: { nombre?: string; activo?: boolean }) =>
    apiClient.put(`/waba-flows/${id}`, data),
  remove: (id: number) => apiClient.delete(`/waba-flows/${id}`),
  import: (data: { wabaJson: unknown; nombre?: string; changelog?: string; tenantSlug?: string }) =>
    apiClient.post("/waba-flows/import", data),
  export: (id: number, params?: { versionId?: number; download?: boolean }) =>
    apiClient.get(`/waba-flows/${id}/export`, { params }),
  validate: (id: number, data?: { versionId?: number; definition?: unknown }) =>
    apiClient.post(`/waba-flows/${id}/validate`, data ?? {}),
  simulate: (id: number, data: { inputs?: string[]; versionId?: number; definition?: unknown; mode?: 'single' | 'exhaustive'; useLlm?: boolean; tenantSlug?: string }) =>
    apiClient.post(`/waba-flows/${id}/simulate`, data),
  listVersions: (id: number, tenantSlug?: string) =>
    apiClient.get(`/waba-flows/${id}/versions`, {
      params: tenantSlug ? { tenantSlug } : undefined,
    }),
  getVersion: (id: number, vId: number, tenantSlug?: string) =>
    apiClient.get(`/waba-flows/${id}/versions/${vId}`, {
      params: tenantSlug ? { tenantSlug } : undefined,
    }),
  saveVersion: (id: number, data: { definition: unknown; changelog?: string; tenantSlug?: string }) =>
    apiClient.post(`/waba-flows/${id}/versions`, data),
  publishVersion: (id: number, vId: number, publish = true, tenantSlug?: string) =>
    apiClient.put(`/waba-flows/${id}/versions/${vId}/publish`, {
      publish,
      ...(tenantSlug ? { tenantSlug } : {}),
    }),
  rollback: (id: number, vId: number, tenantSlug?: string) =>
    apiClient.post(`/waba-flows/${id}/versions/${vId}/rollback`, tenantSlug ? { tenantSlug } : {}),
  importLogs: (params?: { page?: number; limit?: number; tenantSlug?: string }) =>
    apiClient.get("/waba-flows/import-logs", { params }),
  flowsApi: (id: number) => apiClient.get(`/waba-flows/${id}`),
};

// ── CRM ───────────────────────────────────────────────────────────────────────
export const crmApi = {
  listContacts: (params?: Record<string, unknown>) =>
    apiClient.get('/crm/contacts', { params }),
  getContact: (id: number, tenantSlug?: string) =>
    apiClient.get(`/crm/contacts/${id}`, { params: tenantSlug ? { tenantSlug } : {} }),
  createContact: (data: Record<string, unknown>) =>
    apiClient.post('/crm/contacts', data),
  updateContact: (id: number, data: Record<string, unknown>) =>
    apiClient.patch(`/crm/contacts/${id}`, data),
  deleteContact: (id: number) =>
    apiClient.delete(`/crm/contacts/${id}`),
  listDeals: (params?: Record<string, unknown>) =>
    apiClient.get('/crm/deals', { params }),
  createDeal: (data: Record<string, unknown>) =>
    apiClient.post('/crm/deals', data),
  updateDeal: (id: number, data: Record<string, unknown>) =>
    apiClient.patch(`/crm/deals/${id}`, data),
  deleteDeal: (id: number) =>
    apiClient.delete(`/crm/deals/${id}`),
  listTasks: (params?: Record<string, unknown>) =>
    apiClient.get('/crm/tasks', { params }),
  createTask: (data: Record<string, unknown>) =>
    apiClient.post('/crm/tasks', data),
  updateTask: (id: number, data: Record<string, unknown>) =>
    apiClient.patch(`/crm/tasks/${id}`, data),
  deleteTask: (id: number) =>
    apiClient.delete(`/crm/tasks/${id}`),
};

// ── Conversations (event-sourced) ─────────────────────────────────────────────
export const conversationsApi = {
  /** Paginated list of conversations for a tenant */
  list: (params: { tenantSlug?: string; status?: string; flowId?: number; userKey?: string; from?: string; to?: string; page?: number; limit?: number }) =>
    apiClient.get('/conversations', { params }),
  /** Full conversation detail with event timeline */
  getById: (id: string, params?: { tenantSlug?: string }) =>
    apiClient.get(`/conversations/${id}`, { params }),
  /** Lazy-load events for a conversation (supports cursor-based pagination) */
  getEvents: (id: string, params?: { tenantSlug?: string; eventType?: string; after?: string; limit?: number }) =>
    apiClient.get(`/conversations/${id}/events`, { params }),
  /** Admin force-close a conversation */
  updateStatus: (id: string, status: 'completed' | 'abandoned' | 'error') =>
    apiClient.patch(`/conversations/${id}`, { status }),
};

export const sandboxApi = {
  capabilities: (params?: { tenantSlug?: string; tenantId?: string }) =>
    apiClient.get('/sandbox/capabilities', { params }),
  simulateInbound: (data: {
    tenantId?: string;
    tenantSlug?: string;
    phone: string;
    text: string;
    contactName?: string;
    phoneNumberId?: string;
    accessToken?: string;
  }) => apiClient.post('/sandbox/simulate/inbound', data),
  listRuns: (params: { tenantSlug?: string; tenantId?: string; userKey: string; limit?: number }) =>
    apiClient.get('/sandbox/runs', { params }),
  getRun: (id: string, params?: { tenantSlug?: string; tenantId?: string }) =>
    apiClient.get(`/sandbox/runs/${id}`, { params }),
  updateSettings: (data: { tenantSlug?: string; tenantId?: string; outboundMetaMock: boolean }) =>
    apiClient.patch('/sandbox/settings', data),
  replayRun: (id: string, data?: { tenantSlug?: string; tenantId?: string; phoneNumberId?: string; accessToken?: string }) =>
    apiClient.post(`/sandbox/runs/${id}/replay`, data),
  checkCompliance: (id: string, data?: { tenantSlug?: string; tenantId?: string }) =>
    apiClient.post(`/sandbox/runs/${id}/compliance`, data),
};

// ── Device Sessions & MFA (Phase 2: Enterprise Security) ─────────────────────
export const deviceSessionsApi = {
  // Admin device sessions
  listAdminDevices: () => apiClient.get('/device-sessions/admin'),
  revokeAdminDevice: (sessionId: string) =>
    apiClient.post(`/device-sessions/admin/${sessionId}/revoke`),
  
  // Agent device sessions
  listAgentDevices: () => apiClient.get('/device-sessions/agent'),
  revokeAgentDevice: (sessionId: string) =>
    apiClient.post(`/device-sessions/agent/${sessionId}/revoke`),
  
  // MFA recovery codes
  generateRecoveryCodes: () =>
    apiClient.post('/device-sessions/mfa/generate-recovery-codes'),
  getRecoveryCodesCount: () =>
    apiClient.get('/device-sessions/mfa/recovery-codes-count'),
};
