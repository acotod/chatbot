"use client";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { integrationsApi } from "@/lib/api";
import { useAuthStore } from "@/store/auth";
import { Plus, Trash2, Save, Plug, Globe, ArrowRight, Zap } from "lucide-react";

interface EndpointDef {
  id: string;
  name: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  inputs: string[];
  outputs: string[];
  description?: string;
  /** If true, called at the start of every conversation to populate session variables */
  sessionInit?: boolean;
}

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
const METHOD_COLORS: Record<string, string> = {
  GET: "bg-green-100 text-green-700",
  POST: "bg-blue-100 text-blue-700",
  PUT: "bg-yellow-100 text-yellow-700",
  PATCH: "bg-orange-100 text-orange-700",
  DELETE: "bg-red-100 text-red-700",
};

function emptyEndpoint(): EndpointDef {
  return { id: "", name: "", method: "POST", url: "", inputs: [], outputs: [], description: "", sessionInit: false };
}

function TagInput({
  tags,
  onChange,
  placeholder,
}: {
  tags: string[];
  onChange: (t: string[]) => void;
  placeholder?: string;
}) {
  const [input, setInput] = useState("");
  function add() {
    const v = input.trim();
    if (v && !tags.includes(v)) onChange([...tags, v]);
    setInput("");
  }
  return (
    <div className="flex flex-wrap gap-1 items-center border border-gray-200 rounded-lg px-2 py-1.5 min-h-[36px] focus-within:ring-2 focus-within:ring-blue-400">
      {tags.map(t => (
        <span key={t} className="flex items-center gap-1 bg-blue-50 text-blue-700 text-xs font-mono px-2 py-0.5 rounded-full">
          {t}
          <button type="button" onClick={() => onChange(tags.filter(x => x !== t))} className="hover:text-red-500">×</button>
        </span>
      ))}
      <input
        className="flex-1 min-w-[80px] text-sm outline-none bg-transparent"
        placeholder={placeholder}
        value={input}
        onChange={e => setInput(e.target.value)}
        onKeyDown={e => { if (e.key === "Enter" || e.key === ",") { e.preventDefault(); add(); } }}
        onBlur={add}
      />
    </div>
  );
}

