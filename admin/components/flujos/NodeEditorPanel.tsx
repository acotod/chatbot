"use client";
import { useState, useEffect } from "react";
import { X, Trash2, Check, Zap, Plus, DatabaseZap, Webhook } from "lucide-react";
import type { Node } from "reactflow";
import {
  NODE_META, resolveNodeType,
  type NodeType, type CanonicalNodeType, type EndpointDef,
  type ConditionContent, type WebhookContent, type EndpointMapping,
} from "@/lib/flowTypes";

type VarSource = "user_input" | "api_response_field" | "static_value";
interface NodeVariable {
  id: string;
  name: string;
  source: VarSource;
  value: string;
}

type ActionEvent = "on_enter" | "on_exit" | "on_option_select";
interface NodeAction {
  id: string;
  event: ActionEvent;
  endpointId: string;
  customUrl: string;
  method: string;
  body: Record<string, string>;
  responseMapping: Record<string, string>;
}

interface NodeEditorPanelProps {
  node: Node;
  endpointCatalog: EndpointDef[];
  onApply: (nodeId: string, data: Partial<Node["data"]>) => void;
  onCancel: () => void;
  onDelete: (nodeId: string) => void;
}

function uid() {
  return Math.random().toString(36).slice(2, 9);
}

export default function NodeEditorPanel({
  node, endpointCatalog, onApply, onCancel, onDelete,
}: NodeEditorPanelProps) {
  const [tab, setTab] = useState<"contenido" | "variables" | "acciones">("contenido");
  const [nodeType, setNodeType] = useState<CanonicalNodeType>(resolveNodeType((node.data.nodeType ?? "screen") as NodeType));
  const meta = NODE_META[nodeType] ?? NODE_META.screen;
  const [content, setContent] = useState<Record<string, unknown>>({ ...node.data.content });
  const [variables, setVariables] = useState<NodeVariable[]>(() => {
    const saved = node.data.state?.save as { name: string; source: VarSource; value: string }[] | undefined;
    return (saved ?? []).map(v => ({ id: uid(), ...v }));
  });
  const [actions, setActions] = useState<NodeAction[]>(() => {
    const saved = node.data.actions as Omit<NodeAction, "id">[] | undefined;
    return (saved ?? []).map(a => ({ id: uid(), ...a }));
  });

  useEffect(() => {
    setTab("contenido");
    setNodeType(resolveNodeType((node.data.nodeType ?? "screen") as NodeType));
    setContent({ ...node.data.content });
    const savedVars = node.data.state?.save as { name: string; source: VarSource; value: string }[] | undefined;
    setVariables((savedVars ?? []).map(v => ({ id: uid(), ...v })));
    const savedActions = node.data.actions as Omit<NodeAction, "id">[] | undefined;
    setActions((savedActions ?? []).map(a => ({ id: uid(), ...a })));
  }, [node.id]);

  // --- content helpers ---
  function patch(key: string, value: unknown) {
    setContent(prev => ({ ...prev, [key]: value }));
  }

  function patchBody(param: string, value: string) {
    setContent(prev => {
      const ep = (prev.endpoint as EndpointMapping) ?? { endpointId: "", body: {}, responseMapping: {} };
      return { ...prev, endpoint: { ...ep, body: { ...ep.body, [param]: value } } };
    });
  }

  function patchResponseMapping(output: string, value: string) {
    setContent(prev => {
      const ep = (prev.endpoint as EndpointMapping) ?? { endpointId: "", body: {}, responseMapping: {} };
      return { ...prev, endpoint: { ...ep, responseMapping: { ...ep.responseMapping, [output]: value } } };
    });
  }

  // --- variables helpers ---
  function addVariable() {
    setVariables(prev => [...prev, { id: uid(), name: "", source: "user_input", value: "" }]);
  }
  function patchVariable(id: string, key: keyof NodeVariable, value: string) {
    setVariables(prev => prev.map(v => v.id === id ? { ...v, [key]: value } : v));
  }
  function removeVariable(id: string) {
    setVariables(prev => prev.filter(v => v.id !== id));
  }

  // --- actions helpers ---
  function addAction() {
    setActions(prev => [...prev, { id: uid(), event: "on_enter", endpointId: "", customUrl: "", method: "POST", body: {}, responseMapping: {} }]);
  }
  function patchAction(id: string, key: keyof NodeAction, value: unknown) {
    setActions(prev => prev.map(a => a.id === id ? { ...a, [key]: value } : a));
  }
  function patchActionBody(id: string, param: string, value: string) {
    setActions(prev => prev.map(a => a.id === id ? { ...a, body: { ...a.body, [param]: value } } : a));
  }
  function patchActionResponseMapping(id: string, output: string, value: string) {
    setActions(prev => prev.map(a => a.id === id ? { ...a, responseMapping: { ...a.responseMapping, [output]: value } } : a));
  }
  function removeAction(id: string) {
    setActions(prev => prev.filter(a => a.id !== id));
  }

  function handleApply() {
    const statePayload = variables.length > 0
      ? { save: variables.map(({ name, source, value }) => ({ name, source, value })) }
      : undefined;
    const actionsPayload = actions.length > 0
      ? actions.map(({ event, endpointId, customUrl, method, body, responseMapping }) => ({
          event, endpointId: endpointId || undefined, customUrl: customUrl || undefined, method, body, responseMapping,
        }))
      : undefined;
    onApply(node.id, {
      nodeType,
      content,
      label: (content.label as string) ?? node.data.label,
      state: statePayload,
      actions: actionsPayload,
    });
  }

  const inputCls = "w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400";
  const labelCls = "text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1";

  const TABS = [
    { id: "contenido" as const, label: "Contenido" },
    { id: "variables" as const, label: "Variables" },
    { id: "acciones" as const, label: "Acciones" },
  ];

  return (
    <div className="w-80 flex-shrink-0 bg-white rounded-xl border shadow-sm flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b" style={{ background: meta.bg }}>
        <div>
          <span className="text-xs font-bold uppercase tracking-wide" style={{ color: meta.color }}>
            {meta.label}
          </span>
          <p className="text-sm font-semibold text-gray-800 truncate">{node.id}</p>
        </div>
        <button onClick={onCancel} className="p-1 rounded-lg hover:bg-black/10">
          <X className="w-4 h-4 text-gray-500" />
        </button>
      </div>

      {/* Tab bar */}
      <div className="flex border-b bg-gray-50">
        {TABS.map(t => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`flex-1 py-2 text-xs font-semibold transition border-b-2 ${
              tab === t.id
                ? "border-blue-500 text-blue-600 bg-white"
                : "border-transparent text-gray-500 hover:text-gray-700"
            }`}
          >
            {t.label}
            {t.id === "variables" && variables.length > 0 && (
              <span className="ml-1 inline-flex items-center justify-center w-4 h-4 rounded-full bg-blue-100 text-blue-600 text-[9px] font-bold">
                {variables.length}
              </span>
            )}
            {t.id === "acciones" && actions.length > 0 && (
              <span className="ml-1 inline-flex items-center justify-center w-4 h-4 rounded-full bg-purple-100 text-purple-600 text-[9px] font-bold">
                {actions.length}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* ── TAB 1: CONTENIDO ── */}
        {tab === "contenido" && (<>
        {/* Node type selector */}
        <div>
          <p className={labelCls}>Tipo de nodo</p>
          <div className="grid grid-cols-3 gap-1">
            {([
              { t: "start",     emoji: "▶️" },
              { t: "screen",    emoji: "💬" },
              { t: "input",     emoji: "✏️" },
              { t: "condition", emoji: "🔀" },
              { t: "webhook",   emoji: "⚡" },
              { t: "end",       emoji: "⏹️" },
            ] as { t: CanonicalNodeType; emoji: string }[]).map(({ t, emoji }) => {
              const m = NODE_META[t as keyof typeof NODE_META];
              if (!m) return null;
              const active = nodeType === t;
              return (
                <button
                  key={t}
                  type="button"
                  onClick={() => { setNodeType(t); setContent({}); }}
                  className={`flex flex-col items-center gap-0.5 py-2 px-1 rounded-lg border text-xs font-medium transition ${active ? "border-2 bg-opacity-20" : "border-gray-200 hover:bg-gray-50 text-gray-600"}`}
                  style={active ? { borderColor: m.color, background: m.bg, color: m.color } : {}}
                >
                  <span className="text-base leading-none">{emoji}</span>
                  <span className="truncate w-full text-center">{m.label}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Label — all types */}
        <div>
          <p className={labelCls}>Etiqueta</p>
          <input className={inputCls} value={(content.label as string) ?? ""} onChange={e => patch("label", e.target.value)} />
        </div>

        {/* Screen / message */}
        {(nodeType === "screen") && (
          <>
            <div>
              <p className={labelCls}>Screen ID (MAYÚSCULAS)</p>
              <input className={inputCls} value={(content.screenId as string) ?? ""} onChange={e => patch("screenId", e.target.value.toUpperCase().replace(/\s/g, "_"))} placeholder="BIENVENIDA" />
            </div>
            <div>
              <p className={labelCls}>Título</p>
              <input className={inputCls} value={(content.title as string) ?? ""} onChange={e => patch("title", e.target.value)} />
            </div>
            <div>
              <p className={labelCls}>Pantalla terminal</p>
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input type="checkbox" checked={!!(content.terminal)} onChange={e => patch("terminal", e.target.checked)} />
                Marcar como pantalla final
              </label>
            </div>
          </>
        )}

        {/* Input */}
        {nodeType === "input" && (
          <>
            <div>
              <p className={labelCls}>Nombre de variable</p>
              <input className={inputCls} value={(content.name as string) ?? ""} onChange={e => patch("name", e.target.value)} placeholder="nombre_cliente" />
            </div>
            <div>
              <p className={labelCls}>Tipo de entrada</p>
              <select className={inputCls} value={(content.inputType as string) ?? "text"} onChange={e => patch("inputType", e.target.value)}>
                {["text","number","email","phone","select","date"].map(t => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            </div>
            <div>
              <p className={labelCls}>Placeholder</p>
              <input className={inputCls} value={(content.placeholder as string) ?? ""} onChange={e => patch("placeholder", e.target.value)} />
            </div>
          </>
        )}

        {/* Condition */}
        {nodeType === "condition" && (
          <>
            <div>
              <p className={labelCls}>Variable a evaluar</p>
              <input className={inputCls} value={(content as unknown as ConditionContent).variable ?? ""} onChange={e => patch("variable", e.target.value)} placeholder="{{webhook.response.status}}" />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <p className={labelCls}>Rama TRUE</p>
                <input className={inputCls} value={(content as unknown as ConditionContent).trueLabel ?? "Sí"} onChange={e => patch("trueLabel", e.target.value)} />
              </div>
              <div>
                <p className={labelCls}>Rama FALSE</p>
                <input className={inputCls} value={(content as unknown as ConditionContent).falseLabel ?? "No"} onChange={e => patch("falseLabel", e.target.value)} />
              </div>
            </div>
          </>
        )}

        {/* Webhook */}
        {nodeType === "webhook" && (() => {
          const wc = content as unknown as WebhookContent;
          const ep = wc.endpoint as EndpointMapping | null;
          const selectedEp = ep?.endpointId
            ? endpointCatalog.find(x => x.id === ep.endpointId) ?? null
            : null;
          return (
            <>
              {/* Endpoint selector */}
              <div>
                <p className={labelCls}>Endpoint disponible</p>
                <select
                  className={inputCls}
                  value={ep?.endpointId ?? ""}
                  onChange={e => {
                    const found = endpointCatalog.find(x => x.id === e.target.value);
                    if (!found) { patch("endpoint", null); return; }
                    patch("endpoint", { endpointId: found.id, body: {}, responseMapping: {} } as EndpointMapping);
                  }}
                >
                  <option value="">— Sin endpoint —</option>
                  {endpointCatalog.map(def => (
                    <option key={def.id} value={def.id}>{def.sessionInit ? "⚡ " : ""}{def.method} · {def.name}</option>
                  ))}
                </select>
                {selectedEp && (
                  <p className="mt-1 text-[10px] font-mono text-gray-400 truncate">
                    {selectedEp.method} {selectedEp.url}
                  </p>
                )}
                {selectedEp?.sessionInit && (
                  <p className="mt-1 flex items-center gap-1 text-[10px] font-semibold text-purple-600">
                    <Zap className="w-3 h-3" /> Session Init — carga datos al inicio de la conversación
                  </p>
                )}
                {selectedEp?.description && (
                  <p className="mt-0.5 text-[10px] text-gray-400">{selectedEp.description}</p>
                )}
              </div>

              {/* Body mapping — inputs */}
              {selectedEp && selectedEp.inputs.length > 0 && (
                <div className="rounded-lg border border-blue-100 bg-blue-50 p-3 space-y-2">
                  <p className="text-xs font-semibold uppercase tracking-wide mb-1" style={{ color: "#1d4ed8" }}>
                    ↑ Datos de entrada ({selectedEp.method})
                  </p>
                  {selectedEp.inputs.map(param => (
                    <div key={param}>
                      <p className="text-[10px] font-mono text-blue-700 mb-0.5">{param}</p>
                      <input
                        className={inputCls}
                        placeholder={`{{${param}}}`}
                        value={ep?.body?.[param] ?? ""}
                        onChange={e => patchBody(param, e.target.value)}
                      />
                    </div>
                  ))}
                </div>
              )}

              {/* Response mapping — outputs */}
              {selectedEp && selectedEp.outputs.length > 0 && (
                <div className="rounded-lg border border-green-100 bg-green-50 p-3 space-y-2">
                  <p className="text-xs font-semibold uppercase tracking-wide mb-1" style={{ color: "#15803d" }}>
                    ↓ Variables de respuesta
                  </p>
                  {selectedEp.outputs.map(output => (
                    <div key={output} className="flex items-center gap-2">
                      <span className="text-[10px] font-mono text-green-700 w-20 truncate shrink-0">{output}</span>
                      <span className="text-gray-400 text-xs">→</span>
                      <input
                        className={inputCls}
                        placeholder={output}
                        value={ep?.responseMapping?.[output] ?? ""}
                        onChange={e => patchResponseMapping(output, e.target.value)}
                      />
                    </div>
                  ))}
                  <p className="text-[10px] text-green-600">
                    Usa estas variables con <code className="bg-green-100 px-1 rounded">{`{{nombre}}`}</code>
                  </p>
                </div>
              )}

              {/* Fallback screen */}
              {ep?.endpointId && (
                <div>
                  <p className={labelCls}>Screen fallback ID (si falla)</p>
                  <input
                    className={inputCls}
                    value={wc.fallbackScreenId ?? ""}
                    onChange={e => patch("fallbackScreenId", e.target.value)}
                    placeholder="ERROR"
                  />
                </div>
              )}
            </>
          );
        })()}

        {/* End */}
        {nodeType === "end" && (
          <div>
            <p className={labelCls}>Mensaje de cierre</p>
            <textarea className={inputCls} rows={3} value={(content.message as string) ?? ""} onChange={e => patch("message", e.target.value)} placeholder="Gracias por contactarnos." />
          </div>
        )}
        </>)}

        {/* ── TAB 2: VARIABLES ── */}
        {tab === "variables" && (
          <div className="space-y-3">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="text-sm font-semibold text-gray-800">Variables del nodo</p>
                <p className="text-[11px] text-gray-400 mt-0.5">Campos que este nodo guarda en el estado de la conversación.</p>
              </div>
              <button
                type="button"
                onClick={addVariable}
                className="flex items-center gap-1 text-xs font-semibold text-blue-600 border border-blue-200 rounded-lg px-2.5 py-1.5 hover:bg-blue-50 shrink-0"
              >
                <Plus className="w-3.5 h-3.5" /> Agregar
              </button>
            </div>
            {variables.length === 0 && (
              <div className="flex flex-col items-center gap-2 py-8 text-gray-300">
                <DatabaseZap className="w-8 h-8" />
                <p className="text-xs text-center text-gray-400">Sin variables. Agrega campos para guardar datos de este nodo.</p>
              </div>
            )}
            {variables.map((v) => (
              <div key={v.id} className="rounded-lg border border-gray-200 p-3 space-y-2 bg-gray-50">
                <div className="flex items-center justify-between">
                  <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide">Variable</p>
                  <button type="button" onClick={() => removeVariable(v.id)} className="text-red-400 hover:text-red-600">
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
                <input
                  className={inputCls}
                  placeholder="nombre_variable"
                  value={v.name}
                  onChange={e => patchVariable(v.id, "name", e.target.value)}
                />
                <select
                  className={inputCls}
                  value={v.source}
                  onChange={e => patchVariable(v.id, "source", e.target.value as VarSource)}
                >
                  <option value="user_input">Entrada del usuario</option>
                  <option value="api_response_field">Campo de respuesta API</option>
                  <option value="static_value">Valor estático</option>
                </select>
                {v.source !== "user_input" && (
                  <input
                    className={inputCls}
                    placeholder={v.source === "api_response_field" ? "response.data.field" : "valor fijo"}
                    value={v.value}
                    onChange={e => patchVariable(v.id, "value", e.target.value)}
                  />
                )}
              </div>
            ))}
          </div>
        )}

        {/* ── TAB 3: ACCIONES ── */}
        {tab === "acciones" && (
          <div className="space-y-3">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="text-sm font-semibold text-gray-800">Acciones del nodo</p>
                <p className="text-[11px] text-gray-400 mt-0.5">Webhooks o llamadas API que se ejecutan en eventos del nodo.</p>
              </div>
              <button
                type="button"
                onClick={addAction}
                className="flex items-center gap-1 text-xs font-semibold text-purple-600 border border-purple-200 rounded-lg px-2.5 py-1.5 hover:bg-purple-50 shrink-0"
              >
                <Plus className="w-3.5 h-3.5" /> Agregar
              </button>
            </div>
            {actions.length === 0 && (
              <div className="flex flex-col items-center gap-2 py-8 text-gray-300">
                <Webhook className="w-8 h-8" />
                <p className="text-xs text-center text-gray-400">Sin acciones. Agrega webhooks o llamadas API para este nodo.</p>
              </div>
            )}
            {actions.map((a, idx) => {
              const selectedEp = a.endpointId
                ? endpointCatalog.find(x => x.id === a.endpointId) ?? null
                : null;
              return (
                <div key={a.id} className="rounded-lg border border-purple-100 bg-purple-50 p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <p className="text-[10px] font-semibold text-purple-500 uppercase tracking-wide">Acción {idx + 1}</p>
                    <button type="button" onClick={() => removeAction(a.id)} className="text-red-400 hover:text-red-600">
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  <div>
                    <p className={labelCls}>Evento</p>
                    <select className={inputCls} value={a.event} onChange={e => patchAction(a.id, "event", e.target.value)}>
                      <option value="on_enter">Al entrar al nodo</option>
                      <option value="on_exit">Al salir del nodo</option>
                      <option value="on_option_select">Al seleccionar opción</option>
                    </select>
                  </div>
                  <div>
                    <p className={labelCls}>Endpoint del catálogo</p>
                    <select className={inputCls} value={a.endpointId} onChange={e => patchAction(a.id, "endpointId", e.target.value)}>
                      <option value="">— URL personalizada —</option>
                      {endpointCatalog.map(def => (
                        <option key={def.id} value={def.id}>{def.method} · {def.name}</option>
                      ))}
                    </select>
                  </div>
                  {!a.endpointId && (
                    <div className="grid grid-cols-3 gap-2">
                      <div className="col-span-1">
                        <p className={labelCls}>Método</p>
                        <select className={inputCls} value={a.method} onChange={e => patchAction(a.id, "method", e.target.value)}>
                          {["POST","GET","PUT","PATCH","DELETE"].map(m => (
                            <option key={m} value={m}>{m}</option>
                          ))}
                        </select>
                      </div>
                      <div className="col-span-2">
                        <p className={labelCls}>URL</p>
                        <input className={inputCls} placeholder="https://..." value={a.customUrl} onChange={e => patchAction(a.id, "customUrl", e.target.value)} />
                      </div>
                    </div>
                  )}
                  {(selectedEp?.inputs ?? Object.keys(a.body)).length > 0 && (
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between">
                        <p className="text-[10px] font-semibold text-blue-700 uppercase tracking-wide">↑ Body</p>
                        {!a.endpointId && (
                          <button type="button" className="text-[10px] text-blue-500 hover:text-blue-700"
                            onClick={() => { const k = window.prompt("Nombre del parámetro"); if (k) patchActionBody(a.id, k, ""); }}>
                            + param
                          </button>
                        )}
                      </div>
                      {(selectedEp?.inputs ?? Object.keys(a.body)).map(param => (
                        <div key={param} className="flex items-center gap-1.5">
                          <span className="text-[10px] font-mono text-blue-700 w-20 truncate shrink-0">{param}</span>
                          <span className="text-gray-400 text-[10px]">→</span>
                          <input className={inputCls} placeholder={`{{${param}}}`} value={a.body[param] ?? ""} onChange={e => patchActionBody(a.id, param, e.target.value)} />
                        </div>
                      ))}
                    </div>
                  )}
                  {(selectedEp?.outputs ?? Object.keys(a.responseMapping)).length > 0 && (
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between">
                        <p className="text-[10px] font-semibold text-green-700 uppercase tracking-wide">↓ Respuesta → variable</p>
                        {!a.endpointId && (
                          <button type="button" className="text-[10px] text-green-500 hover:text-green-700"
                            onClick={() => { const k = window.prompt("Campo de respuesta"); if (k) patchActionResponseMapping(a.id, k, ""); }}>
                            + mapear
                          </button>
                        )}
                      </div>
                      {(selectedEp?.outputs ?? Object.keys(a.responseMapping)).map(output => (
                        <div key={output} className="flex items-center gap-1.5">
                          <span className="text-[10px] font-mono text-green-700 w-20 truncate shrink-0">{output}</span>
                          <span className="text-gray-400 text-[10px]">→</span>
                          <input className={inputCls} placeholder={output} value={a.responseMapping[output] ?? ""} onChange={e => patchActionResponseMapping(a.id, output, e.target.value)} />
                        </div>
                      ))}
                    </div>
                  )}
                  {!a.endpointId && (
                    <div className="flex gap-2 pt-1">
                      <button type="button" className="text-[10px] text-blue-500 hover:text-blue-700 border border-blue-200 rounded px-2 py-1"
                        onClick={() => { const k = window.prompt("Parámetro body"); if (k) patchActionBody(a.id, k, ""); }}>
                        + body param
                      </button>
                      <button type="button" className="text-[10px] text-green-500 hover:text-green-700 border border-green-200 rounded px-2 py-1"
                        onClick={() => { const k = window.prompt("Campo de respuesta"); if (k) patchActionResponseMapping(a.id, k, ""); }}>
                        + response map
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

      </div>

      {/* Footer */}
      <div className="border-t px-4 py-3 flex gap-2">
        <button
          onClick={handleApply}
          className="flex-1 flex items-center justify-center gap-1.5 bg-blue-600 text-white text-sm font-medium rounded-lg py-2 hover:bg-blue-700"
        >
          <Check className="w-4 h-4" /> Aplicar
        </button>
        <button
          onClick={() => onDelete(node.id)}
          className="flex items-center justify-center gap-1 border border-red-200 text-red-500 text-sm rounded-lg px-3 py-2 hover:bg-red-50"
        >
          <Trash2 className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
