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
  GET: "bg-emerald-50 text-emerald-700 border border-emerald-200",
  POST: "bg-cyan-50 text-cyan-700 border border-cyan-200",
  PUT: "bg-amber-50 text-amber-700 border border-amber-200",
  PATCH: "bg-orange-50 text-orange-700 border border-orange-200",
  DELETE: "bg-rose-50 text-rose-700 border border-rose-200",
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
    <div className="flex flex-wrap gap-1 items-center border border-[#D9E5EB] rounded-xl px-2 py-1.5 min-h-[38px] bg-white focus-within:ring-2 focus-within:ring-[#00BFAE]/25">
      {tags.map(t => (
        <span key={t} className="flex items-center gap-1 bg-[#EEF9F7] text-[#00BFAE] text-xs font-mono px-2 py-0.5 rounded-full border border-[#CDEFEA]">
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

  const inputCls = "w-full border border-[#D9E5EB] rounded-xl px-3 py-2 text-sm bg-white text-[#0D2B3E] focus:outline-none focus:ring-2 focus:ring-[#00BFAE]/25";
  const labelCls = "text-xs font-semibold text-[#5B6670] uppercase tracking-[0.12em] mb-1";

  return (
    <div className="zentra-chat-shell rounded-3xl p-5 sm:p-6 max-w-6xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-2xl bg-[#EEF9F7] border border-[#CDEFEA] flex items-center justify-center">
            <Plug className="w-5 h-5 text-[#00BFAE]" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-[#0D2B3E]">Catálogo de Endpoints</h1>
            <p className="text-sm text-[#5B6670]">Servicios disponibles para nodos webhook en flujos</p>
          </div>
        </div>
        <button
          onClick={openNew}
          className="flex items-center gap-2 bg-gradient-to-r from-[#00BFAE] to-[#39E6D2] text-[#063743] text-sm font-semibold px-4 py-2 rounded-xl hover:brightness-105 transition"
        >
          <Plus className="w-4 h-4" /> Nuevo endpoint
        </button>
      </div>

      {saveMsg && (
        <div className="bg-[#EEF9F7] border border-[#CDEFEA] text-[#0D2B3E] text-sm px-4 py-2 rounded-xl">{saveMsg}</div>
      )}

      {/* List */}
      {isLoading ? (
        <p className="text-sm text-[#5B6670]">Cargando...</p>
      ) : endpoints.length === 0 ? (
        <div className="text-center py-16 text-[#5B6670]">
          <Globe className="w-10 h-10 mx-auto mb-3 opacity-40 text-[#00BFAE]" />
          <p className="text-sm">No hay endpoints configurados. Agrega uno para usarlo en flujos.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {endpoints.map((ep, idx) => (
            <div
              key={ep.id || idx}
              className="bg-white rounded-2xl border border-[#D9E5EB] shadow-sm px-5 py-4 flex items-start gap-4 hover:border-[#BCE8E1] transition"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${METHOD_COLORS[ep.method] ?? "bg-gray-100 text-gray-600"}`}>
                    {ep.method}
                  </span>
                  <span className="font-semibold text-[#0D2B3E] text-sm">{ep.name}</span>
                  <span className="text-[10px] font-mono text-[#5B6670] truncate">{ep.url}</span>
                  {ep.sessionInit && (
                    <span className="flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full bg-[#EEF9F7] text-[#00BFAE] border border-[#CDEFEA]">
                      <Zap className="w-2.5 h-2.5" /> Session Init
                    </span>
                  )}
                </div>
                {ep.description && (
                  <p className="text-xs text-[#5B6670] mb-2">{ep.description}</p>
                )}
                <div className="flex items-center gap-3 text-[11px]">
                  <div className="flex items-center gap-1 text-[#00BFAE]">
                    <span className="font-semibold">Inputs:</span>
                    {ep.inputs.length ? ep.inputs.map(i => (
                      <span key={i} className="bg-[#EEF9F7] border border-[#CDEFEA] font-mono px-1.5 py-0.5 rounded">{i}</span>
                    )) : <span className="text-[#A3AFB8]">ninguno</span>}
                  </div>
                  <ArrowRight className="w-3 h-3 text-[#A3AFB8]" />
                  <div className="flex items-center gap-1 text-emerald-600">
                    <span className="font-semibold">Outputs:</span>
                    {ep.outputs.length ? ep.outputs.map(o => (
                      <span key={o} className="bg-emerald-50 border border-emerald-200 font-mono px-1.5 py-0.5 rounded">{o}</span>
                    )) : <span className="text-[#A3AFB8]">ninguno</span>}
                  </div>
                </div>
              </div>
              <div className="flex gap-2 shrink-0">
                <button
                  onClick={() => openEdit(ep, idx)}
                  className="text-xs text-[#00BFAE] border border-[#CDEFEA] rounded-lg px-3 py-1.5 hover:bg-[#EEF9F7] transition"
                >
                  Editar
                </button>
                <button
                  onClick={() => deleteEndpoint(idx)}
                  className="text-xs text-rose-500 border border-rose-200 rounded-lg px-2 py-1.5 hover:bg-rose-50 transition"
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
          <div className="bg-white rounded-3xl border border-[#D9E5EB] shadow-xl w-full max-w-lg p-6 space-y-4">
            <h2 className="text-base font-bold text-[#0D2B3E]">
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
                    className="w-4 h-4 accent-[#00BFAE]"
                  />
                  <span className="text-sm font-medium text-[#0D2B3E] flex items-center gap-1">
                    <Zap className="w-3.5 h-3.5 text-[#00BFAE]" />
                    Session Init — llamar al inicio de cada conversación
                  </span>
                </label>
                <p className="text-[11px] text-[#5B6670] mt-0.5 ml-6">Sus outputs quedarán disponibles como variables en todos los nodos del flujo.</p>
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
                className="flex-1 flex items-center justify-center gap-2 bg-gradient-to-r from-[#00BFAE] to-[#39E6D2] text-[#063743] text-sm font-semibold rounded-xl py-2.5 hover:brightness-105 disabled:opacity-40 transition"
              >
                <Save className="w-4 h-4" /> Guardar
              </button>
              <button
                onClick={() => { setEditing(null); setEditIdx(null); }}
                className="px-4 py-2.5 text-sm text-[#5B6670] border border-[#D9E5EB] rounded-xl hover:bg-[#F4F7F9] transition"
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
