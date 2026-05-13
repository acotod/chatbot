"use client";

import { adminUsersApi, agentePuestosApi, agendaApi, apiClient, configApi, solicitudesApi } from "@/lib/api";
import { useAuthStore } from "@/store/auth";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { CalendarDays, Check, Pencil, Trash2, X, Settings, MessageSquare, Lock, Briefcase, Palette } from "lucide-react";

// ── LLM config types ──────────────────────────────────────────────────────────
type LlmProvider = "openai" | "anthropic" | "custom";

const PROVIDER_MODELS: Record<LlmProvider, { label: string; value: string }[]> = {
  openai: [
    { label: "GPT-4o", value: "gpt-4o" },
    { label: "GPT-4o Mini", value: "gpt-4o-mini" },
    { label: "GPT-4 Turbo", value: "gpt-4-turbo" },
  ],
  anthropic: [
    { label: "Claude 3.5 Sonnet", value: "claude-3-5-sonnet-20241022" },
    { label: "Claude 3.5 Haiku", value: "claude-3-5-haiku-20241022" },
    { label: "Claude 3 Opus", value: "claude-3-opus-20240229" },
  ],
  custom: [],
};

const PROVIDER_LABELS: Record<LlmProvider, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  custom: "Custom (OpenAI-compatible)",
};

