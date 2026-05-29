"use client";

import { adminUsersApi, agentePuestosApi, agentesApi, agendaApi, apiClient, configApi, solicitudesApi, tenantApi } from "@/lib/api";
import { useAuthStore } from "@/store/auth";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { CalendarDays, Check, Pencil, Trash2, X, Settings, MessageSquare, Lock, Briefcase, Palette, RefreshCw, Upload, KeyRound } from "lucide-react";
import { useTranslations } from "@/lib/i18n/client";

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

interface AgendaAgentItem {
  id: number;
  nombre: string;
  email?: string | null;
  estado?: string | null;
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

type AudioTranscriptionProvider = "openai" | "custom";

interface AudioTranscriptionTenantConfig {
  enabled: boolean;
  provider: AudioTranscriptionProvider;
  useForBotInput: boolean;
  model: string;
  languageHint: string;
  timeoutMs: number;
}

type AgendaDayKey = "sun" | "mon" | "tue" | "wed" | "thu" | "fri" | "sat";
type AgendaTimeRange = [string, string];
type AgendaWorkingHours = Record<AgendaDayKey, AgendaTimeRange[]>;

const AGENDA_DAY_ORDER: AgendaDayKey[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const AGENDA_HOUR_OPTIONS = [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18];

const EMPTY_AGENDA_WORKING_HOURS: AgendaWorkingHours = {
  sun: [],
  mon: [],
  tue: [],
  wed: [],
  thu: [],
  fri: [],
  sat: [],
};

const DEFAULT_AGENDA_WORKING_HOURS: AgendaWorkingHours = {
  ...EMPTY_AGENDA_WORKING_HOURS,
  mon: [["08:00", "10:00"], ["14:00", "16:00"]],
  tue: [["08:00", "10:00"], ["14:00", "16:00"]],
};

function normalizeAgendaWorkingHours(rawValue: unknown): AgendaWorkingHours {
  const source = rawValue && typeof rawValue === "object" ? (rawValue as Record<string, unknown>) : {};
  const result: AgendaWorkingHours = {
    ...EMPTY_AGENDA_WORKING_HOURS,
  };

  const dayKeys: AgendaDayKey[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  for (const day of dayKeys) {
    const dayValue = source[day];
    if (!Array.isArray(dayValue)) continue;

    if (dayValue.length >= 2 && typeof dayValue[0] === "string" && typeof dayValue[1] === "string") {
      result[day] = [[dayValue[0], dayValue[1]]];
      continue;
    }

    const ranges: AgendaTimeRange[] = [];
    for (const item of dayValue) {
      if (!Array.isArray(item) || item.length < 2) continue;
      ranges.push([String(item[0]), String(item[1])]);
    }
    result[day] = ranges;
  }

  return result;
}

function hourToLabel(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
}

function labelToHour(label: string): number | null {
  const match = String(label || "").trim().match(/^(\d{2}):(\d{2})$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || minute !== 0) return null;
  if (hour < 0 || hour > 23) return null;
  return hour;
}

function rangesToSelectedHours(ranges: AgendaTimeRange[]): number[] {
  const selected = new Set<number>();
  for (const [start, end] of ranges) {
    const s = labelToHour(start);
    const e = labelToHour(end);
    if (s === null || e === null || e <= s) continue;
    for (let hour = s; hour < e; hour += 1) selected.add(hour);
  }
  return [...selected].sort((a, b) => a - b);
}

function selectedHoursToRanges(selectedHours: number[]): AgendaTimeRange[] {
  const hours = [...new Set(selectedHours)]
    .filter((hour) => Number.isInteger(hour) && hour >= 0 && hour <= 23)
    .sort((a, b) => a - b);

  if (hours.length === 0) return [];

  const ranges: AgendaTimeRange[] = [];
  let start = hours[0];
  let prev = hours[0];

  for (let i = 1; i < hours.length; i += 1) {
    const current = hours[i];
    if (current === prev + 1) {
      prev = current;
      continue;
    }
    ranges.push([hourToLabel(start), hourToLabel(prev + 1)]);
    start = current;
    prev = current;
  }

  ranges.push([hourToLabel(start), hourToLabel(prev + 1)]);
  return ranges;
}

function normalizeHexColor(value: string, fallback = "#2563eb"): string {
  const raw = String(value || "").trim();
  return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(raw) ? raw : fallback;
}

const DEFAULT_AUDIO_TRANSCRIPTION_CONFIG: AudioTranscriptionTenantConfig = {
  enabled: false,
  provider: "openai",
  useForBotInput: false,
  model: "gpt-4o-mini-transcribe",
  languageHint: "",
  timeoutMs: 30000,
};

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
  const t = useTranslations("settings");
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
      title={t("hierarchy.title")}
      description={t("hierarchy.description")}
    >
      <div className="space-y-3">
        {adminUsers.length === 0 ? (
          <p className="text-sm text-slate-500">{t("hierarchy.empty")}</p>
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
                  <span className="text-xs text-slate-400">{t("hierarchy.bossLabel")}</span>
                  <select
                    value={user.jefeId ?? ""}
                    onChange={(e) => {
                      const val = e.target.value === "" ? null : Number(e.target.value);
                      setJefeMutation.mutate({ id: user.id, jefeId: val });
                    }}
                    disabled={setJefeMutation.isPending}
                    className="text-sm border border-slate-200 rounded-lg px-2 py-1 bg-white focus:outline-none focus:ring-2 focus:ring-rose-500/30"
                  >
                    <option value="">{t("hierarchy.noBoss")}</option>
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
  const t = useTranslations("settings");
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
  const [waAppSecret, setWaAppSecret] = useState("");
  const [waAppSecretConfigured, setWaAppSecretConfigured] = useState(false);
  const [waSaved, setWaSaved] = useState(false);
  const [flowEndpointPublicKey, setFlowEndpointPublicKey] = useState("");
  const [flowEndpointKeySaved, setFlowEndpointKeySaved] = useState(false);
  const [isGeneratingKeys, setIsGeneratingKeys] = useState(false);
  const [audioTranscriptionConfig, setAudioTranscriptionConfig] = useState<AudioTranscriptionTenantConfig>(
    DEFAULT_AUDIO_TRANSCRIPTION_CONFIG
  );
  const [audioTranscriptionSaved, setAudioTranscriptionSaved] = useState(false);
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

  // Logo upload
  const [logoPreview, setLogoPreview] = useState<string | null>(null);
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [logoSaved, setLogoSaved] = useState(false);
  const [brandingOrgName, setBrandingOrgName] = useState("");
  const [brandingPrimaryColor, setBrandingPrimaryColor] = useState("#2563eb");
  const [brandingSaved, setBrandingSaved] = useState(false);
  const uploadLogoMutation = useMutation({
    mutationFn: (file: File) => tenantApi.uploadLogo(tenantSlug!, file),
    onSuccess: () => {
      setLogoSaved(true);
      setLogoFile(null);
      setTimeout(() => setLogoSaved(false), 2500);
    },
  });

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

  const { data: waAppSecretData } = useQuery({
    queryKey: ["config", tenantSlug, "wa_app_secret"],
    queryFn: () =>
      configApi.get(tenantSlug, "wa_app_secret").then((r) => {
        const v = r?.data?.valor;
        setWaAppSecret("");
        setWaAppSecretConfigured(v === "__configured__");
        return r?.data;
      }),
    enabled: !!tenantSlug,
  });
  void waAppSecretData;

  const { data: flowEndpointPublicKeyData } = useQuery({
    queryKey: ["config", tenantSlug, "flow_endpoint_public_key"],
    queryFn: () =>
      configApi.get(tenantSlug!, "flow_endpoint_public_key").then((r) => {
        const v = r?.data?.valor;
        if (typeof v === "string") {
          setFlowEndpointPublicKey(v);
        } else if (v && typeof v === "object") {
          setFlowEndpointPublicKey(String((v as { publicKey?: string }).publicKey ?? ""));
        } else {
          setFlowEndpointPublicKey("");
        }
        return r?.data;
      }),
    enabled: !!tenantSlug,
  });
  void flowEndpointPublicKeyData;

  const { data: audioTranscriptionConfigData } = useQuery({
    queryKey: ["config", tenantSlug, "wa_audio_transcription"],
    queryFn: () =>
      configApi.get(tenantSlug!, "wa_audio_transcription").then((r) => {
        const raw = r?.data?.valor;
        const cfg = (raw && typeof raw === "object") ? raw : {};
        setAudioTranscriptionConfig({
          enabled: Boolean(cfg.enabled),
          provider: (cfg.provider === "custom" ? "custom" : "openai") as AudioTranscriptionProvider,
          useForBotInput: Boolean(cfg.useForBotInput),
          model: String(cfg.model ?? DEFAULT_AUDIO_TRANSCRIPTION_CONFIG.model),
          languageHint: String(cfg.languageHint ?? ""),
          timeoutMs: Number(cfg.timeoutMs ?? DEFAULT_AUDIO_TRANSCRIPTION_CONFIG.timeoutMs) || DEFAULT_AUDIO_TRANSCRIPTION_CONFIG.timeoutMs,
        });
        return r?.data;
      }),
    enabled: !!tenantSlug,
  });
  void audioTranscriptionConfigData;

  async function generateFlowKeyPair() {
    if (!tenantSlug) return;
    setIsGeneratingKeys(true);
    try {
      // Step 1: Generate keys in browser
      const keyPair = await window.crypto.subtle.generateKey(
        { name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
        true,
        ["encrypt", "decrypt"]
      );
      const pubBuf = await window.crypto.subtle.exportKey("spki", keyPair.publicKey);
      const privBuf = await window.crypto.subtle.exportKey("pkcs8", keyPair.privateKey);
      const toBase64 = (buf: ArrayBuffer) =>
        btoa(String.fromCharCode(...new Uint8Array(buf)))
          .match(/.{1,64}/g)!.join("\n");
      setFlowEndpointPublicKey(
        `-----BEGIN PUBLIC KEY-----\n${toBase64(pubBuf)}\n-----END PUBLIC KEY-----`
      );
      const privateKeyPem = `-----BEGIN PRIVATE KEY-----\n${toBase64(privBuf)}\n-----END PRIVATE KEY-----`;

      // Step 2: Store keys in database via API
      await Promise.all([
        configApi.set(tenantSlug, "flow_endpoint_public_key", {
          publicKey: `-----BEGIN PUBLIC KEY-----\n${toBase64(pubBuf)}\n-----END PUBLIC KEY-----`,
        }),
        configApi.set(tenantSlug, "flow_endpoint_private_key", {
          privateKey: privateKeyPem,
        }),
      ]);

      // Step 3: Register public key with Meta (automatic after successful save)
      try {
        const registerResp = await apiClient.post(
          `/admin/tenants/${tenantSlug}/flow-keys/register`,
          {}
        );
        if (registerResp.data?.ok) {
          setFlowEndpointKeySaved(true);
          setTimeout(() => setFlowEndpointKeySaved(false), 3000);
        }
      } catch (regErr: any) {
        // Registration may fail if WhatsApp credentials not configured
        // Still mark keys as saved locally even if registration fails
        setFlowEndpointKeySaved(true);
        setTimeout(() => setFlowEndpointKeySaved(false), 3000);
      }

      qc.invalidateQueries({ queryKey: ["config", tenantSlug, "flow_endpoint_public_key"] });
      qc.invalidateQueries({ queryKey: ["config", tenantSlug, "flow_endpoint_private_key"] });
    } finally {
      setIsGeneratingKeys(false);
    }
  }

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
    mutationFn: async () => {
      await configApi.set(tenantSlug, "wa_credentials", {
        phoneNumberId: waCreds.phoneNumberId,
        accessToken: waCreds.accessToken.trim() !== "" ? waCreds.accessToken.trim() : "__configured__",
      });
      await configApi.set(
        tenantSlug,
        "wa_app_secret",
        waAppSecret.trim() !== "" ? waAppSecret.trim() : "__configured__"
      );
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["config", tenantSlug, "wa_credentials"] });
      qc.invalidateQueries({ queryKey: ["config", tenantSlug, "wa_app_secret"] });
      setWaTokenConfigured(true);
      setWaAppSecretConfigured(true);
      setWaCreds((prev) => ({ ...prev, accessToken: "" }));
      setWaAppSecret("");
      setWaSaved(true);
      setTimeout(() => setWaSaved(false), 3000);
    },
  });

  const saveFlowEndpointKeyMutation = useMutation({
    mutationFn: () =>
      configApi.set(tenantSlug!, "flow_endpoint_public_key", {
        publicKey: flowEndpointPublicKey.trim(),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["config", tenantSlug, "flow_endpoint_public_key"] });
      setFlowEndpointKeySaved(true);
      setTimeout(() => setFlowEndpointKeySaved(false), 3000);
    },
  });