export default function IntegracionesPage() {
  const qc = useQueryClient();
  const { tenantSlug } = useAuthStore();
  const [editing, setEditing] = useState<EndpointDef | null>(null);
  const [editIdx, setEditIdx] = useState<number | null>(null);
  const [saveMsg, setSaveMsg] = useState("");

  const { data, isLoading } = useQuery({
    queryKey: ["endpoint-catalog", tenantSlug ?? "default"],
    queryFn: () => integrationsApi.getCatalog().then(r => r.data),
  });

  const endpoints: EndpointDef[] = (data as { data?: { endpoints?: EndpointDef[] } })?.data?.endpoints ?? [];

  const saveMutation = useMutation({
    mutationFn: (eps: EndpointDef[]) => integrationsApi.saveCatalog(eps),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["endpoint-catalog", tenantSlug ?? "default"] });
      qc.invalidateQueries({ queryKey: ["endpoints-catalog"] });
      setSaveMsg("Guardado ✓");
      setTimeout(() => setSaveMsg(""), 3000);
    },
  });

  function openNew() {
    setEditing(emptyEndpoint());
    setEditIdx(null);
  }

  function openEdit(ep: EndpointDef, idx: number) {
    setEditing({ ...ep });
    setEditIdx(idx);
  }

  function saveEndpoint() {
    if (!editing) return;
    const updated = [...endpoints];
    if (editIdx !== null) {
      updated[editIdx] = editing;
    } else {
      updated.push(editing);
    }
    saveMutation.mutate(updated);
    setEditing(null);
    setEditIdx(null);
  }

  function deleteEndpoint(idx: number) {
    const updated = endpoints.filter((_, i) => i !== idx);
    saveMutation.mutate(updated);
  }

  const inputCls = "w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400";
  const labelCls = "text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1";

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-blue-50 flex items-center justify-center">
            <Plug className="w-5 h-5 text-blue-600" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-gray-900">Catálogo de Endpoints</h1>
            <p className="text-sm text-gray-500">Servicios disponibles para nodos webhook en flujos</p>
          </div>
        </div>
        <button
          onClick={openNew}
          className="flex items-center gap-2 bg-blue-600 text-white text-sm font-medium px-4 py-2 rounded-xl hover:bg-blue-700 transition"
        >
          <Plus className="w-4 h-4" /> Nuevo endpoint
        </button>
      </div>

      {saveMsg && (
        <div className="bg-green-50 border border-green-200 text-green-700 text-sm px-4 py-2 rounded-xl">{saveMsg}</div>
      )}

      {/* List */}
      {isLoading ? (
        <p className="text-sm text-gray-400">Cargando...</p>
      ) : endpoints.length === 0 ? (
        <div className="text-center py-16 text-gray-400">
          <Globe className="w-10 h-10 mx-auto mb-3 opacity-30" />
          <p className="text-sm">No hay endpoints configurados. Agrega uno para usarlo en flujos.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {endpoints.map((ep, idx) => (
            <div
              key={ep.id || idx}
              className="bg-white rounded-xl border border-gray-100 shadow-sm px-5 py-4 flex items-start gap-4 hover:border-blue-100 transition"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${METHOD_COLORS[ep.method] ?? "bg-gray-100 text-gray-600"}`}>
                    {ep.method}
                  </span>
                  <span className="font-semibold text-gray-800 text-sm">{ep.name}</span>
                  <span className="text-[10px] font-mono text-gray-400 truncate">{ep.url}</span>
                  {ep.sessionInit && (
                    <span className="flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full bg-purple-100 text-purple-700">
                      <Zap className="w-2.5 h-2.5" /> Sesión Init
                    </span>
                  )}
                </div>
                {ep.description && (
                  <p className="text-xs text-gray-400 mb-2">{ep.description}</p>
                )}
                <div className="flex items-center gap-3 text-[11px]">
                  <div className="flex items-center gap-1 text-blue-600">
                    <span className="font-semibold">Inputs:</span>
                    {ep.inputs.length ? ep.inputs.map(i => (
                      <span key={i} className="bg-blue-50 font-mono px-1.5 py-0.5 rounded">{i}</span>
                    )) : <span className="text-gray-300">ninguno</span>}
                  </div>
                  <ArrowRight className="w-3 h-3 text-gray-300" />
                  <div className="flex items-center gap-1 text-green-600">
                    <span className="font-semibold">Outputs:</span>
                    {ep.outputs.length ? ep.outputs.map(o => (
                      <span key={o} className="bg-green-50 font-mono px-1.5 py-0.5 rounded">{o}</span>
                    )) : <span className="text-gray-300">ninguno</span>}
                  </div>
                </div>
              </div>
              <div className="flex gap-2 shrink-0">
                <button
                  onClick={() => openEdit(ep, idx)}
                  className="text-xs text-blue-600 border border-blue-100 rounded-lg px-3 py-1.5 hover:bg-blue-50 transition"
                >
                  Editar
                </button>
                <button
                  onClick={() => deleteEndpoint(idx)}
                  className="text-xs text-red-400 border border-red-100 rounded-lg px-2 py-1.5 hover:bg-red-50 transition"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Editor modal */}
      {editing && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg p-6 space-y-4">
            <h2 className="text-base font-bold text-gray-900">
              {editIdx !== null ? "Editar endpoint" : "Nuevo endpoint"}
            </h2>

            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2">
                <p className={labelCls}>Nombre</p>
                <input className={inputCls} placeholder="Validar Usuario" value={editing.name}
                  onChange={e => setEditing(p => ({ ...p!, name: e.target.value }))} />
              </div>
              <div className="col-span-2">
                <p className={labelCls}>ID (único, sin espacios)</p>
                <input className={inputCls} placeholder="validateUser" value={editing.id}
                  onChange={e => setEditing(p => ({ ...p!, id: e.target.value.replace(/\s/g, "") }))} />
              </div>
              <div>
                <p className={labelCls}>Método</p>
                <select className={inputCls} value={editing.method}
                  onChange={e => setEditing(p => ({ ...p!, method: e.target.value as EndpointDef["method"] }))}>
                  {METHODS.map(m => <option key={m} value={m}>{m}</option>)}
                </select>
              </div>
              <div>
                <p className={labelCls}>URL</p>
                <input className={inputCls} placeholder="/api/usuarios/validar" value={editing.url}
                  onChange={e => setEditing(p => ({ ...p!, url: e.target.value }))} />
              </div>
              <div className="col-span-2">
                <p className={labelCls}>Descripción (opcional)</p>
                <input className={inputCls} placeholder="Valida al usuario por cédula" value={editing.description ?? ""}
                  onChange={e => setEditing(p => ({ ...p!, description: e.target.value }))} />
              </div>
              <div className="col-span-2">
                <label className="flex items-center gap-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={!!editing.sessionInit}
                    onChange={e => setEditing(p => ({ ...p!, sessionInit: e.target.checked }))}
                    className="w-4 h-4 accent-purple-600"
                  />
                  <span className="text-sm font-medium text-gray-700 flex items-center gap-1">
                    <Zap className="w-3.5 h-3.5 text-purple-600" />
                    Session Init — llamar al inicio de cada conversación
                  </span>
                </label>
                <p className="text-[11px] text-gray-400 mt-0.5 ml-6">Sus outputs quedarán disponibles como variables en todos los nodos del flujo.</p>
              </div>
              <div className="col-span-2">
                <p className={labelCls}>Parámetros de entrada (inputs) — Enter para agregar</p>
                <TagInput tags={editing.inputs} onChange={v => setEditing(p => ({ ...p!, inputs: v }))} placeholder="cedula, telefono..." />
              </div>
              <div className="col-span-2">
                <p className={labelCls}>Campos de respuesta (outputs) — Enter para agregar</p>
                <TagInput tags={editing.outputs} onChange={v => setEditing(p => ({ ...p!, outputs: v }))} placeholder="nombre, saldo, estatus..." />
              </div>
            </div>

            <div className="flex gap-2 pt-2">
              <button
                onClick={saveEndpoint}
                disabled={!editing.id || !editing.name || !editing.url}
                className="flex-1 flex items-center justify-center gap-2 bg-blue-600 text-white text-sm font-medium rounded-xl py-2.5 hover:bg-blue-700 disabled:opacity-40 transition"
              >
                <Save className="w-4 h-4" /> Guardar
              </button>
              <button
                onClick={() => { setEditing(null); setEditIdx(null); }}
                className="px-4 py-2.5 text-sm text-gray-500 border border-gray-200 rounded-xl hover:bg-gray-50 transition"
              >
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