function ConfigSection({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <h2 className="font-semibold text-slate-900">{title}</h2>
        {description && (
          <p className="text-sm text-slate-500 mt-0.5">{description}</p>
        )}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

interface AgentePuesto {
  id: number;
  nombre: string;
}

interface SolicitudesTenantConfig {
  enterpriseEnabled: boolean;
  advancedSearchEnabled: boolean;
  slaEnabled: boolean;
  warningThresholdMinutes: number;
  manualEscalationEnabled: boolean;
  autoEscalationEnabled: boolean;
  escalationIntervalMinutes: number;
  assignmentRulesEnabled: boolean;
  customerPortalEnabled: boolean;
  webhooksEnabled: boolean;
}

const DEFAULT_SOLICITUDES_CONFIG: SolicitudesTenantConfig = {
  enterpriseEnabled: true,
  advancedSearchEnabled: true,
  slaEnabled: true,
  warningThresholdMinutes: 60,
  manualEscalationEnabled: true,
  autoEscalationEnabled: false,
  escalationIntervalMinutes: 30,
  assignmentRulesEnabled: true,
  customerPortalEnabled: false,
  webhooksEnabled: false,
};

interface AdminUserItem {
  id: number;
  nombre: string;
  email: string;
  jefeId: number | null;
  superAdmin: boolean;
}

function AdminHierarchySection({ tenantSlug }: { tenantSlug: string }) {
  const qc = useQueryClient();
  const { data: rawData } = useQuery({
    queryKey: ["admin-users", tenantSlug],
    queryFn: () => adminUsersApi.list(tenantSlug).then((r) => r.data),
    enabled: !!tenantSlug,
  });
  const adminUsers: AdminUserItem[] = rawData?.data ?? rawData ?? [];

  const setJefeMutation = useMutation({
    mutationFn: ({ id, jefeId }: { id: number; jefeId: number | null }) =>
      adminUsersApi.setJefe(tenantSlug, id, jefeId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-users", tenantSlug] }),
  });

  if (!tenantSlug) return null;

  return (
    <ConfigSection
      title="Jerarquía de administradores"
      description="Asigná el jefe (superior directo) de cada usuario administrador para construir el árbol de escalación."
    >
      <div className="space-y-3">
        {adminUsers.length === 0 ? (
          <p className="text-sm text-slate-500">No hay administradores en este tenant.</p>
        ) : (
          adminUsers.map((user) => {
            const otherUsers = adminUsers.filter((u) => u.id !== user.id);
            return (
              <div key={user.id} className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-3 py-2">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-slate-800 truncate">{user.nombre}</p>
                  <p className="text-xs text-slate-500 truncate">{user.email}</p>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-slate-400">Jefe:</span>
                  <select
                    value={user.jefeId ?? ""}
                    onChange={(e) => {
                      const val = e.target.value === "" ? null : Number(e.target.value);
                      setJefeMutation.mutate({ id: user.id, jefeId: val });
                    }}
                    disabled={setJefeMutation.isPending}
                    className="text-sm border border-slate-200 rounded-lg px-2 py-1 bg-white focus:outline-none focus:ring-2 focus:ring-rose-500/30"
                  >
                    <option value="">— Sin jefe —</option>
                    {otherUsers.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.nombre}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            );
          })
        )}
      </div>
    </ConfigSection>
  );
}

export default function ConfiguracionPage() {
  const { tenantSlug } = useAuthStore();
  const qc = useQueryClient();

  const [saved, setSaved] = useState(false);
  const [horarios, setHorarios] = useState({
    inicio: "08:00",
    fin: "18:00",
    dias: [1, 2, 3, 4, 5] as number[],
  });
  const [mensajeBienvenida, setMensajeBienvenida] = useState(
    "¡Hola! Estamos aquí para apoyarte. ¿En qué podemos ayudarte hoy? 💙"
  );

  // WhatsApp Business credentials
  const [waCreds, setWaCreds] = useState({ phoneNumberId: "", accessToken: "" });
  const [waTokenConfigured, setWaTokenConfigured] = useState(false);
  const [waSaved, setWaSaved] = useState(false);
  const [emailSettings, setEmailSettings] = useState({
    smtpUrl: "",
    smtpHost: "",
    smtpPort: "587",
    smtpSecure: false,
    smtpUser: "",
    smtpPass: "",
    emailFrom: "",
    adminBaseUrl: "",
  });
  const [emailPassConfigured, setEmailPassConfigured] = useState(false);
  const [emailSaved, setEmailSaved] = useState(false);
  const [puestoNombre, setPuestoNombre] = useState("");
  const [puestoError, setPuestoError] = useState("");
  const [editingPuestoId, setEditingPuestoId] = useState<number | null>(null);
  const [editingPuestoNombre, setEditingPuestoNombre] = useState("");

  // LLM config
  const [llm, setLlm] = useState<{
    provider: LlmProvider;
    model: string;
    api_key: string;
    base_url: string;
    max_tokens: number;
    temperature: number;
  }>({
    provider: "openai",
    model: "gpt-4o-mini",
    api_key: "",
    base_url: "",
    max_tokens: 4096,
    temperature: 0.2,
  });
  // True when the server already has an api_key saved
  const [llmKeyConfigured, setLlmKeyConfigured] = useState(false);
  const [llmSaved, setLlmSaved] = useState(false);

  // Account Lockout Policy
  const [lockoutPolicy, setLockoutPolicy] = useState({
    maxAttempts: 5,
    lockoutMinutes: 15,
  });
  const [lockoutSaved, setLockoutSaved] = useState(false);
  const [enterpriseConfigDraft, setEnterpriseConfigDraft] =
    useState<SolicitudesTenantConfig>(DEFAULT_SOLICITUDES_CONFIG);

  const { data: waCredsData } = useQuery({
    queryKey: ["config", tenantSlug, "wa_credentials"],
    queryFn: () =>
      configApi.get(tenantSlug, "wa_credentials").then((r) => {
        const v = r?.data?.valor;
        if (v) {
          setWaCreds({
            phoneNumberId: v.phoneNumberId ?? "",
            accessToken: "",
          });
          setWaTokenConfigured(v.accessToken === "__configured__");
        }
        return r?.data;
      }),
    enabled: !!tenantSlug,
  });
  void waCredsData;

  const { data: emailSettingsData } = useQuery({
    queryKey: ["config", tenantSlug, "email_settings"],
    queryFn: () =>
      configApi.get(tenantSlug!, "email_settings").then((r) => {
        const v = r?.data?.valor;
        if (v) {
          setEmailSettings((prev) => ({
            ...prev,
            smtpUrl: v.smtpUrl ?? "",
            smtpHost: v.smtpHost ?? "",
            smtpPort: v.smtpPort ? String(v.smtpPort) : prev.smtpPort,
            smtpSecure: Boolean(v.smtpSecure),
            smtpUser: v.smtpUser ?? "",
            smtpPass: "",
            emailFrom: v.emailFrom ?? "",
            adminBaseUrl: v.adminBaseUrl ?? "",
          }));
          setEmailPassConfigured(v.smtpPass === "__configured__");
        }
        return r?.data;
      }),
    enabled: !!tenantSlug,
  });
  void emailSettingsData;

  // LLM config query
  const { data: llmConfigData } = useQuery({
    queryKey: ["config", tenantSlug, "llm_config"],
    queryFn: () =>
      configApi.get(tenantSlug!, "llm_config").then((r) => {
        const v = r?.data?.valor;
        if (v) {
          setLlm((prev) => ({
            ...prev,
            provider: (v.provider as LlmProvider) ?? "openai",
            model: v.model ?? prev.model,
            base_url: v.base_url ?? "",
            max_tokens: v.max_tokens ?? 4096,
            temperature: v.temperature ?? 0.2,
            api_key: "", // never populate from server
          }));
          if (v.api_key === "__configured__") setLlmKeyConfigured(true);
        }
        return r?.data;
      }),
    enabled: !!tenantSlug,
  });
  void llmConfigData;

  const saveLlmMutation = useMutation({
    mutationFn: () => {
      const payload: Record<string, unknown> = {
        provider: llm.provider,
        model: llm.model,
        max_tokens: llm.max_tokens,
        temperature: llm.temperature,
      };
      // Only send api_key if the user typed a new one; otherwise send sentinel
      payload.api_key = llm.api_key.trim() !== "" ? llm.api_key.trim() : "__configured__";
      if (llm.provider === "custom" && llm.base_url.trim()) {
        payload.base_url = llm.base_url.trim();
      }
      return configApi.set(tenantSlug!, "llm_config", payload);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["config", tenantSlug, "llm_config"] });
      setLlmSaved(true);
      setLlmKeyConfigured(true);
      setLlm((prev) => ({ ...prev, api_key: "" }));
      setTimeout(() => setLlmSaved(false), 3000);
    },
  });

  const saveWaMutation = useMutation({
    mutationFn: () =>
      configApi.set(tenantSlug, "wa_credentials", {
        phoneNumberId: waCreds.phoneNumberId,
        accessToken: waCreds.accessToken.trim() !== "" ? waCreds.accessToken.trim() : "__configured__",
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["config", tenantSlug, "wa_credentials"] });
      setWaTokenConfigured(true);
      setWaCreds((prev) => ({ ...prev, accessToken: "" }));
      setWaSaved(true);
      setTimeout(() => setWaSaved(false), 3000);
    },
  });

  const saveEmailMutation = useMutation({
    mutationFn: () =>
      configApi.set(tenantSlug!, "email_settings", {
        smtpUrl: emailSettings.smtpUrl.trim(),
        smtpHost: emailSettings.smtpHost.trim(),
        smtpPort: emailSettings.smtpPort.trim(),
        smtpSecure: emailSettings.smtpSecure,
        smtpUser: emailSettings.smtpUser.trim(),
        smtpPass:
          emailSettings.smtpPass.trim() !== ""
            ? emailSettings.smtpPass.trim()
            : "__configured__",
        emailFrom: emailSettings.emailFrom.trim(),
        adminBaseUrl: emailSettings.adminBaseUrl.trim(),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["config", tenantSlug, "email_settings"] });
      setEmailPassConfigured(true);
      setEmailSettings((prev) => ({ ...prev, smtpPass: "" }));
      setEmailSaved(true);
      setTimeout(() => setEmailSaved(false), 3000);
    },
  });

  const { data: puestosData } = useQuery({
    queryKey: ["agente-puestos", tenantSlug],
    queryFn: () => agentePuestosApi.list(tenantSlug!).then((r) => r.data),
    enabled: !!tenantSlug,
  });

  const createPuestoMutation = useMutation({
    mutationFn: () => agentePuestosApi.create(tenantSlug!, { nombre: puestoNombre.trim() }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["agente-puestos", tenantSlug] });
      setPuestoNombre("");
      setPuestoError("");
    },
    onError: () => setPuestoError("No se pudo crear el puesto."),
  });

  const updatePuestoMutation = useMutation({
    mutationFn: ({ id, nombre }: { id: number; nombre: string }) =>
      agentePuestosApi.update(tenantSlug!, id, { nombre: nombre.trim() }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["agente-puestos", tenantSlug] });
      setEditingPuestoId(null);
      setEditingPuestoNombre("");
      setPuestoError("");
    },
    onError: () => setPuestoError("No se pudo actualizar el puesto."),
  });

  const deletePuestoMutation = useMutation({
    mutationFn: (id: number) => agentePuestosApi.remove(tenantSlug!, id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["agente-puestos", tenantSlug] });
      setPuestoError("");
    },
    onError: () => setPuestoError("No se pudo eliminar el puesto."),
  });

  const { data: configData } = useQuery({
    queryKey: ["config", tenantSlug, "horarios"],
    queryFn: () =>
      apiClient
        .get(`/admin/tenants/${tenantSlug}/config/horarios`)
        .then((r) => {
          const v = r.data?.valor;
          if (v?.inicio) setHorarios({ ...v, dias: v.dias ?? [1, 2, 3, 4, 5] });
          return r.data;
        })
        .catch(() => null),
    enabled: !!tenantSlug,
  });

  const { data: solicitudesConfigData } = useQuery({
    queryKey: ["solicitudes-config", tenantSlug],
    queryFn: () =>
      solicitudesApi
        .getConfig(tenantSlug)
        .then((r) => r.data as SolicitudesTenantConfig),
    enabled: !!tenantSlug,
  });

  const { data: lockoutPolicyData } = useQuery({
    queryKey: ["lockout-policy", tenantSlug],
    queryFn: () =>
      apiClient
        .get(`/admin/tenants/${tenantSlug}/lockout-policy`)
        .then((r) => {
          const v = r.data;
          if (v?.maxAttempts && v?.lockoutMinutes) {
            setLockoutPolicy({ maxAttempts: v.maxAttempts, lockoutMinutes: v.lockoutMinutes });
          }
          return r.data;
        })
        .catch(() => null),
    enabled: !!tenantSlug,
  });

  const saveLockoutPolicyMutation = useMutation({
    mutationFn: () =>
      apiClient.put(`/admin/tenants/${tenantSlug}/lockout-policy`, lockoutPolicy),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["lockout-policy", tenantSlug] });
      setLockoutSaved(true);
      setTimeout(() => setLockoutSaved(false), 3000);
    },
  });

  const saveMutation = useMutation({
    mutationFn: () =>
      Promise.all([
        apiClient.put(`/admin/tenants/${tenantSlug}/config/horarios`, {
          valor: horarios,
        }),
        apiClient.put(`/admin/tenants/${tenantSlug}/config/bienvenida`, {
          valor: { mensaje: mensajeBienvenida },
        }),
      ]),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["config"] });
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    },
  });

  const saveSolicitudesEnterpriseConfigMutation = useMutation({
    mutationFn: (payload: SolicitudesTenantConfig) =>
      solicitudesApi.updateConfig(tenantSlug, payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["solicitudes-config", tenantSlug] });
      qc.invalidateQueries({ queryKey: ["solicitudes"] });
      qc.invalidateQueries({ queryKey: ["solicitudes-stats"] });
    },
  });

  void configData;
  const tenantSolicitudesConfig = {
    ...DEFAULT_SOLICITUDES_CONFIG,
    ...(solicitudesConfigData || {}),
  };

  useEffect(() => {
    setEnterpriseConfigDraft(tenantSolicitudesConfig);
  }, [
    tenantSolicitudesConfig.enterpriseEnabled,
    tenantSolicitudesConfig.advancedSearchEnabled,
    tenantSolicitudesConfig.slaEnabled,
    tenantSolicitudesConfig.warningThresholdMinutes,
    tenantSolicitudesConfig.manualEscalationEnabled,
    tenantSolicitudesConfig.autoEscalationEnabled,
    tenantSolicitudesConfig.escalationIntervalMinutes,
    tenantSolicitudesConfig.assignmentRulesEnabled,
    tenantSolicitudesConfig.customerPortalEnabled,
    tenantSolicitudesConfig.webhooksEnabled,
  ]);

  const puestos: AgentePuesto[] = puestosData?.data ?? puestosData ?? [];

  function handleCreatePuesto() {
    if (!puestoNombre.trim()) {
      setPuestoError("Escribí un nombre para el puesto.");
      return;
    }
    setPuestoError("");
    createPuestoMutation.mutate();
  }

  function startEditPuesto(puesto: AgentePuesto) {
    setPuestoError("");
    setEditingPuestoId(puesto.id);
    setEditingPuestoNombre(puesto.nombre);
  }

  function saveEditPuesto() {
    if (!editingPuestoId) return;
    if (!editingPuestoNombre.trim()) {
      setPuestoError("El nombre no puede quedar vacío.");
      return;
    }
    setPuestoError("");
    updatePuestoMutation.mutate({ id: editingPuestoId, nombre: editingPuestoNombre });
  }

  // --- Agenda feature flag ---
  const { data: agendaFeature } = useQuery({
    queryKey: ["config", tenantSlug, "agenda_feature"],
    queryFn: () => agendaApi.feature.get(tenantSlug!).then((r) => r.data),
    enabled: !!tenantSlug,
  });
  const agendaEnabled: boolean = agendaFeature?.enabled ?? false;

  const agendaToggleMutation = useMutation({
    mutationFn: (enabled: boolean) => agendaApi.feature.set(tenantSlug!, enabled),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["config", tenantSlug, "agenda_feature"] });
    },
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between mb-2">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Configuración</h1>
          <p className="text-sm text-slate-500">Administrá todos los aspectos de tu tenant</p>
        </div>
      </div>

      <Tabs defaultValue="comunicacion" className="w-full">
        <TabsList className="w-full justify-start overflow-x-auto bg-slate-50 border-b border-slate-200">
          <TabsTrigger value="comunicacion" className="flex items-center gap-2">
            <MessageSquare size={16} />
            Comunicación
          </TabsTrigger>
          <TabsTrigger value="email-ia" className="flex items-center gap-2">
            <Settings size={16} />
            Email & IA
          </TabsTrigger>
          <TabsTrigger value="organizacion" className="flex items-center gap-2">
            <Briefcase size={16} />
            Organización
          </TabsTrigger>
          <TabsTrigger value="modulos" className="flex items-center gap-2">
            <Lock size={16} />
            Módulos
          </TabsTrigger>
          <TabsTrigger value="branding" className="flex items-center gap-2">
            <Palette size={16} />
            Branding
          </TabsTrigger>
        </TabsList>

        {/* ═══════════════════════════════════════════════════════════ */}
        {/* COMUNICACIÓN */}
        {/* ═══════════════════════════════════════════════════════════ */}
        <TabsContent value="comunicacion" className="space-y-6 mt-4">
          {/* Horarios */}
          <ConfigSection
            title="Horarios de atención"
            description="Definí en qué rango horario el chatbot acepta nuevas solicitudes"
          >
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <Input
                  label="Hora de apertura"
                  type="time"
                  value={horarios.inicio}
                  onChange={(e) =>
                    setHorarios((h) => ({ ...h, inicio: e.target.value }))
                  }
                />
                <Input
                  label="Hora de cierre"
                  type="time"
                  value={horarios.fin}
                  onChange={(e) =>
                    setHorarios((h) => ({ ...h, fin: e.target.value }))
                  }
                />
              </div>
              <div>
                <p className="text-sm font-medium text-slate-700 mb-2">Días de atención</p>
                <div className="flex gap-2 flex-wrap">
                  {[
                    { label: "Dom", value: 0 },
                    { label: "Lun", value: 1 },
                    { label: "Mar", value: 2 },
                    { label: "Mié", value: 3 },
                    { label: "Jue", value: 4 },
                    { label: "Vie", value: 5 },
                    { label: "Sáb", value: 6 },
                  ].map(({ label, value }) => {
                    const active = (horarios.dias ?? []).includes(value);
                    return (
                      <button
                        key={value}
                        type="button"
                        onClick={() =>
                          setHorarios((h) => ({
                            ...h,
                            dias: active
                              ? (h.dias ?? []).filter((d) => d !== value)
                              : [...(h.dias ?? []), value].sort(),
                          }))
                        }
                        className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-all ${
                          active
                            ? "bg-blue-600 text-white border-blue-600"
                            : "bg-white text-slate-500 border-slate-200 hover:border-blue-400"
                        }`}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </ConfigSection>

          {/* Mensajes */}
          <ConfigSection
            title="Mensaje de bienvenida"
            description="Primer mensaje que recibe el usuario al iniciar el flujo"
          >
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium text-slate-700">
                Texto del mensaje
              </label>
              <textarea
                value={mensajeBienvenida}
                onChange={(e) => setMensajeBienvenida(e.target.value)}
                rows={3}
                className="px-3.5 py-2.5 rounded-xl border border-slate-200 bg-white text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500 resize-none transition-all"
              />
              <p className="text-xs text-slate-400">
                Tip: usá un tono cercano y empático 💙
              </p>
            </div>
          </ConfigSection>

          {/* WhatsApp Business */}
          <ConfigSection
            title="WhatsApp Business"
            description="Credenciales para enviar y recibir mensajes desde Meta Cloud API"
          >
            <div className="space-y-4">
              <Input
                label="Phone Number ID"
                placeholder="123456789012345"
                value={waCreds.phoneNumberId}
                onChange={(e) => setWaCreds((c) => ({ ...c, phoneNumberId: e.target.value }))}
              />
              <Input
                label="Access Token"
                placeholder={waTokenConfigured ? "•••••••• (ya configurado)" : "EAAGm..."}
                value={waCreds.accessToken}
                onChange={(e) => setWaCreds((c) => ({ ...c, accessToken: e.target.value }))}
                type="password"
              />
              <p className="text-xs text-slate-400">
                Token de usuario del sistema con permiso <code>whatsapp_business_messaging</code>.
                Obtenelo en Meta Business Manager → Configuración de sistema.
              </p>
              <div className="flex justify-end">
                <Button onClick={() => saveWaMutation.mutate()} disabled={saveWaMutation.isPending}>
                  {waSaved ? (
                    <><Check size={16} /> Guardado 💙</>
                  ) : saveWaMutation.isPending ? "Guardando..." : "Guardar credenciales"}
                </Button>
              </div>
            </div>
          </ConfigSection>

          {/* Save button for this tab */}
          <div className="flex items-center justify-between pt-4 border-t border-slate-200">
            <p className="text-sm text-slate-400">
              Los cambios se aplican de inmediato
            </p>
            <Button
              onClick={() => saveMutation.mutate()}
              disabled={saveMutation.isPending}
            >
              {saved ? (
                <>
                  <Check size={16} />
                  Guardado 💙
                </>
              ) : saveMutation.isPending ? (
                "Guardando..."
              ) : (
                "Guardar cambios"
              )}
            </Button>
          </div>
        </TabsContent>

        {/* ═══════════════════════════════════════════════════════════ */}
        {/* EMAIL & IA */}
        {/* ═══════════════════════════════════════════════════════════ */}
        <TabsContent value="email-ia" className="space-y-6 mt-4">
          <ConfigSection
            title="Email transaccional"
            description="Configurá el SMTP del tenant para password reset y envíos desde flujos de conversación"
          >
            <div className="space-y-4">
              <Input
                label="SMTP URL"
                placeholder="smtps://usuario:clave@smtp.mailprovider.com:465"
                value={emailSettings.smtpUrl}
                onChange={(e) => setEmailSettings((prev) => ({ ...prev, smtpUrl: e.target.value }))}
              />
              <p className="text-xs text-slate-400">
                Si completás esta URL, tiene prioridad sobre host, puerto y credenciales separadas.
              </p>

              <div className="grid grid-cols-2 gap-4">
                <Input
                  label="SMTP Host"
                  placeholder="smtp.gmail.com"
                  value={emailSettings.smtpHost}
                  onChange={(e) => setEmailSettings((prev) => ({ ...prev, smtpHost: e.target.value }))}
                />
                <Input
                  label="SMTP Port"
                  placeholder="587"
                  value={emailSettings.smtpPort}
                  onChange={(e) => setEmailSettings((prev) => ({ ...prev, smtpPort: e.target.value }))}
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <Input
                  label="SMTP User"
                  placeholder="notificaciones@tu-dominio.com"
                  value={emailSettings.smtpUser}
                  onChange={(e) => setEmailSettings((prev) => ({ ...prev, smtpUser: e.target.value }))}
                />
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-medium text-slate-700">Contraseña SMTP</label>
                  <Input
                    type="password"
                    placeholder={emailPassConfigured ? "•••••••• (ya configurado)" : "Contraseña de aplicación / SMTP"}
                    value={emailSettings.smtpPass}
                    onChange={(e) => setEmailSettings((prev) => ({ ...prev, smtpPass: e.target.value }))}
                    autoComplete="new-password"
                  />
                  {emailPassConfigured && emailSettings.smtpPass === "" && (
                    <p className="text-xs text-emerald-600 flex items-center gap-1">
                      <Check size={12} /> Hay una clave SMTP guardada
                    </p>
                  )}
                </div>
              </div>

              <label className="flex items-center gap-3 rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={emailSettings.smtpSecure}
                  onChange={(e) => setEmailSettings((prev) => ({ ...prev, smtpSecure: e.target.checked }))}
                  className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                />
                Usar SMTP seguro (TLS/SSL)
              </label>

              <div className="grid grid-cols-2 gap-4">
                <Input
                  label="Correo remitente"
                  placeholder="no-reply@tu-dominio.com"
                  value={emailSettings.emailFrom}
                  onChange={(e) => setEmailSettings((prev) => ({ ...prev, emailFrom: e.target.value }))}
                />
                <Input
                  label="URL base del admin"
                  placeholder="https://admin.tu-dominio.com"
                  value={emailSettings.adminBaseUrl}
                  onChange={(e) => setEmailSettings((prev) => ({ ...prev, adminBaseUrl: e.target.value }))}
                />
              </div>

              <p className="text-xs text-slate-400">
                Esta URL se usa para construir el enlace de recuperación de agentes. Si el tenant no define nada, el backend sigue usando variables de entorno.
              </p>

              <div className="flex justify-end">
                <Button onClick={() => saveEmailMutation.mutate()} disabled={saveEmailMutation.isPending}>
                  {emailSaved ? (
                    <><Check size={16} /> Guardado 💙</>
                  ) : saveEmailMutation.isPending ? "Guardando..." : "Guardar configuración de correo"}
                </Button>
              </div>
            </div>
          </ConfigSection>

          {/* LLM / IA */}
          <ConfigSection
            title="Inteligencia Artificial (LLM)"
            description="Configurá el proveedor de IA que usará el chatbot para diagnósticos y rescate de flows"
          >
            <div className="space-y-4">
              {/* Provider */}
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium text-slate-700">Proveedor</label>
                <select
                  value={llm.provider}
                  onChange={(e) => {
                    const p = e.target.value as LlmProvider;
                    const defaultModel = PROVIDER_MODELS[p][0]?.value ?? "";
                    setLlm((prev) => ({ ...prev, provider: p, model: defaultModel, base_url: "" }));
                  }}
                  className="px-3.5 py-2.5 rounded-xl border border-slate-200 bg-white text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500 transition-all"
                >
                  {(Object.keys(PROVIDER_LABELS) as LlmProvider[]).map((p) => (
                    <option key={p} value={p}>{PROVIDER_LABELS[p]}</option>
                  ))}
                </select>
              </div>

              {/* Model */}
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium text-slate-700">Modelo</label>
                {llm.provider === "custom" ? (
                  <Input
                    placeholder="nombre-del-modelo"
                    value={llm.model}
                    onChange={(e) => setLlm((prev) => ({ ...prev, model: e.target.value }))}
                  />
                ) : (
                  <select
                    value={llm.model}
                    onChange={(e) => setLlm((prev) => ({ ...prev, model: e.target.value }))}
                    className="px-3.5 py-2.5 rounded-xl border border-slate-200 bg-white text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500 transition-all"
                  >
                    {PROVIDER_MODELS[llm.provider].map((m) => (
                      <option key={m.value} value={m.value}>{m.label}</option>
                    ))}
                  </select>
                )}
              </div>

              {/* API Key */}
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium text-slate-700">API Key</label>
                <Input
                  type="password"
                  placeholder={llmKeyConfigured ? "API key configurada ✓  (dejá vacío para no cambiar)" : "sk-... / sk-ant-..."}
                  value={llm.api_key}
                  onChange={(e) => setLlm((prev) => ({ ...prev, api_key: e.target.value }))}
                  autoComplete="new-password"
                />
                {llmKeyConfigured && llm.api_key === "" && (
                  <p className="text-xs text-emerald-600 flex items-center gap-1">
                    <Check size={12} /> Hay una API key guardada
                  </p>
                )}
              </div>

              {/* Base URL — only for custom */}
              {llm.provider === "custom" && (
                <Input
                  label="Base URL"
                  placeholder="https://mi-api.com/v1"
                  value={llm.base_url}
                  onChange={(e) => setLlm((prev) => ({ ...prev, base_url: e.target.value }))}
                />
              )}

              <div className="flex justify-end">
                <Button
                  onClick={() => saveLlmMutation.mutate()}
                  disabled={saveLlmMutation.isPending || (!llmKeyConfigured && llm.api_key.trim() === "")}
                >
                  {llmSaved ? (
                    <><Check size={16} /> Guardado 💙</>
                  ) : saveLlmMutation.isPending ? "Guardando..." : "Guardar configuración LLM"}
                </Button>
              </div>
            </div>
          </ConfigSection>
        </TabsContent>

        {/* ═══════════════════════════════════════════════════════════ */}
        {/* ORGANIZACIÓN */}
        {/* ═══════════════════════════════════════════════════════════ */}
        <TabsContent value="organizacion" className="space-y-6 mt-4">
          {/* Catalogo de puestos */}
          <ConfigSection
            title="Catálogo de puestos"
            description="Administrá los puestos disponibles para asignar a agentes (CRUD)."
          >
            <div className="space-y-4">
              <div className="flex gap-2">
                <Input
                  label=""
                  placeholder="Ej: Soporte Nivel 1"
                  value={puestoNombre}
                  onChange={(e) => setPuestoNombre(e.target.value)}
                />
                <Button type="button" onClick={handleCreatePuesto} disabled={createPuestoMutation.isPending}>
                  {createPuestoMutation.isPending ? "Creando..." : "Crear"}
                </Button>
              </div>

              {puestoError && <p className="text-xs text-rose-600">{puestoError}</p>}

              <div className="space-y-2">
                {puestos.length === 0 ? (
                  <p className="text-sm text-slate-500">No hay puestos creados.</p>
                ) : (
                  puestos.map((puesto) => {
                    const isEditing = editingPuestoId === puesto.id;
                    return (
                      <div key={puesto.id} className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 px-3 py-2">
                        {isEditing ? (
                          <Input
                            label=""
                            value={editingPuestoNombre}
                            onChange={(e) => setEditingPuestoNombre(e.target.value)}
                          />
                        ) : (
                          <p className="text-sm text-slate-800">{puesto.nombre}</p>
                        )}

                        <div className="flex items-center gap-2">
                          {isEditing ? (
                            <>
                              <Button type="button" variant="secondary" onClick={saveEditPuesto} disabled={updatePuestoMutation.isPending}>
                                Guardar
                              </Button>
                              <Button
                                type="button"
                                variant="secondary"
                                onClick={() => {
                                  setEditingPuestoId(null);
                                  setEditingPuestoNombre("");
                                }}
                              >
                                <X size={14} />
                              </Button>
                            </>
                          ) : (
                            <>
                              <Button type="button" variant="secondary" onClick={() => startEditPuesto(puesto)}>
                                <Pencil size={14} />
                              </Button>
                              <Button
                                type="button"
                                variant="secondary"
                                onClick={() => deletePuestoMutation.mutate(puesto.id)}
                                disabled={deletePuestoMutation.isPending}
                              >
                                <Trash2 size={14} />
                              </Button>
                            </>
                          )}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </ConfigSection>

          {/* Jerarquía de administradores */}
          <AdminHierarchySection tenantSlug={tenantSlug ?? ""} />

          {/* Solicitudes enterprise */}
          <ConfigSection
            title="Solicitudes enterprise"
            description="Configurá el comportamiento avanzado del módulo de solicitudes por empresa"
          >
            <div className="space-y-3">
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={enterpriseConfigDraft.advancedSearchEnabled}
                  onChange={(e) =>
                    setEnterpriseConfigDraft((prev) => ({
                      ...prev,
                      advancedSearchEnabled: e.target.checked,
                    }))
                  }
                />
                Búsqueda avanzada
              </label>
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={enterpriseConfigDraft.slaEnabled}
                  onChange={(e) =>
                    setEnterpriseConfigDraft((prev) => ({
                      ...prev,
                      slaEnabled: e.target.checked,
                    }))
                  }
                />
                SLA habilitado
              </label>
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={enterpriseConfigDraft.manualEscalationEnabled}
                  onChange={(e) =>
                    setEnterpriseConfigDraft((prev) => ({
                      ...prev,
                      manualEscalationEnabled: e.target.checked,
                    }))
                  }
                />
                Escalación manual
              </label>
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={enterpriseConfigDraft.assignmentRulesEnabled}
                  onChange={(e) =>
                    setEnterpriseConfigDraft((prev) => ({
                      ...prev,
                      assignmentRulesEnabled: e.target.checked,
                    }))
                  }
                />
                Reglas de asignación
              </label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-xs text-slate-500 uppercase tracking-wide">
                    Umbral warning SLA (min)
                  </label>
                  <input
                    type="number"
                    min={5}
                    max={1440}
                    value={enterpriseConfigDraft.warningThresholdMinutes}
                    onChange={(e) =>
                      setEnterpriseConfigDraft((prev) => ({
                        ...prev,
                        warningThresholdMinutes: Number(e.target.value || 60),
                      }))
                    }
                    className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs text-slate-500 uppercase tracking-wide">
                    Intervalo auto-escalación (min)
                  </label>
                  <input
                    type="number"
                    min={5}
                    max={1440}
                    value={enterpriseConfigDraft.escalationIntervalMinutes}
                    onChange={(e) =>
                      setEnterpriseConfigDraft((prev) => ({
                        ...prev,
                        escalationIntervalMinutes: Number(e.target.value || 30),
                      }))
                    }
                    className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm"
                  />
                </div>
              </div>
              <div className="flex justify-end pt-2">
                <Button
                  onClick={() =>
                    saveSolicitudesEnterpriseConfigMutation.mutate(
                      enterpriseConfigDraft
                    )
                  }
                  disabled={saveSolicitudesEnterpriseConfigMutation.isPending}
                >
                  {saveSolicitudesEnterpriseConfigMutation.isPending
                    ? "Guardando..."
                    : "Guardar configuración"}
                </Button>
              </div>
            </div>
          </ConfigSection>
        </TabsContent>

        {/* ═══════════════════════════════════════════════════════════ */}
        {/* MÓDULOS & SEGURIDAD */}
        {/* ═══════════════════════════════════════════════════════════ */}
        <TabsContent value="modulos" className="space-y-6 mt-4">
          {/* Módulos opcionales */}
          <ConfigSection
            title="Módulos"
            description="Activá o desactivá funcionalidades del sistema"
          >
            <div className="flex items-center justify-between py-1">
              <div className="flex items-center gap-3">
                <CalendarDays size={20} className="text-blue-500" />
                <div>
                  <p className="text-sm font-medium text-slate-800">Agenda</p>
                  <p className="text-xs text-slate-400">
                    Calendario de eventos semanales con asignación de agentes
                  </p>
                </div>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={agendaEnabled}
                disabled={agendaToggleMutation.isPending}
                onClick={() => agendaToggleMutation.mutate(!agendaEnabled)}
                className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-blue-500/30 disabled:opacity-50 ${
                  agendaEnabled ? "bg-blue-500" : "bg-slate-200"
                }`}
              >
                <span
                  className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ${
                    agendaEnabled ? "translate-x-5" : "translate-x-0"
                  }`}
                />
              </button>
            </div>
          </ConfigSection>

          {/* Política de Bloqueo de Cuenta */}
          <ConfigSection
            title="Seguridad: Política de Bloqueo de Cuenta"
            description="Configurá los intentos máximos de login fallidos y la duración del bloqueo temporal"
          >
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <Input
                  label="Máximo de intentos fallidos"
                  type="number"
                  min="1"
                  max="20"
                  value={lockoutPolicy.maxAttempts}
                  onChange={(e) => {
                    const val = Math.max(1, Math.min(20, parseInt(e.target.value) || 5));
                    setLockoutPolicy((p) => ({ ...p, maxAttempts: val }));
                  }}
                />
                <Input
                  label="Duración del bloqueo (minutos)"
                  type="number"
                  min="1"
                  max="1440"
                  value={lockoutPolicy.lockoutMinutes}
                  onChange={(e) => {
                    const val = Math.max(1, Math.min(1440, parseInt(e.target.value) || 15));
                    setLockoutPolicy((p) => ({ ...p, lockoutMinutes: val }));
                  }}
                />
              </div>
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
                <p className="text-xs text-blue-900">
                  💡 Después de {lockoutPolicy.maxAttempts} intentos fallidos, la cuenta se bloqueará por {lockoutPolicy.lockoutMinutes} minuto{lockoutPolicy.lockoutMinutes !== 1 ? 's' : ''}.
                </p>
              </div>
              <div className="flex justify-end">
                <Button 
                  onClick={() => saveLockoutPolicyMutation.mutate()} 
                  disabled={saveLockoutPolicyMutation.isPending}
                >
                  {lockoutSaved ? (
                    <>
                      <Check size={16} />
                      Guardado 💙
                    </>
                  ) : saveLockoutPolicyMutation.isPending ? "Guardando..." : "Guardar política"}
                </Button>
              </div>
            </div>
          </ConfigSection>
        </TabsContent>

        {/* ═══════════════════════════════════════════════════════════ */}
        {/* BRANDING */}
        {/* ═══════════════════════════════════════════════════════════ */}
        <TabsContent value="branding" className="space-y-6 mt-4">
          {/* Branding */}
          <ConfigSection
            title="Branding"
            description="Información visual de tu organización"
          >
            <div className="space-y-4">
              <Input label="Nombre de la organización" placeholder="Clínica Esperanza" />
              <Input label="Color principal (hex)" placeholder="#2563eb" />
            </div>
          </ConfigSection>
        </TabsContent>
      </Tabs>
    </div>
  );
}