  const saveAudioTranscriptionMutation = useMutation({
    mutationFn: () =>
      configApi.set(tenantSlug!, "wa_audio_transcription", {
        enabled: audioTranscriptionConfig.enabled,
        provider: audioTranscriptionConfig.provider,
        useForBotInput: audioTranscriptionConfig.useForBotInput,
        model: audioTranscriptionConfig.model.trim() || DEFAULT_AUDIO_TRANSCRIPTION_CONFIG.model,
        languageHint: audioTranscriptionConfig.languageHint.trim() || null,
        timeoutMs: Math.min(Math.max(Number(audioTranscriptionConfig.timeoutMs) || 30000, 1000), 120000),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["config", tenantSlug, "wa_audio_transcription"] });
      setAudioTranscriptionSaved(true);
      setTimeout(() => setAudioTranscriptionSaved(false), 3000);
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
    onError: () => setPuestoError(t("puestos.errorCreate")),
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
    onError: () => setPuestoError(t("puestos.errorUpdate")),
  });

  const deletePuestoMutation = useMutation({
    mutationFn: (id: number) => agentePuestosApi.remove(tenantSlug!, id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["agente-puestos", tenantSlug] });
      setPuestoError("");
    },
    onError: () => setPuestoError(t("puestos.errorDelete")),
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
      setPuestoError(t("puestos.errorEmpty"));
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
      setPuestoError(t("puestos.errorNameEmpty"));
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
  const [agendaAppointmentColor, setAgendaAppointmentColor] = useState("#0EA5E9");
  const [agendaAgentColors, setAgendaAgentColors] = useState<Record<string, string>>({});
  const [agendaTimeZone, setAgendaTimeZone] = useState("America/Costa_Rica");
  const [agendaWorkingHours, setAgendaWorkingHours] = useState<AgendaWorkingHours>(DEFAULT_AGENDA_WORKING_HOURS);
  const [agendaAppearanceSaved, setAgendaAppearanceSaved] = useState(false);

