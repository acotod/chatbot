"use client";

import { useEffect, useState, useCallback } from "react";
import {
  Upload,
  Download,
  Plus,
  Trash2,
  Edit3,
  RefreshCw,
  CheckCircle2,
  XCircle,
  Clock,
  Play,
  History,
  Webhook,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  FileJson,
  Layers,
  RotateCcw,
  Send,
  Eye,
  X,
  ArrowRight,
  ArrowUp,
  ArrowDown,
  Zap,
} from "lucide-react";
import { wabaFlowsApi, integrationsApi, variablesApi } from "@/lib/api";
import { useAuthStore } from "@/store/auth";
import MenuOptionsEditor from "@/components/flujos/MenuOptionsEditor";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────
interface FlowVersion {
  id: number;
  versionNumber: number;
  published: boolean;
  publishedAt?: string;
  changelog?: string;
  wabaValidationStatus: "draft" | "valid" | "invalid" | "exported";
  wabaValidatedAt?: string;
  wabaValidationErrors?: string[];
  createdAt: string;
  _count?: { executions: number };
}

interface WabaFlow {
  id: number;
  nombre: string;
  version: number;
  activo: boolean;
  metaJson?: unknown;
  createdAt: string;
  updatedAt: string;
  flowVersions?: FlowVersion[];
  _count?: { flowVersions: number; executions: number };
}

interface NodeDef {
  id: string;
  type: string;
  config: Record<string, unknown>;
  next?: string | null;
  branches?: Record<string, string>;
}

