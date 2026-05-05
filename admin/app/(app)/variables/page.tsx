"use client";

import { useEffect, useState } from "react";
import {
  Plus,
  Trash2,
  Edit3,
  RefreshCw,
  Variable,
  Search,
  Globe,
  Layers,
  Timer,
} from "lucide-react";
import { variablesApi, flowsApi } from "@/lib/api";
import { useAuthStore } from "@/store/auth";

interface FlowVariable {
  id: number;
  nombre: string;
  tipo: string;
  valorDefault: unknown;
  descripcion?: string;
  scope: string;
  flowId?: number;
  flow?: { nombre: string };
  createdAt: string;
  updatedAt: string;
}

interface FlowOption {
  id: number;
  nombre: string;
}

const SCOPES = ["global", "flow", "session"] as const;
const TIPOS = ["string", "number", "boolean", "object", "array"] as const;

const SCOPE_CONFIG = {
  global: { label: "Global", color: "bg-blue-100 text-blue-700", icon: Globe },
  flow: { label: "Flow", color: "bg-purple-100 text-purple-700", icon: Layers },
  session: { label: "Session", color: "bg-amber-100 text-amber-700", icon: Timer },
};

// ─────────────────────────────────────────────────────────────────────────────
// Variable Modal
// ─────────────────────────────────────────────────────────────────────────────
function VariableModal({
  initial,
  flows,
  onClose,
  onSaved,
}: {
  initial?: FlowVariable;
  flows: FlowOption[];
  onClose: () => void;
  onSaved: (v: FlowVariable) => void;
}) {
  const [nombre, setNombre] = useState(initial?.nombre ?? "");
  const [tipo, setTipo] = useState(initial?.tipo ?? "string");
  const [scope, setScope] = useState(initial?.scope ?? "global");
  const [flowId, setFlowId] = useState<string>(initial?.flowId?.toString() ?? "");
  const [valorDefault, setValorDefault] = useState(
    initial?.valorDefault != null ? JSON.stringify(initial.valorDefault) : ""
  );
  const [descripcion, setDescripcion] = useState(initial?.descripcion ?? "");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSave() {
    if (!nombre.trim()) return setError("Name is required");
    let parsedDefault: unknown = null;
    if (valorDefault.trim()) {
      try { parsedDefault = JSON.parse(valorDefault); } catch { parsedDefault = valorDefault; }
    }
    const payload = {
      nombre: nombre.trim(),
      tipo,
      scope,
      valorDefault: parsedDefault,
      descripcion: descripcion || undefined,
      flowId: flowId ? Number(flowId) : undefined,
    };
    setError("");
    setLoading(true);
    try {
      let res;
      if (initial) {
        res = await variablesApi.update(initial.id, payload);
      } else {
        res = await variablesApi.create(payload);
      }
      onSaved(res.data);
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { error?: string } } })?.response?.data?.error ?? "Save failed";
      setError(msg);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md flex flex-col gap-4 p-6">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-900">
            {initial ? "Edit Variable" : "New Variable"}
          </h2>
          <button onClick={onClose} className="text-slate-400 text-xl leading-none">×</button>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2">
            <label className="text-xs font-medium text-slate-600 mb-1 block">Name</label>
            <input
              autoFocus
              value={nombre}
              onChange={(e) => setNombre(e.target.value)}
              placeholder="variable_name"
              className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div>
            <label className="text-xs font-medium text-slate-600 mb-1 block">Type</label>
            <select
              value={tipo}
              onChange={(e) => setTipo(e.target.value)}
              className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {TIPOS.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>

          <div>
            <label className="text-xs font-medium text-slate-600 mb-1 block">Scope</label>
            <select
              value={scope}
              onChange={(e) => setScope(e.target.value)}
              className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {SCOPES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>

          {scope === "flow" && (
            <div className="col-span-2">
              <label className="text-xs font-medium text-slate-600 mb-1 block">Flow</label>
              <select
                value={flowId}
                onChange={(e) => setFlowId(e.target.value)}
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="">— Select flow —</option>
                {flows.map((f) => (
                  <option key={f.id} value={f.id}>{f.nombre}</option>
                ))}
              </select>
            </div>
          )}

          <div className="col-span-2">
            <label className="text-xs font-medium text-slate-600 mb-1 block">Default value</label>
            <input
              value={valorDefault}
              onChange={(e) => setValorDefault(e.target.value)}
              placeholder='e.g. "hello", 42, true, {"key": "val"}'
              className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div className="col-span-2">
            <label className="text-xs font-medium text-slate-600 mb-1 block">Description</label>
            <input
              value={descripcion}
              onChange={(e) => setDescripcion(e.target.value)}
              placeholder="Optional description"
              className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
        </div>

        {error && <p className="text-sm text-red-600">{error}</p>}

        <div className="flex justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2 text-sm text-slate-600">Cancel</button>
          <button
            onClick={handleSave}
            disabled={loading}
            className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
          >
            {loading ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Page
// ─────────────────────────────────────────────────────────────────────────────
export default function VariablesPage() {
  const { tenantSlug } = useAuthStore();
  const [variables, setVariables] = useState<FlowVariable[]>([]);
  const [flows, setFlows] = useState<FlowOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<FlowVariable | null>(null);
  const [toDelete, setToDelete] = useState<FlowVariable | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [seeding, setSeeding] = useState(false);
  const [seedMsg, setSeedMsg] = useState("");
  const [search, setSearch] = useState("");
  const [filterScope, setFilterScope] = useState<string>("all");
  const [filterFlowId, setFilterFlowId] = useState<string>("");

  async function load() {
    setLoading(true);
    try {
      const params: Record<string, unknown> = {};
      if (tenantSlug) params.tenantSlug = tenantSlug;
      if (filterScope !== "all") params.scope = filterScope;
      if (filterFlowId) params.flowId = filterFlowId;
      const [varRes, flowRes] = await Promise.all([
        variablesApi.list(params),
        flowsApi.list({ limit: 200 }),
      ]);
      setVariables(varRes.data);
      setFlows(Array.isArray(flowRes.data) ? flowRes.data : (flowRes.data?.data ?? []));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, [filterScope, filterFlowId, tenantSlug]);

  async function handleSeedDefaults() {
    setSeeding(true);
    setSeedMsg("");
    try {
      const res = await variablesApi.seedDefaults(tenantSlug || undefined);
      const { created, skipped } = res.data as { created: number; skipped: number };
      setSeedMsg(`✓ ${created} variables creadas, ${skipped} ya existían`);
      await load();
    } catch {
      setSeedMsg("Error al crear variables predeterminadas");
    } finally {
      setSeeding(false);
      setTimeout(() => setSeedMsg(""), 5000);
    }
  }

  async function handleDelete() {
    if (!toDelete) return;
    setDeleting(true);
    try {
      await variablesApi.remove(toDelete.id);
      setVariables((prev) => prev.filter((v) => v.id !== toDelete.id));
      setToDelete(null);
    } finally {
      setDeleting(false);
    }
  }

  function handleSaved(v: FlowVariable) {
    if (editing) {
      setVariables((prev) => prev.map((x) => x.id === v.id ? v : x));
    } else {
      setVariables((prev) => [v, ...prev]);
    }
    setShowModal(false);
    setEditing(null);
  }

  const filtered = variables.filter((v) =>
    v.nombre.toLowerCase().includes(search.toLowerCase()) ||
    (v.descripcion ?? "").toLowerCase().includes(search.toLowerCase())
  );

  // Group by scope
  const grouped = SCOPES.reduce((acc, s) => {
    acc[s] = filtered.filter((v) => v.scope === s);
    return acc;
  }, {} as Record<string, FlowVariable[]>);

  return (
    <div className="p-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2">
            <Variable className="w-6 h-6 text-purple-600" /> Variables Manager
          </h1>
          <p className="text-sm text-slate-500 mt-0.5">
            {variables.length} variable{variables.length !== 1 ? "s" : ""} · Global, flow-scoped, and session variables
          </p>
        </div>
        <div className="flex items-center gap-2">
          {seedMsg && (
            <span className="text-xs text-green-700 bg-green-50 border border-green-200 rounded-lg px-3 py-1.5">{seedMsg}</span>
          )}
          <button
            onClick={handleSeedDefaults}
            disabled={seeding}
            className="flex items-center gap-2 px-3 py-2 text-sm border border-slate-300 text-slate-700 rounded-lg hover:bg-slate-50 disabled:opacity-50"
            title="Crea las variables estándar del chatbot (conversaciones, solicitudes, agenda, agentes, horarios)"
          >
            {seeding ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Layers className="w-4 h-4" />}
            Cargar predeterminadas
          </button>
          <button onClick={load} className="p-2 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg">
            <RefreshCw className="w-4 h-4" />
          </button>
          <button
            onClick={() => { setEditing(null); setShowModal(true); }}
            className="flex items-center gap-2 px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700"
          >
            <Plus className="w-4 h-4" /> New Variable
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 mb-5 flex-wrap">
        <div className="relative">
          <Search className="absolute left-3 top-2.5 w-4 h-4 text-slate-400" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search variables…"
            className="pl-9 pr-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <select
          value={filterScope}
          onChange={(e) => setFilterScope(e.target.value)}
          className="text-sm border border-slate-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="all">All scopes</option>
          {SCOPES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select
          value={filterFlowId}
          onChange={(e) => setFilterFlowId(e.target.value)}
          className="text-sm border border-slate-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="">All flows</option>
          {flows.map((f) => <option key={f.id} value={f.id}>{f.nombre}</option>)}
        </select>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16 text-slate-400">
          <RefreshCw className="w-5 h-5 animate-spin mr-2" /> Loading…
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-slate-400">
          <Variable className="w-12 h-12 mb-3 opacity-30" />
          <p className="text-sm">No variables found. Create a global or flow-scoped variable.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-6">
          {SCOPES.filter((s) => grouped[s].length > 0 || filterScope === s).map((s) => {
            if (grouped[s].length === 0) return null;
            const cfg = SCOPE_CONFIG[s];
            const Icon = cfg.icon;
            return (
              <div key={s}>
                <div className="flex items-center gap-2 mb-3">
                  <Icon className="w-4 h-4 text-slate-500" />
                  <h2 className="text-sm font-semibold text-slate-700 uppercase tracking-wide">
                    {cfg.label} ({grouped[s].length})
                  </h2>
                </div>
                <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-slate-200 bg-slate-50">
                        <th className="text-left px-4 py-3 text-xs font-semibold text-slate-600">Name</th>
                        <th className="text-left px-4 py-3 text-xs font-semibold text-slate-600">Type</th>
                        <th className="text-left px-4 py-3 text-xs font-semibold text-slate-600">Default</th>
                        {s !== "global" && (
                          <th className="text-left px-4 py-3 text-xs font-semibold text-slate-600">Flow</th>
                        )}
                        <th className="text-left px-4 py-3 text-xs font-semibold text-slate-600">Description</th>
                        <th className="px-4 py-3" />
                      </tr>
                    </thead>
                    <tbody>
                      {grouped[s].map((v) => (
                        <tr key={v.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                          <td className="px-4 py-3 font-mono text-blue-700 font-medium">{v.nombre}</td>
                          <td className="px-4 py-3">
                            <span className="text-xs bg-slate-100 text-slate-600 px-2 py-0.5 rounded-full">{v.tipo}</span>
                          </td>
                          <td className="px-4 py-3 font-mono text-xs text-slate-500 max-w-[150px] truncate">
                            {v.valorDefault != null ? JSON.stringify(v.valorDefault) : <span className="text-slate-300">null</span>}
                          </td>
                          {s !== "global" && (
                            <td className="px-4 py-3 text-xs text-slate-500">
                              {v.flow?.nombre ?? (v.flowId ? `#${v.flowId}` : "—")}
                            </td>
                          )}
                          <td className="px-4 py-3 text-xs text-slate-400 truncate max-w-[200px]">
                            {v.descripcion || "—"}
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-1 justify-end">
                              <button
                                onClick={() => { setEditing(v); setShowModal(true); }}
                                className="p-1.5 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded"
                              >
                                <Edit3 className="w-4 h-4" />
                              </button>
                              <button
                                onClick={() => setToDelete(v)}
                                className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Modals */}
      {showModal && (
        <VariableModal
          initial={editing ?? undefined}
          flows={flows}
          onClose={() => { setShowModal(false); setEditing(null); }}
          onSaved={handleSaved}
        />
      )}

      {toDelete && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-sm p-6 flex flex-col gap-4">
            <h2 className="text-lg font-semibold text-slate-900">Delete variable?</h2>
            <p className="text-sm text-slate-600">
              <strong className="font-mono">{toDelete.nombre}</strong> will be permanently deleted.
            </p>
            <div className="flex justify-end gap-3">
              <button onClick={() => setToDelete(null)} className="px-4 py-2 text-sm text-slate-600">Cancel</button>
              <button
                onClick={handleDelete}
                disabled={deleting}
                className="px-4 py-2 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50"
              >
                {deleting ? "Deleting…" : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