  const { data: agendaAgentsData } = useQuery({
    queryKey: ["agentes", tenantSlug],
    queryFn: () => agentesApi.list(tenantSlug!).then((r) => r.data),
    enabled: !!tenantSlug,
  });
  const agendaAgents: AgendaAgentItem[] = agendaAgentsData?.data ?? agendaAgentsData ?? [];

  const { data: brandingSettingsData } = useQuery({
    queryKey: ["config", tenantSlug, "branding_settings"],
    queryFn: () =>
      configApi.get(tenantSlug!, "branding_settings").then((r) => {
        const v = r?.data?.valor;
        const orgName = typeof v?.orgName === "string" ? v.orgName : "";
        const primaryColor = normalizeHexColor(v?.primaryColor, "#2563eb");
        setBrandingOrgName(orgName);
        setBrandingPrimaryColor(primaryColor);
        return r?.data;
      }),
    enabled: !!tenantSlug,
  });
  void brandingSettingsData;

  const { data: agendaSettingsData } = useQuery({
    queryKey: ["config", tenantSlug, "agenda_settings"],
    queryFn: () =>
      configApi.get(tenantSlug!, "agenda_settings").then((r) => {
        const v = r?.data?.valor;
        const color = typeof v?.appointmentColor === "string" ? v.appointmentColor.trim() : "";
        if (/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(color)) {
          setAgendaAppointmentColor(color);
        } else {
          setAgendaAppointmentColor("#0EA5E9");
        }

        const rawAgentColors = v?.agentColors && typeof v.agentColors === "object" ? v.agentColors : {};
        const sanitizedAgentColors: Record<string, string> = {};
        for (const [agenteId, agentColor] of Object.entries(rawAgentColors)) {
          const normalized = String(agentColor ?? "").trim();
          if (/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(normalized)) {
            sanitizedAgentColors[String(agenteId)] = normalized;
          }
        }
        setAgendaAgentColors(sanitizedAgentColors);

        const tz = typeof v?.timeZone === "string" ? v.timeZone.trim() : "";
        setAgendaTimeZone(tz || "America/Costa_Rica");

        const workingHours = normalizeAgendaWorkingHours(v?.workingHours || v?.working_hours);
        const hasSchedule = Object.values(workingHours).some((ranges) => ranges.length > 0);
        setAgendaWorkingHours(hasSchedule ? workingHours : DEFAULT_AGENDA_WORKING_HOURS);
        return r?.data;
      }),
    enabled: !!tenantSlug,
  });
  void agendaSettingsData;