interface FlowDefinition {
  version?: string;
  entry_point: string;
  nodes: NodeDef[];
  variables?: Record<string, unknown>;
  integrations?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

interface SimulationStep {
  nodeId?: string;
  nodeType?: string;
  input?: string;
  output?: Record<string, unknown>;
  error?: string;
  waiting_for_input?: boolean;
}

interface CatalogEndpoint {
  id: string;
  name: string;
  method: string;
  url: string;
  inputs: string[];
  outputs: string[];
  description?: string;
  sessionInit?: boolean;
}

type TabKey = "list" | "builder" | "versions" | "simulate" | "import-logs";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
const STATUS_BADGE: Record<string, string> = {
  draft:    "bg-slate-100 text-slate-600",
  valid:    "bg-green-100 text-green-700",
  invalid:  "bg-red-100 text-red-700",
  exported: "bg-blue-100 text-blue-700",
};

const NODE_TYPE_COLOR: Record<string, string> = {
  message:   "border-blue-300 bg-blue-50",
  input:     "border-amber-300 bg-amber-50",
  menu:      "border-purple-300 bg-purple-50",
  condition: "border-orange-300 bg-orange-50",
  action:    "border-green-300 bg-green-50",
  delay:     "border-slate-300 bg-slate-50",
  end:       "border-rose-300 bg-rose-50",
  start:     "border-teal-300 bg-teal-50",
  handoff:   "border-indigo-300 bg-indigo-50",
  llm:       "border-violet-300 bg-violet-50",
};

function fmtDate(iso?: string) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("es-MX", {
    day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-component: ImportModal
// ─────────────────────────────────────────────────────────────────────────────
function ImportModal({ onClose, onImported, tenantSlug }: { onClose: () => void; onImported: () => void; tenantSlug: string }) {
  const [json, setJson]     = useState("");
  const [nombre, setNombre] = useState("");
  const [error, setError]   = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult]  = useState<Record<string, unknown> | null>(null);

  async function handleImport() {
    setError("");
    if (!tenantSlug) {
      setError("Selecciona un tenant antes de importar.");
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      setError("JSON inválido — verifica el formato.");
      return;
    }
    setLoading(true);
    try {
      const { data } = await wabaFlowsApi.import({ wabaJson: parsed, nombre: nombre || undefined, tenantSlug });
      setResult(data);
      onImported();
    } catch (e: unknown) {
      const responseData = (e as { response?: { data?: { error?: string; validation?: { errors?: string[] } } } })?.response?.data;
      const validationErrors = Array.isArray(responseData?.validation?.errors) ? responseData.validation.errors : [];
      const msg = responseData?.error;
      setError(validationErrors.length > 0 ? `${msg ?? "Error al importar el flujo."} ${validationErrors.join(" | ")}` : (msg ?? "Error al importar el flujo."));
    } finally {
      setLoading(false);
    }
  }

  function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => setJson(ev.target?.result as string);
    reader.readAsText(file);
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl flex flex-col max-h-[90vh]">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
          <div className="flex items-center gap-2">
            <Upload className="w-5 h-5 text-blue-600" />
            <h2 className="font-semibold text-slate-800">Importar WABA Flow JSON</h2>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X className="w-5 h-5" /></button>
        </div>

        <div className="overflow-y-auto flex-1 px-6 py-4 space-y-4">
          {result ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-green-700 bg-green-50 rounded-xl px-4 py-3">
                <CheckCircle2 className="w-5 h-5" />
                <span className="font-medium">Flujo importado exitosamente</span>
              </div>
              <div className="rounded-xl border border-slate-200 p-4 bg-slate-50 text-xs font-mono overflow-auto max-h-60">
                {JSON.stringify(result, null, 2)}
              </div>
              <button onClick={onClose} className="w-full btn-primary py-2.5">Cerrar</button>
            </div>
          ) : (
            <>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Nombre del flujo (opcional)</label>
                <input
                  value={nombre}
                  onChange={(e) => setNombre(e.target.value)}
                  placeholder="Mi flujo de atención"
                  className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Subir archivo JSON</label>
                <input
                  type="file"
                  accept=".json,application/json"
                  onChange={handleFileUpload}
                  className="block text-sm text-slate-500 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:text-xs file:font-medium file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">O pegar WABA JSON</label>
                <textarea
                  value={json}
                  onChange={(e) => setJson(e.target.value)}
                  rows={10}
                  placeholder='{"version": "7.1", "screens": [...]}'
                  className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              {error && (
                <div className="flex items-start gap-2 text-red-700 bg-red-50 rounded-xl px-4 py-3 text-sm">
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>{error}</span>
                </div>
              )}
            </>
          )}
        </div>

        {!result && (
          <div className="px-6 py-4 border-t border-slate-100 flex justify-end gap-3">
            <button onClick={onClose} className="px-4 py-2 text-sm text-slate-600 hover:text-slate-800">Cancelar</button>
            <button
              onClick={handleImport}
              disabled={loading || !json.trim()}
              className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
            >
              {loading ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
              Importar
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-component: CreateFlowModal
// ─────────────────────────────────────────────────────────────────────────────
function CreateFlowModal({ onClose, onCreated, tenantSlug }: { onClose: () => void; onCreated: () => void; tenantSlug: string }) {
  const [nombre, setNombre] = useState("");
  const [error, setError]   = useState("");
  const [loading, setLoading] = useState(false);

  async function handleCreate() {
    if (!nombre.trim()) { setError("El nombre es obligatorio"); return; }
    if (!tenantSlug) { setError("Selecciona un tenant antes de crear el flujo."); return; }
    setError("");
    setLoading(true);
    try {
      await wabaFlowsApi.create({ nombre, tenantSlug });
      onCreated();
      onClose();
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setError(msg ?? "Error al crear el flujo.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
          <div className="flex items-center gap-2">
            <Plus className="w-5 h-5 text-blue-600" />
            <h2 className="font-semibold text-slate-800">Nuevo WABA Flow</h2>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X className="w-5 h-5" /></button>
        </div>
        <div className="px-6 py-4 space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Nombre del flujo</label>
            <input
              value={nombre}
              onChange={(e) => setNombre(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleCreate()}
              placeholder="Flujo de bienvenida"
              className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              autoFocus
            />
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>
        <div className="px-6 py-4 border-t border-slate-100 flex justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2 text-sm text-slate-600 hover:text-slate-800">Cancelar</button>
          <button
            onClick={handleCreate}
            disabled={loading}
            className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
          >
            {loading ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
            Crear
          </button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-component: NodeEditor (inline block editor)
// ─────────────────────────────────────────────────────────────────────────────
function NodeCard({
  node,
  isEntry,
  canMoveUp,
  canMoveDown,
  onMoveUp,
  onMoveDown,
  onEdit,
  onDelete,
}: {
  node: NodeDef;
  isEntry: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMoveUp: (id: string) => void;
  onMoveDown: (id: string) => void;
  onEdit: (node: NodeDef) => void;
  onDelete: (id: string) => void;
}) {
  const colorClass = NODE_TYPE_COLOR[node.type] ?? "border-slate-200 bg-white";
  return (
    <div className={`relative rounded-xl border-2 ${colorClass} p-4 group`}>
      {isEntry && (
        <span className="absolute -top-2.5 left-3 text-xs font-bold bg-teal-500 text-white px-2 py-0.5 rounded-full">
          ENTRY
        </span>
      )}
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xs font-mono text-slate-500">{node.id}</span>
            <span className={`text-xs font-semibold px-1.5 py-0.5 rounded-md ${STATUS_BADGE.valid}`}>
              {node.type}
            </span>
          </div>
          {!!node.config?.text && (
            <p className="text-sm text-slate-700 truncate">{String(node.config.text)}</p>
          )}
          {node.type === "menu" && Array.isArray(node.config?.options) && (
            <p className="text-xs text-slate-500 mt-1">
              {(node.config.options as { title: string }[]).map((o) => o.title).join(", ")}
            </p>
          )}
          {node.type === "action" && (
            <p className="text-xs text-slate-500 mt-1 font-mono">
              {String(node.config?.integration_ref ?? node.config?.endpoint ?? "—")}
            </p>
          )}
          {node.next && (
            <div className="flex items-center gap-1 mt-2 text-xs text-slate-400">
              <ArrowRight className="w-3 h-3" />
              <span>{node.next}</span>
            </div>
          )}
        </div>
        <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            onClick={() => onMoveUp(node.id)}
            disabled={!canMoveUp}
            className="p-1.5 rounded-lg hover:bg-white/80 text-slate-500 hover:text-blue-600 disabled:opacity-30 disabled:cursor-not-allowed"
          >
            <ArrowUp className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => onMoveDown(node.id)}
            disabled={!canMoveDown}
            className="p-1.5 rounded-lg hover:bg-white/80 text-slate-500 hover:text-blue-600 disabled:opacity-30 disabled:cursor-not-allowed"
          >
            <ArrowDown className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => onEdit(node)}
            className="p-1.5 rounded-lg hover:bg-white/80 text-slate-500 hover:text-blue-600"
          >
            <Edit3 className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => onDelete(node.id)}
            className="p-1.5 rounded-lg hover:bg-white/80 text-slate-500 hover:text-red-600"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-component: NodeEditModal
// ─────────────────────────────────────────────────────────────────────────────
const NODE_TYPES = ["message", "input", "menu", "condition", "action", "delay", "end", "handoff", "llm"];
const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];
const CONDITION_OPS = ["equals", "not_equals", "contains", "starts_with", "ends_with", "greater_than", "less_than", "is_empty", "is_not_empty"];
const MENU_VARIABLE_PRESETS = [
  "variables.opcion_menu",
  "variables.menu_seleccion",
  "variables.menu_opcion_id",
  "variables.menu_opcion_titulo",
];

function NodeEditModal({
  node,
  allNodeIds,
  catalogEndpoints,
  flowVariables,
  integrations,
  onSave,
  onClose,
}: {
  node: Partial<NodeDef>;
  allNodeIds: string[];
  catalogEndpoints: CatalogEndpoint[];
  flowVariables: string[];
  integrations: { id: number; nombre: string; tipo: string }[];
  onSave: (n: NodeDef) => void;
  onClose: () => void;
}) {
  const cfg = (node.config ?? {}) as Record<string, unknown>;
  const initialBranches = (node.branches ?? {}) as Record<string, string>;

  function buildBranchesFromOptions(options: { id: string; title: string; next: string }[]): Record<string, string> {
    return options.reduce<Record<string, string>>((acc, option) => {
      const key = option.id.trim();
      const target = option.next.trim();
      if (key && target) acc[key] = target;
      return acc;
    }, {});
  }

  function parseBranchesSafely(raw: string): Record<string, string> | null {
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
      const out: Record<string, string> = {};
      Object.entries(parsed as Record<string, unknown>).forEach(([k, v]) => {
        if (typeof v === "string") out[k] = v;
      });
      return out;
    } catch {
      return null;
    }
  }

  const [id, setId]     = useState(node.id ?? "");
  const [type, setType] = useState(node.type ?? "message");
  const [next, setNext] = useState(node.next ?? "");
  const [branchesJson, setBranchesJson] = useState(JSON.stringify(initialBranches, null, 2));
  const [err, setErr]   = useState("");
  const [showJson, setShowJson] = useState(false);
  const [rawJson, setRawJson]   = useState(JSON.stringify(cfg, null, 2));

  // per-type state
  const [text, setText]               = useState(String(cfg.text ?? ""));
  const [inputText, setInputText]     = useState(String(cfg.text ?? ""));
  const [inputVar, setInputVar]       = useState(String(cfg.variable ?? ""));
  const [menuText, setMenuText]       = useState(String(cfg.text ?? ""));
  const [menuVar, setMenuVar]         = useState(String(cfg.variable ?? "variables.opcion_menu"));
  const [menuOptions, setMenuOptions] = useState<{ id: string; title: string; next: string }[]>(
    Array.isArray(cfg.options)
      ? (cfg.options as Array<{ id?: string; title?: string; next?: string }>).map((option, index) => {
          const optionId = String(option.id ?? `opt_${index + 1}`);
          return {
            id: optionId,
            title: String(option.title ?? ""),
            next: String(option.next ?? initialBranches[optionId] ?? ""),
          };
        })
      : []
  );
  const [condVar, setCondVar]         = useState(String(cfg.variable ?? ""));
  const [condOp, setCondOp]           = useState(String(cfg.operator ?? "equals"));
  const [condVal, setCondVal]         = useState(String(cfg.value ?? ""));
  const [delaySeconds, setDelaySeconds] = useState(Number(cfg.seconds ?? 3));
  const [endMsg, setEndMsg]           = useState(String(cfg.message ?? ""));
  const [handoffDept, setHandoffDept] = useState(String(cfg.department ?? ""));
  const [handoffMsg, setHandoffMsg]   = useState(String(cfg.message ?? ""));
  const [llmPrompt, setLlmPrompt]     = useState(String(cfg.prompt ?? ""));
  const [llmVar, setLlmVar]           = useState(String(cfg.variable ?? ""));
  // action
  const [actionRef, setActionRef]       = useState(String(cfg.integration_ref ?? ""));
  const [actionUrl, setActionUrl]       = useState(String((cfg.endpoint ?? (cfg as Record<string,unknown>).url) ?? ""));
  const [actionMethod, setActionMethod] = useState(String(cfg.method ?? "POST"));
  const [actionBody, setActionBody]     = useState<{ key: string; value: string }[]>(
    Object.entries((cfg.body as Record<string, string>) ?? {}).map(([k, v]) => ({ key: k, value: v }))
  );
  const [actionResponse, setActionResponse] = useState<{ key: string; value: string }[]>(
    Object.entries((cfg.response_mapping as Record<string, string>) ?? {}).map(([k, v]) => ({ key: k, value: v }))
  );

  const selectedEp = catalogEndpoints.find((ep) => ep.id === actionRef);

  const menuValidation = (() => {
    if (type !== "menu") {
      return { duplicateIds: [] as string[], missingIdIndexes: [] as number[], missingNextIndexes: [] as number[] };
    }

    const idCounter = new Map<string, number>();
    menuOptions.forEach((option) => {
      const normalized = option.id.trim();
      if (!normalized) return;
      idCounter.set(normalized, (idCounter.get(normalized) ?? 0) + 1);
    });

    const duplicateIds = Array.from(idCounter.entries())
      .filter(([, count]) => count > 1)
      .map(([id]) => id);

    const missingIdIndexes: number[] = [];
    const missingNextIndexes: number[] = [];

    menuOptions.forEach((option, index) => {
      if (!option.id.trim()) missingIdIndexes.push(index);
      if (!option.next.trim()) missingNextIndexes.push(index);
    });

    return { duplicateIds, missingIdIndexes, missingNextIndexes };
  })();

  const hasMenuValidationErrors =
    menuValidation.duplicateIds.length > 0 ||
    menuValidation.missingIdIndexes.length > 0 ||
    menuValidation.missingNextIndexes.length > 0;

  useEffect(() => {
    if (type !== "menu") return;
    const parsed = parseBranchesSafely(branchesJson);
    if (!parsed) return;
    setMenuOptions((prev) => prev.map((option) => ({
      ...option,
      next: parsed[option.id] ?? "",
    })));
  }, [branchesJson, type]);

  function applyEndpoint(ep: CatalogEndpoint) {
    setActionRef(ep.id);
    setActionUrl(ep.url);
    setActionMethod(ep.method);
    setActionBody(ep.inputs.map((f) => ({ key: f, value: actionBody.find((b) => b.key === f)?.value ?? "" })));
    setActionResponse(ep.outputs.map((f) => ({ key: f, value: actionResponse.find((r) => r.key === f)?.value ?? `variables.${f}` })));
  }

    function handleActionUrlChange(value: string) {
      setActionUrl(value);

      const matchedEndpoint = catalogEndpoints.find((ep) => ep.url.trim() === value.trim());
      if (matchedEndpoint) {
        applyEndpoint(matchedEndpoint);
        return;
      }

      if (actionRef && selectedEp?.url !== value) {
        setActionRef("");
      }
    }

  function buildConfig(): Record<string, unknown> {
    const body: Record<string, string> = {};
    actionBody.forEach((r) => { if (r.key.trim()) body[r.key.trim()] = r.value; });
    const response_mapping: Record<string, string> = {};
    actionResponse.forEach((r) => { if (r.key.trim()) response_mapping[r.key.trim()] = r.value; });

    const actionFragment: Record<string, unknown> = {
      ...(actionRef ? { integration_ref: actionRef } : {}),
      ...(actionUrl.trim() ? { endpoint: actionUrl.trim() } : {}),
      ...(actionMethod ? { method: actionMethod } : {}),
      ...(Object.keys(body).length ? { body } : {}),
      ...(Object.keys(response_mapping).length ? { response_mapping } : {}),
    };

    switch (type) {
      case "message":   return { text };
      case "input":     return { text: inputText, variable: inputVar };
      case "menu":      return { text: menuText, options: menuOptions, ...(menuVar.trim() ? { variable: menuVar.trim() } : {}), ...actionFragment };
      case "condition": return { variable: condVar, operator: condOp, value: condVal };
      case "delay":     return { seconds: delaySeconds };
      case "end":       return { message: endMsg };
      case "handoff":   return { department: handoffDept, message: handoffMsg };
      case "llm":       return { prompt: llmPrompt, variable: llmVar };
      case "action":    return actionFragment;
      default: { try { return JSON.parse(rawJson); } catch { return {}; } }
    }
  }

  function handleSave() {
    if (!id.trim()) { setErr("El ID del nodo es obligatorio"); return; }
    if (type === "menu" && !showJson && hasMenuValidationErrors) {
      setErr("Corrige las opciones del menú antes de guardar (IDs únicos y next obligatorio).");
      return;
    }
    let branches: Record<string, string>;
    if (type === "menu" && !showJson) {
      branches = buildBranchesFromOptions(menuOptions);
    } else {
      try {
        const parsed = JSON.parse(branchesJson);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          setErr("branches JSON inválido");
          return;
        }
        branches = parsed as Record<string, string>;
      } catch {
        setErr("branches JSON inválido");
        return;
      }
    }
    let config: Record<string, unknown>;
    if (showJson) {
      try { config = JSON.parse(rawJson); } catch { setErr("config JSON inválido"); return; }
    } else {
      config = buildConfig();
    }
    onSave({ id: id.trim(), type, config, next: next || null, branches });
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl flex flex-col max-h-[90vh]">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
          <h2 className="font-semibold text-slate-800">{node.id ? "Editar nodo" : "Nuevo nodo"}</h2>
          <div className="flex items-center gap-2">
            <button
              onClick={() => { setRawJson(JSON.stringify(buildConfig(), null, 2)); setShowJson((v) => !v); }}
              className={`text-xs px-2.5 py-1 rounded-lg border transition ${
                showJson ? "bg-slate-800 text-white border-slate-700" : "border-slate-200 text-slate-500 hover:bg-slate-50"
              }`}
            >
              {showJson ? "Formulario" : "JSON"}
            </button>
            <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X className="w-5 h-5" /></button>
          </div>
        </div>

        <div className="overflow-y-auto flex-1 px-6 py-4 space-y-4">
          {/* Shared datalist for variable suggestions */}
          <datalist id="waba-var-suggestions">
            {(flowVariables.length > 0 ? flowVariables : MENU_VARIABLE_PRESETS).map((v) => (
              <option key={v} value={v} />
            ))}
          </datalist>
          {/* ID + Type */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">ID del nodo</label>
              <input value={id} onChange={(e) => setId(e.target.value)} placeholder="node_1" disabled={!!node.id}
                className="w-full rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-slate-50" />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Tipo</label>
              <select value={type} onChange={(e) => setType(e.target.value)}
                className="w-full rounded-lg border border-slate-200 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                {NODE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
          </div>

          {/* Config */}
          {showJson ? (
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Config (JSON)</label>
              <textarea value={rawJson} onChange={(e) => setRawJson(e.target.value)} rows={8}
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
          ) : (
            <div className="space-y-3">
              {/* message */}
              {type === "message" && (
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Mensaje</label>
                  <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3}
                    placeholder="Hola {{variables.nombre}}, ¿en qué te puedo ayudar?"
                    className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                </div>
              )}
              {/* input */}
              {type === "input" && (
                <>
                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1">Pregunta al usuario</label>
                    <textarea value={inputText} onChange={(e) => setInputText(e.target.value)} rows={2}
                      placeholder="¿Cuál es tu número de cédula?"
                      className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1">Guardar respuesta en variable</label>
                    <input list="waba-var-suggestions" value={inputVar} onChange={(e) => setInputVar(e.target.value)} placeholder="variables.cedula"
                      className="w-full rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500" />
                  </div>
                </>
              )}
              {/* menu */}
              {type === "menu" && (
                <>
                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1">Texto del menú</label>
                    <textarea value={menuText} onChange={(e) => setMenuText(e.target.value)} rows={2}
                      placeholder="¿En qué te puedo ayudar?"
                      className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                  </div>
                  <MenuOptionsEditor
                    options={menuOptions}
                    nextNodeOptions={allNodeIds.map((nid) => ({ value: nid, label: `${nid} · nodo` }))}
                    onAddOption={() => {
                      setMenuOptions((prev) => {
                        const nextOptions = [...prev, { id: `opt_${prev.length + 1}`, title: "", next: "" }];
                        setBranchesJson(JSON.stringify(buildBranchesFromOptions(nextOptions), null, 2));
                        return nextOptions;
                      });
                    }}
                    onRemoveOption={(index) => {
                      setMenuOptions((prev) => {
                        const nextOptions = prev.filter((_, i) => i !== index);
                        setBranchesJson(JSON.stringify(buildBranchesFromOptions(nextOptions), null, 2));
                        return nextOptions;
                      });
                    }}
                    onChangeOption={(index, key, value) => {
                      setMenuOptions((prev) => {
                        const nextOptions = prev.map((option, i) => i === index ? { ...option, [key]: value } : option);
                        setBranchesJson(JSON.stringify(buildBranchesFromOptions(nextOptions), null, 2));
                        return nextOptions;
                      });
                    }}
                    showNextSelector
                    title="Opciones del menú"
                    addLabel="Agregar"
                    emptyText="Este menú aún no tiene opciones."
                    idPlaceholder="id_opcion"
                    titlePlaceholder="Título visible"
                    nextPlaceholder="Siguiente nodo (opcional)"
                  />
                  {hasMenuValidationErrors && (
                    <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 space-y-1">
                      {menuValidation.duplicateIds.length > 0 && (
                        <p>IDs duplicados: {menuValidation.duplicateIds.join(", ")}</p>
                      )}
                      {menuValidation.missingIdIndexes.length > 0 && (
                        <p>Opciones sin ID: {menuValidation.missingIdIndexes.map((i) => i + 1).join(", ")}</p>
                      )}
                      {menuValidation.missingNextIndexes.length > 0 && (
                        <p>Opciones sin siguiente nodo: {menuValidation.missingNextIndexes.map((i) => i + 1).join(", ")}</p>
                      )}
                    </div>
                  )}
                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1">Guardar selección en variable</label>
                    <input list="waba-var-suggestions" value={menuVar} onChange={(e) => setMenuVar(e.target.value)} placeholder="variables.opcion_menu"
                      className="w-full rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500" />
                  </div>
                </>
              )}
              {/* condition */}
              {type === "condition" && (
                <div className="grid grid-cols-3 gap-2">
                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1">Variable</label>
                    <input list="waba-var-suggestions" value={condVar} onChange={(e) => setCondVar(e.target.value)} placeholder="variables.estatus"
                      className="w-full rounded-lg border border-slate-200 px-2 py-1.5 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-blue-500" />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1">Operador</label>
                    <select value={condOp} onChange={(e) => setCondOp(e.target.value)}
                      className="w-full rounded-lg border border-slate-200 px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500">
                      {CONDITION_OPS.map((op) => <option key={op} value={op}>{op}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1">Valor</label>
                    <input value={condVal} onChange={(e) => setCondVal(e.target.value)} placeholder="activo"
                      className="w-full rounded-lg border border-slate-200 px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500" />
                  </div>
                </div>
              )}
              {/* delay */}
              {type === "delay" && (
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Duración (segundos)</label>
                  <input type="number" min={1} value={delaySeconds} onChange={(e) => setDelaySeconds(Number(e.target.value))}
                    className="w-32 rounded-lg border border-slate-200 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                </div>
              )}
              {/* end */}
              {type === "end" && (
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Mensaje de cierre (opcional)</label>
                  <textarea value={endMsg} onChange={(e) => setEndMsg(e.target.value)} rows={2}
                    placeholder="Gracias por contactarnos. ¡Hasta pronto!"
                    className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                </div>
              )}
              {/* handoff */}
              {type === "handoff" && (
                <>
                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1">Departamento / Agente</label>
                    <input value={handoffDept} onChange={(e) => setHandoffDept(e.target.value)} placeholder="soporte_tecnico"
                      className="w-full rounded-lg border border-slate-200 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1">Mensaje al transferir</label>
                    <textarea value={handoffMsg} onChange={(e) => setHandoffMsg(e.target.value)} rows={2}
                      placeholder="Te transfiero con un agente..."
                      className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                  </div>
                </>
              )}
              {/* llm */}
              {type === "llm" && (
                <>
                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1">Prompt</label>
                    <textarea value={llmPrompt} onChange={(e) => setLlmPrompt(e.target.value)} rows={4}
                      placeholder="Dado el contexto {{variables.contexto}}, genera una respuesta..."
                      className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1">Guardar respuesta en</label>
                    <input list="waba-var-suggestions" value={llmVar} onChange={(e) => setLlmVar(e.target.value)} placeholder="variables.respuesta_llm"
                      className="w-full rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500" />
                  </div>
                </>
              )}
              {/* action / menu webhook call */}
              {(type === "action" || type === "menu") && (
                <div className="space-y-4">
                  {type === "menu" && (
                    <p className="text-xs font-medium text-slate-600 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
                      Llamado de endpoint/webhook al seleccionar opción (opcional)
                    </p>
                  )}
                  {/* Catalog endpoint picker */}
                  {catalogEndpoints.length > 0 && (
                    <div>
                      <label className="block text-xs font-medium text-slate-600 mb-2">Endpoint del catálogo</label>
                      <div className="flex flex-wrap gap-1.5">
                        {catalogEndpoints.map((ep) => (
                          <button key={ep.id} onClick={() => applyEndpoint(ep)}
                            className={`text-xs px-2.5 py-1 rounded-lg border transition ${
                              actionRef === ep.id
                                ? "bg-blue-600 text-white border-blue-600"
                                : "bg-white text-slate-600 border-slate-200 hover:border-blue-400 hover:text-blue-600"
                            }`}>
                            {ep.sessionInit ? "⚡ " : ""}{ep.name}
                          </button>
                        ))}
                        {actionRef && (
                          <button onClick={() => setActionRef("")}
                            className="text-xs px-2 py-1 rounded-lg border border-slate-200 text-slate-400 hover:text-red-500">
                            × Personalizado
                          </button>
                        )}
                      </div>
                      {selectedEp?.description && (
                        <p className="text-xs text-slate-400 mt-1 italic">{selectedEp.description}</p>
                      )}
                    </div>
                  )}
                  {/* Integrations picker (fallback / always shown) */}
                  {integrations.length > 0 && (
                    <div>
                      <label className="block text-xs font-medium text-slate-600 mb-2">Integración</label>
                      <div className="flex flex-wrap gap-1.5">
                        {integrations.map((intg) => (
                          <button key={intg.id} onClick={() => setActionRef(String(intg.id))}
                            className={`text-xs px-2.5 py-1 rounded-lg border transition ${
                              actionRef === String(intg.id)
                                ? "bg-violet-600 text-white border-violet-600"
                                : "bg-white text-slate-600 border-slate-200 hover:border-violet-400 hover:text-violet-600"
                            }`}>
                            {intg.tipo === "webhook" ? "🔗 " : intg.tipo === "rest" ? "⚙️ " : ""}{intg.nombre}
                          </button>
                        ))}
                        {actionRef && (
                          <button onClick={() => setActionRef("")}
                            className="text-xs px-2 py-1 rounded-lg border border-slate-200 text-slate-400 hover:text-red-500">
                            × Limpiar
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                  {/* Method + URL */}
                  <div className="flex gap-2">
                    <div className="w-28 shrink-0">
                      <label className="block text-xs font-medium text-slate-600 mb-1">Método</label>
                      <select value={actionMethod} onChange={(e) => setActionMethod(e.target.value)}
                        className="w-full rounded-lg border border-slate-200 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                        {HTTP_METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
                      </select>
                    </div>
                    <div className="flex-1">
                      <label className="block text-xs font-medium text-slate-600 mb-1">URL del endpoint</label>
                      <datalist id="waba-url-suggestions">
                        {catalogEndpoints.map((ep) => (
                          <option key={ep.id} value={ep.url}>{ep.name}</option>
                        ))}
                      </datalist>
                      <input list="waba-url-suggestions" value={actionUrl} onChange={(e) => handleActionUrlChange(e.target.value)} placeholder="/api/billing/balance"
                        className="w-full rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500" />
                    </div>
                  </div>
                  {/* Body params */}
                  <div className="rounded-xl border border-slate-200 p-3 bg-slate-50">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs font-semibold text-slate-600">Parámetros del body (inputs)</span>
                      <button onClick={() => setActionBody((b) => [...b, { key: "", value: "" }])}
                        className="flex items-center gap-0.5 text-xs text-blue-600 hover:text-blue-800">
                        <Plus className="w-3 h-3" /> Agregar
                      </button>
                    </div>
                    {actionBody.length === 0 && (
                      <p className="text-xs text-slate-400 italic">Sin parámetros. Selecciona un endpoint del catálogo o haz click en &quot;+ Agregar&quot;.</p>
                    )}
                    <div className="space-y-1.5">
                      {actionBody.map((row, i) => (
                        <div key={i} className="flex gap-2 items-center">
                          <input value={row.key} onChange={(e) => setActionBody((b) => b.map((r, j) => j === i ? { ...r, key: e.target.value } : r))}
                            placeholder="campo_api"
                            className="w-36 rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-blue-500" />
                          <span className="text-slate-400 text-xs shrink-0">→</span>
                          <input list="waba-var-suggestions" value={row.value} onChange={(e) => setActionBody((b) => b.map((r, j) => j === i ? { ...r, value: e.target.value } : r))}
                            placeholder="variables.cedula o valor fijo"
                            className="flex-1 rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-blue-500" />
                          <button onClick={() => setActionBody((b) => b.filter((_, j) => j !== i))}
                            className="text-red-400 hover:text-red-600 shrink-0"><Trash2 className="w-3.5 h-3.5" /></button>
                        </div>
                      ))}
                    </div>
                  </div>
                  {/* Response mapping */}
                  <div className="rounded-xl border border-slate-200 p-3 bg-slate-50">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs font-semibold text-slate-600">Mapeo de respuesta (outputs → variables)</span>
                      <button onClick={() => setActionResponse((r) => [...r, { key: "", value: "" }])}
                        className="flex items-center gap-0.5 text-xs text-blue-600 hover:text-blue-800">
                        <Plus className="w-3 h-3" /> Agregar
                      </button>
                    </div>
                    {actionResponse.length === 0 && (
                      <p className="text-xs text-slate-400 italic">Sin mapeo. Selecciona un endpoint del catálogo o haz click en &quot;+ Agregar&quot;.</p>
                    )}
                    <div className="space-y-1.5">
                      {actionResponse.map((row, i) => (
                        <div key={i} className="flex gap-2 items-center">
                          <input value={row.key} onChange={(e) => setActionResponse((r) => r.map((x, j) => j === i ? { ...x, key: e.target.value } : x))}
                            placeholder="campo_respuesta"
                            className="w-36 rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-blue-500" />
                          <span className="text-slate-400 text-xs shrink-0">→</span>
                          <input list="waba-var-suggestions" value={row.value} onChange={(e) => setActionResponse((r) => r.map((x, j) => j === i ? { ...x, value: e.target.value } : x))}
                            placeholder="variables.saldo"
                            className="flex-1 rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-blue-500" />
                          <button onClick={() => setActionResponse((r) => r.filter((_, j) => j !== i))}
                            className="text-red-400 hover:text-red-600 shrink-0"><Trash2 className="w-3.5 h-3.5" /></button>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Next + Branches */}
          <div className="grid grid-cols-2 gap-3 pt-2 border-t border-slate-100">
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Siguiente nodo (next)</label>
              <select value={next} onChange={(e) => setNext(e.target.value)}
                className="w-full rounded-lg border border-slate-200 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                <option value="">— ninguno —</option>
                {allNodeIds.filter((nid) => nid !== id).map((nid) => (
                  <option key={nid} value={nid}>{nid}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Branches (JSON)</label>
              <textarea value={branchesJson} onChange={(e) => setBranchesJson(e.target.value)} rows={2}
                className="w-full rounded-xl border border-slate-200 px-3 py-1.5 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
          </div>

          {err && <p className="text-sm text-red-600">{err}</p>}
        </div>
        <div className="px-6 py-4 border-t border-slate-100 flex justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2 text-sm text-slate-600 hover:text-slate-800">Cancelar</button>
          <button onClick={handleSave}
            disabled={type === "menu" && !showJson && hasMenuValidationErrors}
            className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed">
            Guardar nodo
          </button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-component: FlowBuilder (full editor for a flow)
// ─────────────────────────────────────────────────────────────────────────────
function FlowBuilder({
  flow,
  onBack,
  onRefresh,
}: {
  flow: WabaFlow;
  onBack: () => void;
  onRefresh: () => void;
}) {
  const [activeVersion, setActiveVersion] = useState<(FlowVersion & { definition?: FlowDefinition }) | null>(null);
  const [definition, setDefinition] = useState<FlowDefinition | null>(null);
  const [editingNode, setEditingNode] = useState<Partial<NodeDef> | null>(null);
  const [jsonView, setJsonView] = useState(false);
  const [jsonText, setJsonText] = useState("");
  const [jsonError, setJsonError] = useState("");
  const [saving, setSaving] = useState(false);
  const [validating, setValidating] = useState(false);
  const [validation, setValidation] = useState<{ internal: { valid: boolean; errors: string[]; warnings: string[] }; waba: { valid: boolean; errors: string[] } } | null>(null);
  const [changelog, setChangelog] = useState("");
  const [integrations, setIntegrations] = useState<{ id: number; nombre: string; tipo: string }[]>([]);
  const [catalogEndpoints, setCatalogEndpoints] = useState<CatalogEndpoint[]>([]);
  const [flowVariables, setFlowVariables] = useState<string[]>([]);
  const validationErrors = validation?.internal?.errors ?? [];
  const validationWarnings = validation?.internal?.warnings ?? [];
  const wabaValidationErrors = validation?.waba?.errors ?? [];

  const loadLatestVersion = useCallback(async () => {
    try {
      const { data } = await wabaFlowsApi.listVersions(flow.id);
      const versions = Array.isArray(data)
        ? data
        : Array.isArray((data as { versions?: FlowVersion[] })?.versions)
          ? (data as { versions: FlowVersion[] }).versions
          : [];
      if (!versions.length) return;
      const latest = versions[0];
      const { data: vd } = await wabaFlowsApi.getVersion(flow.id, latest.id);
      setActiveVersion({ ...latest, definition: vd.definition });
      setDefinition(vd.definition);
      setJsonText(JSON.stringify(vd.definition, null, 2));
    } catch { /* ignore */ }
  }, [flow.id]);

  useEffect(() => {
    loadLatestVersion();
    integrationsApi
      .list({ activo: true })
      .then(({ data }) => {
        const normalized = Array.isArray(data)
          ? data
          : Array.isArray((data as { integrations?: { id: number; nombre: string; tipo: string }[] })?.integrations)
            ? (data as { integrations: { id: number; nombre: string; tipo: string }[] }).integrations
            : [];
        setIntegrations(normalized);
      })
      .catch(() => setIntegrations([]));
    integrationsApi.getCatalog()
      .then(({ data }) => {
        const d = data as { data?: { endpoints?: CatalogEndpoint[] } | CatalogEndpoint[]; endpoints?: CatalogEndpoint[] } | CatalogEndpoint[];
        const eps = Array.isArray(d) ? d
          : Array.isArray((d as { data?: { endpoints?: CatalogEndpoint[] } | CatalogEndpoint[] }).data)
            ? (d as { data: CatalogEndpoint[] }).data
          : Array.isArray(((d as { data?: { endpoints?: CatalogEndpoint[] } }).data as { endpoints?: CatalogEndpoint[] } | undefined)?.endpoints)
            ? (((d as { data?: { endpoints?: CatalogEndpoint[] } }).data as { endpoints: CatalogEndpoint[] }).endpoints)
          : Array.isArray((d as { endpoints?: CatalogEndpoint[] }).endpoints) ? (d as { endpoints: CatalogEndpoint[] }).endpoints
          : [];
        setCatalogEndpoints(eps);
      })
      .catch(() => setCatalogEndpoints([]));
    variablesApi.list()
      .then(({ data }) => {
        const vars = Array.isArray(data) ? data : [];
        setFlowVariables(vars.map((v: { nombre: string }) => `variables.${v.nombre}`));
      })
      .catch(() => setFlowVariables([]));
  }, [loadLatestVersion]);

  function handleAddNode() {
    const ids = definition?.nodes.map((n) => n.id) ?? [];
    const nextId = `node_${ids.length + 1}`;
    setEditingNode({ id: nextId, type: "message", config: { text: "" }, next: null, branches: {} });
  }

  function handleSaveNode(node: NodeDef) {
    setDefinition((prev) => {
      if (!prev) return prev;
      const idx = prev.nodes.findIndex((n) => n.id === node.id);
      const nodes = idx >= 0
        ? prev.nodes.map((n, i) => (i === idx ? node : n))
        : [...prev.nodes, node];
      const newDef = { ...prev, nodes };
      if (!newDef.entry_point && nodes.length === 1) newDef.entry_point = node.id;
      setJsonText(JSON.stringify(newDef, null, 2));
      return newDef;
    });
    setEditingNode(null);
  }

  function handleDeleteNode(id: string) {
    setDefinition((prev) => {
      if (!prev) return prev;
      const nodes = prev.nodes.filter((n) => n.id !== id);
      const newDef = { ...prev, nodes };
      setJsonText(JSON.stringify(newDef, null, 2));
      return newDef;
    });
  }

  function handleMoveNode(id: string, direction: -1 | 1) {
    setDefinition((prev) => {
      if (!prev) return prev;
      const idx = prev.nodes.findIndex((n) => n.id === id);
      if (idx < 0) return prev;
      const nextIdx = idx + direction;
      if (nextIdx < 0 || nextIdx >= prev.nodes.length) return prev;

      const nodes = [...prev.nodes];
      const [moved] = nodes.splice(idx, 1);
      nodes.splice(nextIdx, 0, moved);

      const newDef = { ...prev, nodes };
      setJsonText(JSON.stringify(newDef, null, 2));
      return newDef;
    });
  }

  function handleEntryPointChange(id: string) {
    setDefinition((prev) => {
      if (!prev) return prev;
      const newDef = { ...prev, entry_point: id };
      setJsonText(JSON.stringify(newDef, null, 2));
      return newDef;
    });
  }

  function handleJsonApply() {
    try {
      const parsed = JSON.parse(jsonText) as FlowDefinition;
      setDefinition(parsed);
      setJsonError("");
    } catch {
      setJsonError("JSON inválido");
    }
  }

  async function handleValidate() {
    if (!definition) return;
    setValidating(true);
    try {
      const { data } = await wabaFlowsApi.validate(flow.id, { definition });
      setValidation({
        internal: {
          valid: Boolean(data?.internal?.valid),
          errors: Array.isArray(data?.internal?.errors) ? data.internal.errors : [],
          warnings: Array.isArray(data?.internal?.warnings) ? data.internal.warnings : [],
        },
        waba: {
          valid: Boolean(data?.waba?.valid),
          errors: Array.isArray(data?.waba?.errors) ? data.waba.errors : [],
        },
      });
    } catch { /* ignore */ } finally { setValidating(false); }
  }

  async function handleSaveVersion() {
    if (!definition) return;
    setSaving(true);
    try {
      await wabaFlowsApi.saveVersion(flow.id, {
        definition,
        changelog: changelog || undefined,
      });
      setChangelog("");
      await loadLatestVersion();
      onRefresh();
    } catch { /* ignore */ } finally { setSaving(false); }
  }

  async function handleExport() {
    const { data } = await wabaFlowsApi.export(flow.id);
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${flow.nombre.replace(/\s+/g, "_")}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="flex flex-col h-full gap-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button onClick={onBack} className="text-slate-400 hover:text-slate-700">
            <ChevronRight className="w-5 h-5 rotate-180" />
          </button>
          <h2 className="text-lg font-semibold text-slate-800">{flow.nombre}</h2>
          {activeVersion && (
            <span className="text-xs text-slate-500">v{activeVersion.versionNumber}</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setJsonView((v) => !v)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium border transition ${
              jsonView ? "bg-slate-800 text-white border-slate-700" : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50"
            }`}
          >
            <FileJson className="w-3.5 h-3.5" />
            {jsonView ? "Vista visual" : "JSON"}
          </button>
          <button
            onClick={handleValidate}
            disabled={validating}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium bg-amber-50 text-amber-700 hover:bg-amber-100 border border-amber-200"
          >
            {validating ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5" />}
            Validar
          </button>
          <button
            onClick={handleExport}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium bg-blue-50 text-blue-700 hover:bg-blue-100 border border-blue-200"
          >
            <Download className="w-3.5 h-3.5" />
            Exportar
          </button>
        </div>
      </div>

      {/* Validation results */}
      {validation && (
        <div className={`rounded-xl border px-4 py-3 text-sm ${validation.internal.valid ? "bg-green-50 border-green-200" : "bg-red-50 border-red-200"}`}>
          <div className="flex items-center gap-2 font-medium mb-1">
            {validation.internal.valid
              ? <CheckCircle2 className="w-4 h-4 text-green-600" />
              : <XCircle className="w-4 h-4 text-red-600" />}
            <span className={validation.internal.valid ? "text-green-700" : "text-red-700"}>
              {validation.internal.valid ? "Flujo válido" : `${validationErrors.length} error(es) encontrados`}
            </span>
          </div>
          {validationErrors.map((e, i) => (
            <p key={i} className="text-red-600 text-xs ml-6">• {e}</p>
          ))}
          {validationWarnings.map((w, i) => (
            <p key={i} className="text-amber-600 text-xs ml-6">⚠ {w}</p>
          ))}
          {!validation.waba.valid && wabaValidationErrors.map((e, i) => (
            <p key={i} className="text-orange-600 text-xs ml-6">WABA: {e}</p>
          ))}
        </div>
      )}

      <div className="flex gap-4 flex-1 min-h-0">
        {/* Node list / JSON editor */}
        <div className="flex-1 flex flex-col min-h-0">
          {jsonView ? (
            <div className="flex flex-col flex-1 gap-2">
              <textarea
                value={jsonText}
                onChange={(e) => setJsonText(e.target.value)}
                className="flex-1 rounded-xl border border-slate-200 px-4 py-3 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
              />
              {jsonError && <p className="text-red-600 text-xs">{jsonError}</p>}
              <button
                onClick={handleJsonApply}
                className="self-end px-4 py-2 rounded-xl bg-slate-800 text-white text-sm font-medium hover:bg-slate-700"
              >
                Aplicar JSON
              </button>
            </div>
          ) : (
            <div className="flex flex-col flex-1 gap-3 overflow-y-auto pr-1">
              {definition?.nodes.length === 0 && (
                <div className="flex flex-col items-center justify-center py-12 text-slate-400 gap-3 border-2 border-dashed border-slate-200 rounded-2xl">
                  <Layers className="w-10 h-10" />
                  <p className="text-sm">No hay nodos todavía</p>
                  <button
                    onClick={handleAddNode}
                    className="text-sm text-blue-600 hover:underline"
                  >Añadir primer nodo</button>
                </div>
              )}
              {definition?.nodes.map((node, index) => (
                <NodeCard
                  key={node.id}
                  node={node}
                  isEntry={node.id === definition.entry_point}
                  canMoveUp={index > 0}
                  canMoveDown={index < definition.nodes.length - 1}
                  onMoveUp={(id) => handleMoveNode(id, -1)}
                  onMoveDown={(id) => handleMoveNode(id, 1)}
                  onEdit={(n) => setEditingNode(n)}
                  onDelete={handleDeleteNode}
                />
              ))}
              {(definition?.nodes.length ?? 0) > 0 && (
                <button
                  onClick={handleAddNode}
                  className="flex items-center justify-center gap-2 py-3 rounded-xl border-2 border-dashed border-slate-200 text-sm text-slate-400 hover:border-blue-300 hover:text-blue-500 transition"
                >
                  <Plus className="w-4 h-4" />
                  Añadir nodo
                </button>
              )}
            </div>
          )}
        </div>

        {/* Sidebar: entry point + save version */}
        <div className="w-64 flex flex-col gap-4 shrink-0">
          {/* Entry point selector */}
          <div className="bg-slate-50 rounded-2xl p-4 border border-slate-100">
            <label className="block text-xs font-medium text-slate-600 mb-2">Punto de entrada</label>
            <select
              value={definition?.entry_point ?? ""}
              onChange={(e) => handleEntryPointChange(e.target.value)}
              className="w-full rounded-xl border border-slate-200 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {definition?.nodes.map((n) => (
                <option key={n.id} value={n.id}>{n.id} ({n.type})</option>
              ))}
            </select>
          </div>

          {/* Save new version */}
          <div className="bg-slate-50 rounded-2xl p-4 border border-slate-100 space-y-3">
            <p className="text-xs font-medium text-slate-600">Guardar versión</p>
            <input
              value={changelog}
              onChange={(e) => setChangelog(e.target.value)}
              placeholder="Descripción del cambio..."
              className="w-full rounded-xl border border-slate-200 px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <button
              onClick={handleSaveVersion}
              disabled={saving || !definition}
              className="w-full flex items-center justify-center gap-2 py-2 rounded-xl bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
            >
              {saving ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Layers className="w-4 h-4" />}
              Guardar versión
            </button>
          </div>

          {/* Quick stats */}
          {definition && (
            <div className="bg-slate-50 rounded-2xl p-4 border border-slate-100 space-y-2">
              <p className="text-xs font-medium text-slate-600">Estadísticas</p>
              <div className="space-y-1 text-xs text-slate-500">
                <div className="flex justify-between"><span>Nodos totales</span><span className="font-medium text-slate-700">{definition.nodes.length}</span></div>
                <div className="flex justify-between"><span>Acción</span><span className="font-medium text-slate-700">{definition.nodes.filter((n) => n.type === "action").length}</span></div>
                <div className="flex justify-between"><span>Condición</span><span className="font-medium text-slate-700">{definition.nodes.filter((n) => n.type === "condition").length}</span></div>
                <div className="flex justify-between"><span>Fin</span><span className="font-medium text-slate-700">{definition.nodes.filter((n) => n.type === "end").length}</span></div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Node edit modal */}
      {editingNode && (
        <NodeEditModal
          node={editingNode}
          allNodeIds={definition?.nodes.map((n) => n.id) ?? []}
          catalogEndpoints={catalogEndpoints}
          flowVariables={flowVariables}
          integrations={integrations}
          onSave={handleSaveNode}
          onClose={() => setEditingNode(null)}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-component: VersionsPanel
// ─────────────────────────────────────────────────────────────────────────────
function VersionsPanel({ flow, onRefresh }: { flow: WabaFlow; onRefresh: () => void }) {
  const [versions, setVersions] = useState<FlowVersion[]>([]);
  const [loading, setLoading]   = useState(true);
  const [publishing, setPublishing] = useState<number | null>(null);
  const [rollingBack, setRollingBack] = useState<number | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await wabaFlowsApi.listVersions(flow.id);
      const normalized = Array.isArray(data)
        ? data
        : Array.isArray((data as { versions?: FlowVersion[] })?.versions)
          ? ((data as { versions: FlowVersion[] }).versions)
          : [];
      setVersions(normalized);
    } finally { setLoading(false); }
  }, [flow.id]);

  useEffect(() => { reload(); }, [reload]);

  async function togglePublish(v: FlowVersion) {
    setPublishing(v.id);
    try {
      await wabaFlowsApi.publishVersion(flow.id, v.id, !v.published);
      await reload();
      onRefresh();
    } finally { setPublishing(null); }
  }

  async function rollback(v: FlowVersion) {
    setRollingBack(v.id);
    try {
      await wabaFlowsApi.rollback(flow.id, v.id);
      await reload();
      onRefresh();
    } finally { setRollingBack(null); }
  }

  if (loading) return <div className="flex items-center justify-center py-12"><RefreshCw className="w-6 h-6 animate-spin text-slate-400" /></div>;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-slate-700">Historial de versiones — {flow.nombre}</h3>
        <button onClick={reload} className="text-slate-400 hover:text-slate-600"><RefreshCw className="w-4 h-4" /></button>
      </div>
      {versions.length === 0 && (
        <div className="text-center py-10 text-slate-400 text-sm">Sin versiones guardadas</div>
      )}
      {versions.map((v) => (
        <div key={v.id} className="flex items-center justify-between gap-4 p-4 bg-white rounded-2xl border border-slate-200 hover:border-slate-300 transition">
          <div className="flex items-start gap-3">
            <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold ${v.published ? "bg-green-100 text-green-700" : "bg-slate-100 text-slate-500"}`}>
              v{v.versionNumber}
            </div>
            <div>
              <p className="text-sm font-medium text-slate-700">{v.changelog ?? `Versión ${v.versionNumber}`}</p>
              <p className="text-xs text-slate-400 mt-0.5">{fmtDate(v.createdAt)}</p>
              {v.published && v.publishedAt && (
                <p className="text-xs text-green-600 mt-0.5">Publicado {fmtDate(v.publishedAt)}</p>
              )}
              {v.wabaValidationErrors && v.wabaValidationErrors.length > 0 && (
                <p className="text-xs text-red-500 mt-0.5">⚠ {v.wabaValidationErrors.length} error(es)</p>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className={`text-xs px-2 py-1 rounded-full ${STATUS_BADGE[v.wabaValidationStatus] ?? STATUS_BADGE.draft}`}>
              {v.wabaValidationStatus}
            </span>
            <button
              onClick={() => rollback(v)}
              disabled={v.published || rollingBack === v.id}
              title="Rollback a esta versión"
              className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-slate-700 disabled:opacity-30"
            >
              {rollingBack === v.id ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />}
            </button>
            <button
              onClick={() => togglePublish(v)}
              disabled={publishing === v.id}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium transition ${
                v.published
                  ? "bg-green-100 text-green-700 hover:bg-green-200"
                  : "bg-slate-100 text-slate-600 hover:bg-slate-200"
              }`}
            >
              {publishing === v.id ? <RefreshCw className="w-3 h-3 animate-spin" /> : null}
              {v.published ? "Publicado" : "Publicar"}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-component: SimulatePanel
// ─────────────────────────────────────────────────────────────────────────────
function SimulatePanel({ flow }: { flow: WabaFlow }) {
  const [inputs, setInputs]     = useState<string[]>([]);
  const [inputVal, setInputVal] = useState("");
  const [trace, setTrace]       = useState<SimulationStep[]>([]);
  const [running, setRunning]   = useState(false);

  async function runSimulation() {
    setRunning(true);
    try {
      const { data } = await wabaFlowsApi.simulate(flow.id, { inputs });
      setTrace(Array.isArray(data?.trace) ? data.trace : []);
    } catch { /* ignore */ } finally { setRunning(false); }
  }

  function addInput() {
    if (inputVal.trim()) {
      setInputs((prev) => [...prev, inputVal.trim()]);
      setInputVal("");
    }
  }

  return (
    <div className="space-y-4">
      <h3 className="font-semibold text-slate-700">Testing Sandbox — {flow.nombre}</h3>

      {/* Input sequence builder */}
      <div className="bg-slate-50 rounded-2xl p-4 border border-slate-100 space-y-3">
        <p className="text-xs font-medium text-slate-600">Secuencia de entradas del usuario</p>
        <div className="flex gap-2">
          <input
            value={inputVal}
            onChange={(e) => setInputVal(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addInput()}
            placeholder="Respuesta del usuario..."
            className="flex-1 rounded-xl border border-slate-200 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <button
            onClick={addInput}
            className="px-3 py-1.5 rounded-xl bg-blue-100 text-blue-700 text-sm hover:bg-blue-200"
          >
            <Plus className="w-4 h-4" />
          </button>
        </div>
        {inputs.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {inputs.map((inp, i) => (
              <div key={i} className="flex items-center gap-1 bg-white border border-slate-200 rounded-lg px-2.5 py-1 text-xs">
                <span className="text-slate-500 font-mono">[{i}]</span>
                <span>{inp}</span>
                <button onClick={() => setInputs((prev) => prev.filter((_, j) => j !== i))} className="text-slate-300 hover:text-red-500 ml-1">
                  <X className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>
        )}
        <button
          onClick={runSimulation}
          disabled={running}
          className="flex items-center gap-2 px-4 py-2 rounded-xl bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
        >
          {running ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
          Ejecutar simulación
        </button>
      </div>

      {/* Trace */}
      {trace.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">Traza de ejecución ({trace.length} pasos)</p>
          {trace.map((step, i) => (
            <div key={i} className={`rounded-xl border p-3 text-sm ${step.error ? "border-red-200 bg-red-50" : "border-slate-200 bg-white"}`}>
              {step.error ? (
                <p className="text-red-600 text-xs">{step.error}</p>
              ) : (
                <div className="flex items-start gap-3">
                  <span className="w-6 h-6 rounded-full bg-slate-100 text-xs font-bold flex items-center justify-center text-slate-600 shrink-0">
                    {i + 1}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-mono text-xs text-slate-500">{step.nodeId}</span>
                      <span className={`text-xs px-1.5 py-0.5 rounded ${NODE_TYPE_COLOR[step.nodeType ?? ""] ?? "bg-slate-100 text-slate-600"}`}>
                        {step.nodeType}
                      </span>
                    </div>
                    {step.input !== null && step.input !== undefined && (
                      <p className="text-xs text-blue-600">↳ Input: <span className="font-medium">"{step.input}"</span></p>
                    )}
                    {step.output && (
                      <div className="text-xs text-slate-600 mt-1">
                        {(step.output as { text?: string }).text && <p>{(step.output as { text: string }).text}</p>}
                        {(step.output as { type?: string }).type === "buttons" && Array.isArray((step.output as { options?: { title: string }[] }).options) && (
                          <div className="flex flex-wrap gap-1 mt-1">
                            {((step.output as { options: { title: string }[] }).options).map((o: { title: string }, j: number) => (
                              <span key={j} className="bg-purple-50 text-purple-700 px-2 py-0.5 rounded-lg">{o.title}</span>
                            ))}
                          </div>
                        )}
                        {(step.output as { type?: string }).type === "end" && (
                          <span className="text-rose-600 font-medium">✓ Conversación finalizada</span>
                        )}
                        {(step.output as { type?: string }).type === "api_call_simulated" && (
                          <p className="font-mono text-green-600">{(step.output as { method?: string; endpoint?: string }).method} {(step.output as { endpoint?: string }).endpoint}</p>
                        )}
                      </div>
                    )}
                    {step.waiting_for_input && (
                      <p className="text-amber-600 text-xs mt-1">⏸ Esperando entrada del usuario</p>
                    )}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main page
// ─────────────────────────────────────────────────────────────────────────────
export default function WabaFlujos() {
  const { tenantSlug } = useAuthStore();
  const [flows, setFlows]           = useState<WabaFlow[]>([]);
  const [loading, setLoading]       = useState(true);
  const [tab, setTab]               = useState<TabKey>("list");
  const [selectedFlow, setSelectedFlow] = useState<WabaFlow | null>(null);
  const [showImport, setShowImport] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [importLogs, setImportLogs] = useState<unknown[]>([]);
  const [logsLoading, setLogsLoading] = useState(false);

  const loadFlows = useCallback(async () => {
    if (!tenantSlug) {
      setFlows([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const { data } = await wabaFlowsApi.list({ activo: true, tenantSlug });
      const normalized = Array.isArray(data?.flows)
        ? data.flows
        : Array.isArray(data)
          ? data
          : [];
      setFlows(normalized);
    } finally { setLoading(false); }
  }, [tenantSlug]);

  const loadImportLogs = useCallback(async () => {
    if (!tenantSlug) {
      setImportLogs([]);
      setLogsLoading(false);
      return;
    }
    setLogsLoading(true);
    try {
      const { data } = await wabaFlowsApi.importLogs({ tenantSlug });
      const normalized = Array.isArray(data)
        ? data
        : Array.isArray((data as { logs?: unknown[] })?.logs)
          ? (data as { logs: unknown[] }).logs
          : [];
      setImportLogs(normalized);
    } finally { setLogsLoading(false); }
  }, [tenantSlug]);

  const safeFlows = Array.isArray(flows) ? flows : [];
  const safeImportLogs = Array.isArray(importLogs) ? importLogs : [];

  useEffect(() => { loadFlows(); }, [loadFlows]);

  useEffect(() => {
    if (tab === "import-logs") loadImportLogs();
  }, [tab, loadImportLogs]);

  async function handleDelete(id: number) {
    if (!confirm("¿Desactivar este flujo?")) return;
    await wabaFlowsApi.remove(id);
    loadFlows();
  }

  function openFlow(flow: WabaFlow, dest: "builder" | "versions" | "simulate") {
    setSelectedFlow(flow);
    setTab(dest);
  }

  // ── Render tabs when a flow is selected ────────────────────────────────────
  if (selectedFlow && (tab === "builder" || tab === "versions" || tab === "simulate")) {
    return (
      <div className="p-6 h-full flex flex-col gap-4">
        {/* Sub-tab bar */}
        <div className="flex items-center gap-1 bg-slate-100 rounded-xl p-1 w-fit">
          {(["builder", "versions", "simulate"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-4 py-1.5 rounded-lg text-sm font-medium transition ${
                tab === t ? "bg-white text-slate-800 shadow-sm" : "text-slate-500 hover:text-slate-700"
              }`}
            >
              {t === "builder" ? "Editor" : t === "versions" ? "Versiones" : "Sandbox"}
            </button>
          ))}
          <button
            onClick={() => { setSelectedFlow(null); setTab("list"); loadFlows(); }}
            className="px-3 py-1.5 text-slate-400 hover:text-slate-600"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {tab === "builder" && (
          <FlowBuilder
            flow={selectedFlow}
            onBack={() => { setSelectedFlow(null); setTab("list"); }}
            onRefresh={loadFlows}
          />
        )}
        {tab === "versions" && <VersionsPanel flow={selectedFlow} onRefresh={loadFlows} />}
        {tab === "simulate" && <SimulatePanel flow={selectedFlow} />}
      </div>
    );
  }

  // ── Main list view ─────────────────────────────────────────────────────────
  return (
    <div className="p-6 space-y-6">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-2xl bg-blue-600 flex items-center justify-center">
            <Webhook className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-slate-900">WABA Flujos</h1>
            <p className="text-sm text-slate-500">Gestión, enriquecimiento y exportación de flujos WhatsApp Business</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={loadFlows}
            className="p-2 rounded-xl hover:bg-slate-100 text-slate-400 hover:text-slate-600"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
          </button>
          <button
            onClick={() => setShowImport(true)}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-slate-800 text-white text-sm font-medium hover:bg-slate-700"
          >
            <Upload className="w-4 h-4" />
            Importar JSON
          </button>
          <button
            onClick={() => setShowCreate(true)}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-blue-600 text-white text-sm font-medium hover:bg-blue-700"
          >
            <Plus className="w-4 h-4" />
            Nuevo flujo
          </button>
        </div>
      </div>

      {!tenantSlug && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          Selecciona un tenant en el encabezado para listar o importar flujos WABA.
        </div>
      )}

      {/* Tab bar */}
      <div className="flex items-center gap-1 bg-slate-100 rounded-xl p-1 w-fit">
        {(["list", "import-logs"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-1.5 rounded-lg text-sm font-medium transition ${
              tab === t ? "bg-white text-slate-800 shadow-sm" : "text-slate-500 hover:text-slate-700"
            }`}
          >
            {t === "list" ? "Flujos" : "Historial importaciones"}
          </button>
        ))}
      </div>

      {/* FLOWS LIST */}
      {tab === "list" && (
        <>
          {loading && (
            <div className="flex justify-center py-12">
              <RefreshCw className="w-6 h-6 animate-spin text-slate-400" />
            </div>
          )}
          {!loading && flows.length === 0 && (
            <div className="flex flex-col items-center justify-center py-16 text-slate-400 gap-4 bg-slate-50 rounded-3xl border-2 border-dashed border-slate-200">
              <Webhook className="w-12 h-12" />
              <p className="text-sm font-medium">No hay flujos WABA todavía</p>
              <p className="text-xs text-slate-400">Importa un JSON de WABA o crea uno nuevo desde cero</p>
              <div className="flex gap-3">
                <button
                  onClick={() => setShowImport(true)}
                  className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-slate-800 text-white text-sm font-medium hover:bg-slate-700"
                >
                  <Upload className="w-4 h-4" /> Importar JSON
                </button>
                <button
                  onClick={() => setShowCreate(true)}
                  className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-blue-600 text-white text-sm font-medium hover:bg-blue-700"
                >
                  <Plus className="w-4 h-4" /> Nuevo flujo
                </button>
              </div>
            </div>
          )}

          {!loading && safeFlows.length > 0 && (
            <div className="grid gap-4">
              {safeFlows.map((flow) => {
                const latestVersion = flow.flowVersions?.[0];
                const isPublished = latestVersion?.published ?? false;
                const valStatus = latestVersion?.wabaValidationStatus ?? "draft";

                return (
                  <div
                    key={flow.id}
                    className="bg-white rounded-2xl border border-slate-200 hover:border-slate-300 p-5 transition group"
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex items-start gap-4 flex-1 min-w-0">
                        <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-blue-500 to-violet-500 flex items-center justify-center shrink-0">
                          <FileJson className="w-5 h-5 text-white" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <h3 className="font-semibold text-slate-800">{flow.nombre}</h3>
                            <span className="text-xs text-slate-400 font-mono">#{flow.id}</span>
                            {isPublished && (
                              <span className="text-xs font-medium text-green-700 bg-green-50 px-2 py-0.5 rounded-full flex items-center gap-1">
                                <CheckCircle2 className="w-3 h-3" /> Live
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-3 mt-1.5 flex-wrap">
                            <span className={`text-xs px-2 py-0.5 rounded-full ${STATUS_BADGE[valStatus]}`}>
                              {valStatus}
                            </span>
                            {latestVersion && (
                              <span className="text-xs text-slate-400">
                                v{latestVersion.versionNumber} · {fmtDate(latestVersion.createdAt)}
                              </span>
                            )}
                            <span className="text-xs text-slate-400">
                              {flow._count?.flowVersions ?? 0} versiones · {flow._count?.executions ?? 0} ejecuciones
                            </span>
                          </div>
                          {latestVersion?.wabaValidationErrors && latestVersion.wabaValidationErrors.length > 0 && (
                            <div className="mt-2 flex items-center gap-1 text-xs text-red-500">
                              <AlertTriangle className="w-3 h-3" />
                              {latestVersion.wabaValidationErrors.length} error(es) de validación
                            </div>
                          )}
                        </div>
                      </div>

                      {/* Actions */}
                      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button
                          onClick={() => openFlow(flow, "builder")}
                          title="Editor"
                          className="p-2 rounded-xl hover:bg-blue-50 text-slate-400 hover:text-blue-600"
                        >
                          <Edit3 className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => openFlow(flow, "versions")}
                          title="Historial"
                          className="p-2 rounded-xl hover:bg-purple-50 text-slate-400 hover:text-purple-600"
                        >
                          <History className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => openFlow(flow, "simulate")}
                          title="Sandbox"
                          className="p-2 rounded-xl hover:bg-green-50 text-slate-400 hover:text-green-600"
                        >
                          <Play className="w-4 h-4" />
                        </button>
                        <button
                          onClick={async () => {
                            const { data } = await wabaFlowsApi.export(flow.id);
                            const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
                            const url = URL.createObjectURL(blob);
                            const a = document.createElement("a");
                            a.href = url;
                            a.download = `${flow.nombre.replace(/\s+/g, "_")}.json`;
                            a.click();
                            URL.revokeObjectURL(url);
                          }}
                          title="Exportar WABA JSON"
                          className="p-2 rounded-xl hover:bg-amber-50 text-slate-400 hover:text-amber-600"
                        >
                          <Download className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => handleDelete(flow.id)}
                          title="Desactivar"
                          className="p-2 rounded-xl hover:bg-red-50 text-slate-400 hover:text-red-600"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>

                      {/* Always-visible quick actions */}
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => openFlow(flow, "builder")}
                          className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-blue-50 text-blue-700 text-xs font-medium hover:bg-blue-100"
                        >
                          <Edit3 className="w-3.5 h-3.5" /> Editar
                        </button>
                        <button
                          onClick={() => openFlow(flow, "simulate")}
                          className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-green-50 text-green-700 text-xs font-medium hover:bg-green-100"
                        >
                          <Play className="w-3.5 h-3.5" /> Probar
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {/* IMPORT LOGS */}
      {tab === "import-logs" && (
        <div className="space-y-3">
          {logsLoading && <div className="flex justify-center py-8"><RefreshCw className="w-6 h-6 animate-spin text-slate-400" /></div>}
          {!logsLoading && safeImportLogs.length === 0 && (
            <div className="text-center py-10 text-slate-400 text-sm">Sin registros de importación</div>
          )}
          {(safeImportLogs as Array<{ id: number; flowId?: number; source: string; parsedNodes: number; status: string; createdAt: string; validationErrors?: string[] }>).map((log) => (
            <div key={log.id} className="bg-white rounded-2xl border border-slate-200 p-4 flex items-center justify-between gap-4">
              <div className="flex items-start gap-3">
                <div className={`w-8 h-8 rounded-xl flex items-center justify-center text-xs font-bold ${
                  log.status === "validated" ? "bg-green-100 text-green-700"
                  : log.status === "failed" ? "bg-red-100 text-red-700"
                  : "bg-slate-100 text-slate-600"
                }`}>
                  {log.status === "validated" ? <CheckCircle2 className="w-4 h-4" /> : <Upload className="w-4 h-4" />}
                </div>
                <div>
                  <p className="text-sm font-medium text-slate-700">
                    Flujo #{log.flowId ?? "—"} — {log.parsedNodes} nodos — <span className="text-slate-500">{log.source}</span>
                  </p>
                  <p className="text-xs text-slate-400">{fmtDate(log.createdAt)}</p>
                  {log.validationErrors && log.validationErrors.length > 0 && (
                    <p className="text-xs text-red-500 mt-0.5">{log.validationErrors.slice(0, 2).join(", ")}</p>
                  )}
                </div>
              </div>
              <span className={`text-xs px-2.5 py-1 rounded-full ${
                log.status === "validated" ? "bg-green-50 text-green-700"
                : log.status === "failed" ? "bg-red-50 text-red-700"
                : "bg-slate-100 text-slate-600"
              }`}>
                {log.status}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Modals */}
      {showImport && (
        <ImportModal
          tenantSlug={tenantSlug}
          onClose={() => setShowImport(false)}
          onImported={() => { setShowImport(false); loadFlows(); }}
        />
      )}
      {showCreate && (
        <CreateFlowModal
          tenantSlug={tenantSlug}
          onClose={() => setShowCreate(false)}
          onCreated={loadFlows}
        />
      )}
    </div>
  );
}
