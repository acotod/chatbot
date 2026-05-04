"use client";

import { agendaApi, apiClient, configApi } from "@/lib/api";
import { useAuthStore } from "@/store/auth";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Card, CardContent, CardHeader } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { CalendarDays, Check } from "lucide-react";

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

export default function ConfiguracionPage() {
  const { tenantSlug } = useAuthStore();
  const qc = useQueryClient();

  const [saved, setSaved] = useState(false);
  const [horarios, setHorarios] = useState({
    inicio: "08:00",
    fin: "18:00",
  });
  const [mensajeBienvenida, setMensajeBienvenida] = useState(
    "¡Hola! Estamos aquí para apoyarte. ¿En qué podemos ayudarte hoy? 💙"
  );

  // WhatsApp Business credentials
  const [waCreds, setWaCreds] = useState({ phoneNumberId: "", accessToken: "" });
  const [waSaved, setWaSaved] = useState(false);

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

  const { data: waCredsData } = useQuery({
    queryKey: ["config", tenantSlug, "wa_credentials"],
    queryFn: () =>
      configApi.get(tenantSlug, "wa_credentials").then((r) => {
        const v = r?.data?.valor;
        if (v?.phoneNumberId) setWaCreds(v);
        return r?.data;
      }),
    enabled: !!tenantSlug,
  });
  void waCredsData;

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
        accessToken: waCreds.accessToken,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["config", tenantSlug, "wa_credentials"] });
      setWaSaved(true);
      setTimeout(() => setWaSaved(false), 3000);
    },
  });

  const { data: configData } = useQuery({
    queryKey: ["config", tenantSlug, "horarios"],
    queryFn: () =>
      apiClient
        .get(`/admin/tenants/${tenantSlug}/config/horarios`)
        .then((r) => {
          const v = r.data?.valor;
          if (v?.inicio) setHorarios(v);
          return r.data;
        })
        .catch(() => null),
    enabled: !!tenantSlug,
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

  void configData;

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
    <div className="space-y-6 max-w-2xl">
      {/* Horarios */}
      <ConfigSection
        title="Horarios de atención"
        description="Definí en qué rango horario el chatbot acepta nuevas solicitudes"
      >
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
            placeholder="EAAGm..."
            value={waCreds.accessToken}
            onChange={(e) => setWaCreds((c) => ({ ...c, accessToken: e.target.value }))}
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

      {/* Save button */}
      <div className="flex items-center justify-between pt-2">
        <p className="text-sm text-slate-400">
          Los cambios se aplican de inmediato al flujo del chatbot
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
    </div>
  );
}