  const agendaToggleMutation = useMutation({
    mutationFn: (enabled: boolean) => agendaApi.feature.set(tenantSlug!, enabled),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["config", tenantSlug, "agenda_feature"] });
    },
  });

  const saveAgendaAppearanceMutation = useMutation({
    mutationFn: () =>
      configApi.set(tenantSlug!, "agenda_settings", {
        appointmentColor: agendaAppointmentColor,
        agentColors: agendaAgentColors,
        timeZone: agendaTimeZone,
        workingHours: agendaWorkingHours,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["config", tenantSlug, "agenda_settings"] });
      setAgendaAppearanceSaved(true);
      setTimeout(() => setAgendaAppearanceSaved(false), 3000);
    },
  });

  const saveBrandingMutation = useMutation({
    mutationFn: () =>
      configApi.set(tenantSlug!, "branding_settings", {
        orgName: brandingOrgName.trim(),
        primaryColor: normalizeHexColor(brandingPrimaryColor, "#2563eb"),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["config", tenantSlug, "branding_settings"] });
      setBrandingSaved(true);
      setTimeout(() => setBrandingSaved(false), 3000);
    },
  });

  const [refreshingTab, setRefreshingTab] = useState<string | null>(null);

  function setAgendaDayEnabled(day: AgendaDayKey, enabled: boolean) {
    setAgendaWorkingHours((prev) => {
      if (!enabled) {
        return { ...prev, [day]: [] };
      }

      const currentHours = rangesToSelectedHours(prev[day] || []);
      const nextHours = currentHours.length > 0 ? currentHours : [8, 9, 14, 15];
      return { ...prev, [day]: selectedHoursToRanges(nextHours) };
    });
  }

  function toggleAgendaHour(day: AgendaDayKey, hour: number) {
    setAgendaWorkingHours((prev) => {
      const selected = rangesToSelectedHours(prev[day] || []);
      const exists = selected.includes(hour);
      const nextSelected = exists ? selected.filter((h) => h !== hour) : [...selected, hour];
      return { ...prev, [day]: selectedHoursToRanges(nextSelected) };
    });
  }

  function setAgendaAgentColor(agenteId: number, color: string) {
    setAgendaAgentColors((prev) => ({
      ...prev,
      [String(agenteId)]: color,
    }));
  }

  async function refreshTab(
    tab: "comunicacion" | "email-ia" | "organizacion" | "modulos" | "branding"
  ) {
    if (!tenantSlug) return;
    setRefreshingTab(tab);
    try {
      if (tab === "comunicacion") {
        await Promise.all([
          qc.invalidateQueries({ queryKey: ["config", tenantSlug, "horarios"] }),
          qc.invalidateQueries({ queryKey: ["config", tenantSlug, "flow_endpoint_public_key"] }),
          qc.invalidateQueries({ queryKey: ["config", tenantSlug, "wa_credentials"] }),
          qc.invalidateQueries({ queryKey: ["config", tenantSlug, "wa_app_secret"] }),
          qc.invalidateQueries({ queryKey: ["config", tenantSlug, "wa_audio_transcription"] }),
        ]);
        return;
      }

      if (tab === "email-ia") {
        await Promise.all([
          qc.invalidateQueries({ queryKey: ["config", tenantSlug, "email_settings"] }),
          qc.invalidateQueries({ queryKey: ["config", tenantSlug, "llm_config"] }),
        ]);
        return;
      }

      if (tab === "organizacion") {
        await Promise.all([
          qc.invalidateQueries({ queryKey: ["agente-puestos", tenantSlug] }),
          qc.invalidateQueries({ queryKey: ["admin-users", tenantSlug] }),
          qc.invalidateQueries({ queryKey: ["solicitudes-config", tenantSlug] }),
        ]);
        return;
      }

      if (tab === "modulos") {
        await Promise.all([
          qc.invalidateQueries({ queryKey: ["config", tenantSlug, "agenda_feature"] }),
          qc.invalidateQueries({ queryKey: ["config", tenantSlug, "agenda_settings"] }),
          qc.invalidateQueries({ queryKey: ["lockout-policy", tenantSlug] }),
        ]);
        return;
      }

      if (tab === "branding") {
        await Promise.all([
          qc.invalidateQueries({ queryKey: ["config", tenantSlug, "branding_settings"] }),
        ]);
        return;
      }

      await qc.invalidateQueries({ queryKey: ["config", tenantSlug] });
    } finally {
      setRefreshingTab(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between mb-2">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">{t("pageTitle")}</h1>
          <p className="text-sm text-slate-500">{t("subtitle")}</p>
        </div>
      </div>

      <Tabs defaultValue="comunicacion" className="w-full">
        <TabsList className="w-full justify-start overflow-x-auto bg-slate-50 border-b border-slate-200">
          <TabsTrigger value="comunicacion" className="flex items-center gap-2">
            <MessageSquare size={16} />
            {t("tabs.comunicacion")}
          </TabsTrigger>
          <TabsTrigger value="email-ia" className="flex items-center gap-2">
            <Settings size={16} />
            {t("tabs.emailIa")}
          </TabsTrigger>
          <TabsTrigger value="organizacion" className="flex items-center gap-2">
            <Briefcase size={16} />
            {t("tabs.organizacion")}
          </TabsTrigger>
          <TabsTrigger value="modulos" className="flex items-center gap-2">
            <Lock size={16} />
            {t("tabs.modulos")}
          </TabsTrigger>
          <TabsTrigger value="branding" className="flex items-center gap-2">
            <Palette size={16} />
            {t("tabs.branding")}
          </TabsTrigger>
        </TabsList>

        {/* ═══════════════════════════════════════════════════════════ */}
        {/* COMUNICACIÓN */}
        {/* ═══════════════════════════════════════════════════════════ */}
        <TabsContent value="comunicacion" className="space-y-6 mt-4">
          <div className="flex justify-end">
            <Button
              type="button"
              variant="secondary"
              onClick={() => refreshTab("comunicacion")}
              disabled={refreshingTab === "comunicacion"}
            >
              <RefreshCw size={14} className={refreshingTab === "comunicacion" ? "animate-spin" : ""} />
              {refreshingTab === "comunicacion" ? t("refreshing") : t("refresh")}
            </Button>
          </div>

          {/* Horarios */}
          <ConfigSection
            title={t("horarios.title")}
            description={t("horarios.description")}
          >
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <Input
                  label={t("horarios.openTime")}
                  type="time"
                  value={horarios.inicio}
                  onChange={(e) =>
                    setHorarios((h) => ({ ...h, inicio: e.target.value }))
                  }
                />
                <Input
                  label={t("horarios.closeTime")}
                  type="time"
                  value={horarios.fin}
                  onChange={(e) =>
                    setHorarios((h) => ({ ...h, fin: e.target.value }))
                  }
                />
              </div>
              <div>
                <p className="text-sm font-medium text-slate-700 mb-2">{t("horarios.workDays")}</p>
                <div className="flex gap-2 flex-wrap">
                  {[
                    { labelKey: "sun", value: 0 },
                    { labelKey: "mon", value: 1 },
                    { labelKey: "tue", value: 2 },
                    { labelKey: "wed", value: 3 },
                    { labelKey: "thu", value: 4 },
                    { labelKey: "fri", value: 5 },
                    { labelKey: "sat", value: 6 },
                  ].map(({ labelKey, value }) => {
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
                        {t(`horarios.days.${labelKey}`)}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </ConfigSection>

          {/* Mensajes */}
          <ConfigSection
            title={t("bienvenida.title")}
            description={t("bienvenida.description")}
          >
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium text-slate-700">
                {t("bienvenida.label")}
              </label>
              <textarea
                value={mensajeBienvenida}
                onChange={(e) => setMensajeBienvenida(e.target.value)}
                rows={3}
                className="px-3.5 py-2.5 rounded-xl border border-slate-200 bg-white text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500 resize-none transition-all"
              />
              <p className="text-xs text-slate-400">
                {t("bienvenida.tip")}
              </p>
            </div>
          </ConfigSection>

          <ConfigSection
            title={t("setupGuide.title")}
            description={t("setupGuide.description")}
          >
            <div className="space-y-3">
              <div className="rounded-xl border border-blue-200 bg-blue-50 px-3.5 py-3 text-sm text-blue-900">
                <p className="font-semibold">{t("setupGuide.beforeStartTitle")}</p>
                <p className="mt-1 text-blue-800">{t("setupGuide.beforeStartText")}</p>
              </div>

              <div className="rounded-xl border border-slate-200 bg-white px-3.5 py-3">
                <p className="text-sm font-semibold text-slate-900">1. {t("setupGuide.step1.title")}</p>
                <p className="mt-1 text-sm text-slate-600">{t("setupGuide.step1.where")}</p>
                <p className="mt-1 text-xs text-slate-500">{t("setupGuide.step1.hint")}</p>
              </div>

              <div className="rounded-xl border border-slate-200 bg-white px-3.5 py-3">
                <p className="text-sm font-semibold text-slate-900">2. {t("setupGuide.step2.title")}</p>
                <p className="mt-1 text-sm text-slate-600">{t("setupGuide.step2.where")}</p>
                <p className="mt-1 text-xs text-slate-500">{t("setupGuide.step2.hint")}</p>
              </div>

              <div className="rounded-xl border border-slate-200 bg-white px-3.5 py-3">
                <p className="text-sm font-semibold text-slate-900">3. {t("setupGuide.step3.title")}</p>
                <p className="mt-1 text-sm text-slate-600">{t("setupGuide.step3.where")}</p>
                <p className="mt-1 text-xs text-slate-500">{t("setupGuide.step3.hint")}</p>
              </div>

              <div className="rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-3">
                <p className="text-sm font-semibold text-amber-900">4. {t("setupGuide.step4.title")}</p>
                <p className="mt-1 text-sm text-amber-800">{t("setupGuide.step4.where")}</p>
                <p className="mt-1 text-xs text-amber-700">{t("setupGuide.step4.hint")}</p>
              </div>

              <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-3.5 py-3">
                <p className="text-sm font-semibold text-emerald-900">5. {t("setupGuide.step5.title")}</p>
                <p className="mt-1 text-sm text-emerald-800">{t("setupGuide.step5.where")}</p>
                <p className="mt-1 text-xs text-emerald-700">{t("setupGuide.step5.hint")}</p>
                <p className="mt-2 rounded-md border border-emerald-200 bg-white px-2.5 py-2 font-mono text-xs text-emerald-900 break-all">
                  {t("setupGuide.step5.endpoint")}
                </p>
              </div>
            </div>
          </ConfigSection>

          {/* Flow endpoint public key */}
          <ConfigSection
            title={t("flowKey.title")}
            description={t("flowKey.description")}
          >
            <div className="space-y-4">
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between">
                  <label className="text-sm font-medium text-slate-700">{t("flowKey.label")}</label>
                  <button
                    type="button"
                    onClick={generateFlowKeyPair}
                    disabled={isGeneratingKeys}
                    className="inline-flex items-center gap-1.5 text-xs font-medium text-blue-600 hover:text-blue-800 disabled:opacity-50 transition-colors"
                  >
                    <KeyRound size={13} />
                    {isGeneratingKeys ? t("flowKey.generating") : t("flowKey.generateButton")}
                  </button>
                </div>
                <textarea
                  rows={8}
                  value={flowEndpointPublicKey}
                  onChange={(e) => setFlowEndpointPublicKey(e.target.value)}
                  placeholder={t("flowKey.placeholder")}
                  className="px-3.5 py-2.5 rounded-xl border border-slate-200 bg-white text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500 resize-y transition-all font-mono"
                />
                <p className="text-xs text-slate-400">{t("flowKey.hint")}</p>
              </div>

              <div className="flex justify-end">
                <Button
                  onClick={() => saveFlowEndpointKeyMutation.mutate()}
                  disabled={saveFlowEndpointKeyMutation.isPending || !flowEndpointPublicKey.trim()}
                >
                  {flowEndpointKeySaved ? (
                    <><Check size={16} /> {t("flowKey.saved")}</>
                  ) : saveFlowEndpointKeyMutation.isPending ? t("flowKey.saving") : t("flowKey.saveButton")}
                </Button>
              </div>
            </div>
          </ConfigSection>

          {/* WhatsApp Business */}
          <ConfigSection
            title={t("whatsapp.title")}
            description={t("whatsapp.description")}
          >
            <div className="space-y-4">
              <Input
                label={t("whatsapp.phoneLabel")}
                placeholder="123456789012345"
                value={waCreds.phoneNumberId}
                onChange={(e) => setWaCreds((c) => ({ ...c, phoneNumberId: e.target.value }))}
              />
              <Input
                label={t("whatsapp.tokenLabel")}
                placeholder={waTokenConfigured ? t("whatsapp.tokenConfigured") : "EAAGm..."}
                value={waCreds.accessToken}
                onChange={(e) => setWaCreds((c) => ({ ...c, accessToken: e.target.value }))}
                type="password"
              />
              <Input
                label={t("whatsapp.appSecretLabel")}
                placeholder={waAppSecretConfigured ? t("whatsapp.appSecretConfigured") : "ab12cd34..."}
                value={waAppSecret}
                onChange={(e) => setWaAppSecret(e.target.value)}
                type="password"
              />
              <p className="text-xs text-slate-400">
                {t("whatsapp.permissionNote")}
              </p>
              <div className="flex justify-end">
                <Button onClick={() => saveWaMutation.mutate()} disabled={saveWaMutation.isPending}>
                  {waSaved ? (
                    <><Check size={16} /> {t("whatsapp.saved")}</>
                  ) : saveWaMutation.isPending ? t("whatsapp.saving") : t("whatsapp.saveButton")}
                </Button>
              </div>
            </div>
          </ConfigSection>

          <ConfigSection
            title={t("audioTranscription.title")}
            description={t("audioTranscription.description")}
          >
            <div className="space-y-4">
              <label className="flex items-center justify-between rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm text-slate-700">
                <span>{t("audioTranscription.enabled")}</span>
                <input
                  type="checkbox"
                  checked={audioTranscriptionConfig.enabled}
                  onChange={(e) =>
                    setAudioTranscriptionConfig((prev) => ({ ...prev, enabled: e.target.checked }))
                  }
                  className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                />
              </label>

              <label className="flex items-center justify-between rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm text-slate-700">
                <span>{t("audioTranscription.useForBotInput")}</span>
                <input
                  type="checkbox"
                  checked={audioTranscriptionConfig.useForBotInput}
                  onChange={(e) =>
                    setAudioTranscriptionConfig((prev) => ({ ...prev, useForBotInput: e.target.checked }))
                  }
                  className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                />
              </label>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-medium text-slate-700">{t("audioTranscription.provider")}</label>
                  <select
                    value={audioTranscriptionConfig.provider}
                    onChange={(e) =>
                      setAudioTranscriptionConfig((prev) => ({
                        ...prev,
                        provider: (e.target.value === "custom" ? "custom" : "openai") as AudioTranscriptionProvider,
                      }))
                    }
                    className="px-3.5 py-2.5 rounded-xl border border-slate-200 bg-white text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500 transition-all"
                  >
                    <option value="openai">OpenAI</option>
                    <option value="custom">Custom</option>
                  </select>
                </div>
                <Input
                  label={t("audioTranscription.model")}
                  value={audioTranscriptionConfig.model}
                  onChange={(e) =>
                    setAudioTranscriptionConfig((prev) => ({ ...prev, model: e.target.value }))
                  }
                  placeholder="gpt-4o-mini-transcribe"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <Input
                  label={t("audioTranscription.languageHint")}
                  value={audioTranscriptionConfig.languageHint}
                  onChange={(e) =>
                    setAudioTranscriptionConfig((prev) => ({ ...prev, languageHint: e.target.value }))
                  }
                  placeholder="es"
                />
                <Input
                  label={t("audioTranscription.timeoutMs")}
                  type="number"
                  min="1000"
                  max="120000"
                  value={audioTranscriptionConfig.timeoutMs}
                  onChange={(e) =>
                    setAudioTranscriptionConfig((prev) => ({
                      ...prev,
                      timeoutMs: Math.min(
                        Math.max(parseInt(e.target.value || "30000", 10) || 30000, 1000),
                        120000
                      ),
                    }))
                  }
                />
              </div>

              <p className="text-xs text-slate-400">{t("audioTranscription.hint")}</p>

              <div className="flex justify-end">
                <Button
                  onClick={() => saveAudioTranscriptionMutation.mutate()}
                  disabled={saveAudioTranscriptionMutation.isPending}
                >
                  {audioTranscriptionSaved ? (
                    <><Check size={16} /> {t("audioTranscription.saved")}</>
                  ) : saveAudioTranscriptionMutation.isPending ? (
                    t("audioTranscription.saving")
                  ) : (
                    t("audioTranscription.saveButton")
                  )}
                </Button>
              </div>
            </div>
          </ConfigSection>

          {/* Save button for this tab */}
          <div className="flex items-center justify-between pt-4 border-t border-slate-200">
            <p className="text-sm text-slate-400">
              {t("changesInstant")}
            </p>
            <Button
              onClick={() => saveMutation.mutate()}
              disabled={saveMutation.isPending}
            >
              {saved ? (
                <>
                  <Check size={16} />
                  {t("saved")}
                </>
              ) : saveMutation.isPending ? (
                t("saving")
              ) : (
                t("saveChanges")
              )}
            </Button>
          </div>
        </TabsContent>

        {/* ═══════════════════════════════════════════════════════════ */}
        {/* EMAIL & IA */}
        {/* ═══════════════════════════════════════════════════════════ */}
        <TabsContent value="email-ia" className="space-y-6 mt-4">
          <div className="flex justify-end">
            <Button
              type="button"
              variant="secondary"
              onClick={() => refreshTab("email-ia")}
              disabled={refreshingTab === "email-ia"}
            >
              <RefreshCw size={14} className={refreshingTab === "email-ia" ? "animate-spin" : ""} />
              {refreshingTab === "email-ia" ? t("refreshing") : t("refresh")}
            </Button>
          </div>

          <ConfigSection
            title={t("email.title")}
            description={t("email.description")}
          >
            <div className="space-y-4">
              <Input
                label={t("email.smtpUrl")}
                placeholder="smtps://usuario:clave@smtp.mailprovider.com:465"
                value={emailSettings.smtpUrl}
                onChange={(e) => setEmailSettings((prev) => ({ ...prev, smtpUrl: e.target.value }))}
              />
              <p className="text-xs text-slate-400">
                {t("email.smtpUrlNote")}
              </p>

              <div className="grid grid-cols-2 gap-4">
                <Input
                  label={t("email.smtpHost")}
                  placeholder="smtp.gmail.com"
                  value={emailSettings.smtpHost}
                  onChange={(e) => setEmailSettings((prev) => ({ ...prev, smtpHost: e.target.value }))}
                />
                <Input
                  label={t("email.smtpPort")}
                  placeholder="587"
                  value={emailSettings.smtpPort}
                  onChange={(e) => setEmailSettings((prev) => ({ ...prev, smtpPort: e.target.value }))}
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <Input
                  label={t("email.smtpUser")}
                  placeholder="notificaciones@tu-dominio.com"
                  value={emailSettings.smtpUser}
                  onChange={(e) => setEmailSettings((prev) => ({ ...prev, smtpUser: e.target.value }))}
                />
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-medium text-slate-700">{t("email.smtpPass")}</label>
                  <Input
                    type="password"
                    placeholder={emailPassConfigured ? t("email.smtpPassConfigured") : t("email.smtpPass")}
                    value={emailSettings.smtpPass}
                    onChange={(e) => setEmailSettings((prev) => ({ ...prev, smtpPass: e.target.value }))}
                    autoComplete="new-password"
                  />
                  {emailPassConfigured && emailSettings.smtpPass === "" && (
                    <p className="text-xs text-emerald-600 flex items-center gap-1">
                      <Check size={12} /> {t("email.smtpSavedKey")}
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
                {t("email.smtpSecure")}
              </label>

              <div className="grid grid-cols-2 gap-4">
                <Input
                  label={t("email.emailFrom")}
                  placeholder="no-reply@tu-dominio.com"
                  value={emailSettings.emailFrom}
                  onChange={(e) => setEmailSettings((prev) => ({ ...prev, emailFrom: e.target.value }))}
                />
                <Input
                  label={t("email.adminBaseUrl")}
                  placeholder="https://admin.tu-dominio.com"
                  value={emailSettings.adminBaseUrl}
                  onChange={(e) => setEmailSettings((prev) => ({ ...prev, adminBaseUrl: e.target.value }))}
                />
              </div>

              <p className="text-xs text-slate-400">
                {t("email.adminUrlNote")}
              </p>

              <div className="flex justify-end">
                <Button onClick={() => saveEmailMutation.mutate()} disabled={saveEmailMutation.isPending}>
                  {emailSaved ? (
                    <><Check size={16} /> {t("email.saved")}</>
                  ) : saveEmailMutation.isPending ? t("email.saving") : t("email.saveButton")}
                </Button>
              </div>
            </div>
          </ConfigSection>

          {/* LLM / IA */}
          <ConfigSection
            title={t("llm.title")}
            description={t("llm.description")}
          >
            <div className="space-y-4">
              {/* Provider */}
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium text-slate-700">{t("llm.provider")}</label>
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
                <label className="text-sm font-medium text-slate-700">{t("llm.model")}</label>
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
                <label className="text-sm font-medium text-slate-700">{t("llm.apiKey")}</label>
                <Input
                  type="password"
                  placeholder={llmKeyConfigured ? t("llm.apiKeyConfigured") : "sk-... / sk-ant-..."}
                  value={llm.api_key}
                  onChange={(e) => setLlm((prev) => ({ ...prev, api_key: e.target.value }))}
                  autoComplete="new-password"
                />
                {llmKeyConfigured && llm.api_key === "" && (
                  <p className="text-xs text-emerald-600 flex items-center gap-1">
                    <Check size={12} /> {t("llm.apiKeySaved")}
                  </p>
                )}
              </div>

              {/* Base URL — only for custom */}
              {llm.provider === "custom" && (
                <Input
                  label={t("llm.baseUrl")}
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
                    <><Check size={16} /> {t("llm.saved")}</>
                  ) : saveLlmMutation.isPending ? t("llm.saving") : t("llm.saveButton")}
                </Button>
              </div>
            </div>
          </ConfigSection>
        </TabsContent>

        {/* ═══════════════════════════════════════════════════════════ */}
        {/* ORGANIZACIÓN */}
        {/* ═══════════════════════════════════════════════════════════ */}
        <TabsContent value="organizacion" className="space-y-6 mt-4">
          <div className="flex justify-end">
            <Button
              type="button"
              variant="secondary"
              onClick={() => refreshTab("organizacion")}
              disabled={refreshingTab === "organizacion"}
            >
              <RefreshCw size={14} className={refreshingTab === "organizacion" ? "animate-spin" : ""} />
              {refreshingTab === "organizacion" ? t("refreshing") : t("refresh")}
            </Button>
          </div>

          {/* Catalogo de puestos */}
          <ConfigSection
            title={t("puestos.title")}
            description={t("puestos.description")}
          >
            <div className="space-y-4">
              <div className="flex gap-2">
                <Input
                  label=""
                  placeholder={t("puestos.placeholder")}
                  value={puestoNombre}
                  onChange={(e) => setPuestoNombre(e.target.value)}
                />
                <Button type="button" onClick={handleCreatePuesto} disabled={createPuestoMutation.isPending}>
                  {createPuestoMutation.isPending ? t("puestos.creating") : t("puestos.create")}
                </Button>
              </div>

              {puestoError && <p className="text-xs text-rose-600">{puestoError}</p>}

              <div className="space-y-2">
                {puestos.length === 0 ? (
                  <p className="text-sm text-slate-500">{t("puestos.empty")}</p>
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
                                {t("puestos.save")}
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
            title={t("enterpriseConfig.title")}
            description={t("enterpriseConfig.description")}
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
                {t("enterpriseConfig.advancedSearch")}
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
                {t("enterpriseConfig.slaEnabled")}
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
                {t("enterpriseConfig.manualEscalation")}
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
                {t("enterpriseConfig.assignmentRules")}
              </label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-xs text-slate-500 uppercase tracking-wide">
                    {t("enterpriseConfig.slaWarningLabel")}
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
                    {t("enterpriseConfig.escalationIntervalLabel")}
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
                    ? t("enterpriseConfig.saving")
                    : t("enterpriseConfig.saveButton")}
                </Button>
              </div>
            </div>
          </ConfigSection>
        </TabsContent>

        {/* ═══════════════════════════════════════════════════════════ */}
        {/* MÓDULOS & SEGURIDAD */}
        {/* ═══════════════════════════════════════════════════════════ */}
        <TabsContent value="modulos" className="space-y-6 mt-4">
          <div className="flex justify-end">
            <Button
              type="button"
              variant="secondary"
              onClick={() => refreshTab("modulos")}
              disabled={refreshingTab === "modulos"}
            >
              <RefreshCw size={14} className={refreshingTab === "modulos" ? "animate-spin" : ""} />
              {refreshingTab === "modulos" ? t("refreshing") : t("refresh")}
            </Button>
          </div>

          {/* Módulos opcionales */}
          <ConfigSection
            title={t("modules.title")}
            description={t("modules.description")}
          >
            <div className="space-y-4">
              <div className="flex items-center justify-between py-1">
                <div className="flex items-center gap-3">
                  <CalendarDays size={20} className="text-blue-500" />
                  <div>
                    <p className="text-sm font-medium text-slate-800">{t("modules.agenda.name")}</p>
                    <p className="text-xs text-slate-400">
                      {t("modules.agenda.description")}
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

              <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-medium text-slate-700">{t("modules.agenda.appointmentColorLabel")}</label>
                  <div className="flex items-center gap-3">
                    <input
                      type="color"
                      value={agendaAppointmentColor}
                      onChange={(e) => setAgendaAppointmentColor(e.target.value)}
                      className="h-10 w-14 rounded-lg border border-slate-300 bg-white"
                    />
                    <Input
                      label=""
                      value={agendaAppointmentColor}
                      onChange={(e) => setAgendaAppointmentColor(e.target.value)}
                      placeholder="#0EA5E9"
                    />
                  </div>
                  <p className="text-xs text-slate-500">{t("modules.agenda.appointmentColorHint")}</p>
                </div>

                <div className="mt-4 border-t border-slate-200 pt-4 space-y-3">
                  <p className="text-sm font-medium text-slate-700">{t("modules.agenda.scheduleTitle")}</p>

                  <div className="grid gap-3 md:grid-cols-2">
                    <Input
                      label={t("modules.agenda.timezoneLabel")}
                      value={agendaTimeZone}
                      onChange={(e) => setAgendaTimeZone(e.target.value)}
                      placeholder="America/Costa_Rica"
                    />
                  </div>

                  <div className="rounded-lg border border-slate-200 bg-white p-3 overflow-x-auto">
                    <table className="min-w-[860px] w-full text-sm">
                      <thead>
                        <tr className="text-left text-slate-600 border-b border-slate-200">
                          <th className="py-2 pr-3">{t("modules.agenda.dayLabel")}</th>
                          <th className="py-2 pr-3">{t("modules.agenda.enabledLabel")}</th>
                          <th className="py-2">{t("modules.agenda.availableHoursLabel")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {AGENDA_DAY_ORDER.map((day) => {
                          const selectedHours = rangesToSelectedHours(agendaWorkingHours[day] || []);
                          const enabled = selectedHours.length > 0;
                          return (
                            <tr key={day} className="border-b last:border-b-0 border-slate-100">
                              <td className="py-2 pr-3 font-medium text-slate-700">{t(`horarios.days.${day}`)}</td>
                              <td className="py-2 pr-3">
                                <input
                                  type="checkbox"
                                  checked={enabled}
                                  onChange={(e) => setAgendaDayEnabled(day, e.target.checked)}
                                  className="h-4 w-4 rounded border-slate-300 text-blue-600"
                                />
                              </td>
                              <td className="py-2">
                                <div className="flex flex-wrap gap-1.5">
                                  {AGENDA_HOUR_OPTIONS.map((hour) => {
                                    const active = selectedHours.includes(hour);
                                    return (
                                      <button
                                        key={`${day}-${hour}`}
                                        type="button"
                                        disabled={!enabled}
                                        onClick={() => toggleAgendaHour(day, hour)}
                                        className={`rounded-md border px-2 py-1 text-xs transition ${active
                                          ? "border-blue-500 bg-blue-50 text-blue-700"
                                          : "border-slate-300 bg-white text-slate-600"} disabled:opacity-40`}
                                      >
                                        {hourToLabel(hour)}
                                      </button>
                                    );
                                  })}
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                    <p className="mt-3 text-xs text-slate-500">{t("modules.agenda.scheduleHint")}</p>
                  </div>

                  <div className="rounded-lg border border-slate-200 bg-white p-3 space-y-3">
                    <p className="text-sm font-medium text-slate-700">{t("modules.agenda.agentColorsTitle")}</p>
                    {agendaAgents.length === 0 ? (
                      <p className="text-xs text-slate-500">{t("modules.agenda.agentColorsEmpty")}</p>
                    ) : (
                      <div className="grid gap-2 md:grid-cols-2">
                        {agendaAgents
                          .slice()
                          .sort((a, b) => String(a.nombre || "").localeCompare(String(b.nombre || "")))
                          .map((agente) => {
                            const agenteId = Number(agente.id);
                            const color = agendaAgentColors[String(agenteId)] || agendaAppointmentColor;
                            return (
                              <div key={agenteId} className="flex items-center justify-between rounded-md border border-slate-200 px-2 py-2">
                                <div className="min-w-0 pr-2">
                                  <p className="truncate text-sm font-medium text-slate-700">{agente.nombre}</p>
                                  <p className="truncate text-xs text-slate-500">{agente.email || ""}</p>
                                </div>
                                <div className="flex items-center gap-2">
                                  <input
                                    type="color"
                                    value={color}
                                    onChange={(e) => setAgendaAgentColor(agenteId, e.target.value)}
                                    className="h-8 w-10 rounded border border-slate-300 bg-white"
                                  />
                                  <input
                                    type="text"
                                    value={color}
                                    onChange={(e) => setAgendaAgentColor(agenteId, e.target.value)}
                                    className="w-24 rounded-md border border-slate-300 px-2 py-1 text-xs"
                                  />
                                </div>
                              </div>
                            );
                          })}
                      </div>
                    )}
                    <p className="text-xs text-slate-500">{t("modules.agenda.agentColorsHint")}</p>
                  </div>
                </div>

                <div className="mt-3 flex justify-end">
                  <Button
                    type="button"
                    onClick={() => saveAgendaAppearanceMutation.mutate()}
                    disabled={saveAgendaAppearanceMutation.isPending}
                  >
                    {agendaAppearanceSaved ? (
                      <><Check size={16} /> {t("saved")}</>
                    ) : saveAgendaAppearanceMutation.isPending ? t("saving") : t("modules.agenda.saveAppearance")}
                  </Button>
                </div>
              </div>
            </div>
          </ConfigSection>

          {/* Política de Bloqueo de Cuenta */}
          <ConfigSection
            title={t("security.title")}
            description={t("security.description")}
          >
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <Input
                  label={t("security.maxAttempts")}
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
                  label={t("security.lockoutMinutes")}
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
                  {t("security.hint", { maxAttempts: lockoutPolicy.maxAttempts, lockoutMinutes: lockoutPolicy.lockoutMinutes })}
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
                      {t("security.saved")}
                    </>
                  ) : saveLockoutPolicyMutation.isPending ? t("security.saving") : t("security.saveButton")}
                </Button>
              </div>
            </div>
          </ConfigSection>
        </TabsContent>

        {/* ═══════════════════════════════════════════════════════════ */}
        {/* BRANDING */}
        {/* ═══════════════════════════════════════════════════════════ */}
        <TabsContent value="branding" className="space-y-6 mt-4">
          <div className="flex justify-end">
            <Button
              type="button"
              variant="secondary"
              onClick={() => refreshTab("branding")}
              disabled={refreshingTab === "branding"}
            >
              <RefreshCw size={14} className={refreshingTab === "branding" ? "animate-spin" : ""} />
              {refreshingTab === "branding" ? t("refreshing") : t("refresh")}
            </Button>
          </div>

          {/* Branding */}
          <ConfigSection
            title={t("branding.title")}
            description={t("branding.description")}
          >
            <div className="space-y-6">
              {/* Logo upload */}
              <div className="space-y-3">
                <p className="text-sm font-medium text-slate-700">{t("branding.logoLabel")}</p>
                <div className="flex items-center gap-4">
                  {logoPreview ? (
                    <img
                      src={logoPreview}
                      alt={t("branding.logoPreviewAlt")}
                      className="h-16 w-auto max-w-[160px] rounded-lg border border-slate-200 object-contain p-1"
                    />
                  ) : (
                    <div className="flex h-16 w-16 items-center justify-center rounded-lg border-2 border-dashed border-slate-300 bg-slate-50 text-slate-400">
                      <Upload size={20} />
                    </div>
                  )}
                  <div className="space-y-2">
                    <label className="cursor-pointer">
                      <span className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors">
                        <Upload size={14} />
                        {t("branding.selectImage")}
                      </span>
                      <input
                        type="file"
                        accept="image/*"
                        className="sr-only"
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (!file) return;
                          setLogoFile(file);
                          setLogoPreview(URL.createObjectURL(file));
                          setLogoSaved(false);
                        }}
                      />
                    </label>
                    {logoFile && (
                      <Button
                        type="button"
                        onClick={() => uploadLogoMutation.mutate(logoFile)}
                        disabled={uploadLogoMutation.isPending}
                        className="text-sm"
                      >
                        {uploadLogoMutation.isPending ? t("branding.saving") : t("branding.saveLogo")}
                      </Button>
                    )}
                    {logoSaved && (
                      <p className="text-xs text-green-600 flex items-center gap-1">
                        <Check size={12} /> {t("branding.logoSaved")}
                      </p>
                    )}
                    {uploadLogoMutation.isError && (
                      <p className="text-xs text-red-600">{t("branding.logoError")}</p>
                    )}
                    <p className="text-xs text-slate-400">{t("branding.logoHint")}</p>
                  </div>
                </div>
              </div>

              <Input
                label={t("branding.orgName")}
                placeholder="Clínica Esperanza"
                value={brandingOrgName}
                onChange={(e) => setBrandingOrgName(e.target.value)}
              />
              <div className="grid grid-cols-1 sm:grid-cols-[120px_1fr] gap-3 items-end">
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-medium text-slate-700">{t("branding.primaryColor")}</label>
                  <input
                    type="color"
                    value={normalizeHexColor(brandingPrimaryColor, "#2563eb")}
                    onChange={(e) => setBrandingPrimaryColor(e.target.value)}
                    className="h-10 w-full rounded-lg border border-slate-300 bg-white"
                  />
                </div>
                <Input
                  label=""
                  placeholder="#2563eb"
                  value={brandingPrimaryColor}
                  onChange={(e) => setBrandingPrimaryColor(e.target.value)}
                />
              </div>

              <div className="flex justify-end">
                <Button
                  type="button"
                  onClick={() => saveBrandingMutation.mutate()}
                  disabled={saveBrandingMutation.isPending}
                >
                  {brandingSaved ? (
                    <><Check size={16} /> {t("branding.saved")}</>
                  ) : saveBrandingMutation.isPending ? t("branding.saving") : t("branding.saveButton")}
                </Button>
              </div>
            </div>
          </ConfigSection>
        </TabsContent>
      </Tabs>
    </div>
  );
}
