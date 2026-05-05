import axios from "axios";
import { addLog } from "./errorLogger";
import { scheduleProactiveRefresh, useAuthStore } from "@/store/auth";

function resolveApiBase(): string {
  const envBase = process.env.NEXT_PUBLIC_API_URL?.trim();
  if (envBase) return envBase.replace(/\/+$/, "");

  if (typeof window !== "undefined") {
    const { protocol, hostname } = window.location;
    if (hostname === "localhost" || hostname === "127.0.0.1") {
      return "http://localhost:3200";
    }
    // In production-like environments, prefer same-origin if explicit API URL is missing.
    return `${protocol}//${hostname}`;
  }

  return "http://localhost:3200";
}

const API_BASE = resolveApiBase();

export const apiClient = axios.create({
  baseURL: API_BASE,
  headers: { "Content-Type": "application/json" },
  timeout: 10000,
});

// Attach JWT token from localStorage on every request
apiClient.interceptors.request.use((config) => {
  if (typeof window !== "undefined") {
    const token = localStorage.getItem("admin_token");
    if (token) config.headers.Authorization = `Bearer ${token}`;
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
  localStorage.removeItem("admin_token");
  localStorage.removeItem("admin_refresh_token");
  localStorage.removeItem("auth-storage");
  document.cookie = "admin_token=; path=/; SameSite=Strict; max-age=0";
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
      !!localStorage.getItem("admin_refresh_token");

    // Only log non-recoverable errors immediately; recoverable 401s are logged only if refresh fails
    if (!isRecoverable401) {
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
      const storedRefreshToken = localStorage.getItem("admin_refresh_token");

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
              const { setToken, refreshToken: rt } = useAuthStore.getState();
              setToken(accessToken, expiresIn);
              scheduleProactiveRefresh(expiresIn ?? 900, async () => {
                const currentRefreshToken = localStorage.getItem("admin_refresh_token");
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
  login: (email: string, password: string) =>
    apiClient.post<{ accessToken: string; refreshToken?: string; expiresIn: number; superAdmin: boolean }>("/auth/login", {
      email,
      password,
    }),
  loginWithFacebook: (accessToken: string) =>
    apiClient.post<{ accessToken: string; refreshToken?: string; expiresIn: number; superAdmin: boolean }>("/auth/facebook", {
      accessToken,
    }),
  loginWithGoogle: (credential: string) =>
    apiClient.post<{ accessToken: string; refreshToken?: string; expiresIn: number; superAdmin: boolean }>("/auth/google", {
      credential,
    }),
  logout: (refreshToken?: string) =>
    apiClient.post("/auth/logout", refreshToken ? { refreshToken } : {}),
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

export const solicitudesApi = {
  list: (slug: string, params?: Record<string, unknown>) =>
    apiClient.get(`/admin/tenants/${slug}/solicitudes`, { params }),
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
};

export const agentesApi = {
  list: (slug: string) => apiClient.get(`/admin/tenants/${slug}/agentes`),
  create: (slug: string, data: Record<string, unknown>) =>
    apiClient.post(`/admin/tenants/${slug}/agentes`, data),
  updateEstado: (slug: string, id: number, estado: string) =>
    apiClient.patch(`/admin/tenants/${slug}/agentes/${id}/estado`, { estado }),
};

export const metricsApi = {
  get: (slug: string) => apiClient.get(`/admin/tenants/${slug}/metrics`),
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

// ── LLM / WABA Rescue ───────────────────────────────────────────────────────
export const llmApi = {
  status: (tenantId?: string) =>
    apiClient.get("/llm/status", { params: tenantId ? { tenantId } : {} }),
  validate: (flowJson: unknown) =>
    apiClient.post("/llm/validate", { flowJson }),
  rescue: (payload: { originalJson: unknown; wabaError: unknown; tenantId?: string }) =>
    apiClient.post("/llm/rescue", payload),
  listRescues: (params?: Record<string, unknown>) =>
    apiClient.get("/llm/rescue", { params }),
  getRescue: (id: number) =>
    apiClient.get(`/llm/rescue/${id}`),
  /** POST /llm/prompt-assistant — validate prompt and ask follow-up questions */
  promptAssistant: (payload: {
    tenantId?: string;
    draftPrompt?: string;
    userMessage?: string;
    brief?: Record<string, unknown>;
    history?: Array<{ role: "user" | "assistant"; text: string }>;
  }) => apiClient.post("/llm/prompt-assistant", payload, { timeout: 120000 }),
  /** POST /llm/design-intelligent-flow — enterprise orchestrator response */
  designIntelligentFlow: (payload: { prompt: string; tenantId?: string }) =>
    apiClient.post("/llm/design-intelligent-flow", payload, { timeout: 120000 }),
  /** POST /llm/generate-flow — prompt → Meta WhatsApp Flow JSON */
  generateFlow: (payload: { prompt: string; tenantId?: string }) =>
    apiClient.post("/llm/generate-flow", payload, { timeout: 120000 }),
  /** POST /llm/simulate-flow — dry-run simulation of a Meta WABA flow JSON */
  simulateFlow: (payload: {
    flowJson: unknown;
    dataContract?: unknown;
    tenantId?: string;
  }) => apiClient.post("/llm/simulate-flow", payload, { timeout: 60000 }),
  /** POST /llm/save-flow-draft — save design as inactive draft pending approval */
  saveFlowDraft: (payload: {
    flowJson: unknown;
    nombre: string;
    tenantId?: string;
    designReport?: unknown;
  }) => apiClient.post("/llm/save-flow-draft", payload, { timeout: 30000 }),
  /** POST /llm/approve-flow/:draftId — approve and publish a saved draft */
  approveFlow: (draftId: number, tenantId?: string) =>
    apiClient.post(`/llm/approve-flow/${draftId}`, { tenantId }),
  /** POST /llm/design-intelligent-flow/feedback — record good/bad rating */
  submitFeedback: (payload: {
    rating: "good" | "bad";
    tenantId?: string;
    prompt?: string;
    intent?: string;
    flowId?: number;
    corrections?: string;
  }) => apiClient.post("/llm/design-intelligent-flow/feedback", payload, { timeout: 15000 }),
  /** GET /llm/flow-history — paginated list of AI-designed flows with feedback */
  flowHistory: (params: {
    tenantId?: string;
    page?: number;
    limit?: number;
    status?: "draft" | "published" | "all";
  }) => apiClient.get("/llm/flow-history", { params }),
  /** GET /llm/flow-metrics — aggregated orchestrator stats */
  flowMetrics: (tenantId?: string) =>
    apiClient.get("/llm/flow-metrics", { params: tenantId ? { tenantId } : {} }),
};

// ── WhatsApp Business ─────────────────────────────────────────────────────────
export const whatsappApi = {
  /** One row per unique user — latest message per thread */
  listConversaciones: (tenantId: string) =>
    apiClient.get("/whatsapp/conversaciones", { params: { tenantId } }),
  /** Full message history for one user */
  listMensajes: (tenantId: string, userId: number, page = 1) =>
    apiClient.get("/whatsapp/mensajes", {
      params: { tenantId, userId, page, limit: 50 },
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
  simulate: (id: number, data: { inputs?: string[]; versionId?: number; definition?: unknown }) =>
    apiClient.post(`/waba-flows/${id}/simulate`, data),
  listVersions: (id: number) =>
    apiClient.get(`/waba-flows/${id}/versions`),
  getVersion: (id: number, vId: number) =>
    apiClient.get(`/waba-flows/${id}/versions/${vId}`),
  saveVersion: (id: number, data: { definition: unknown; changelog?: string }) =>
    apiClient.post(`/waba-flows/${id}/versions`, data),
  publishVersion: (id: number, vId: number, publish = true) =>
    apiClient.put(`/waba-flows/${id}/versions/${vId}/publish`, { publish }),
  rollback: (id: number, vId: number) =>
    apiClient.post(`/waba-flows/${id}/versions/${vId}/rollback`),
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

