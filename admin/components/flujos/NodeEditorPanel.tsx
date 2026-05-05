"use client";
import { useState, useEffect } from "react";
import { X, Trash2, Check, Zap } from "lucide-react";
import type { Node } from "reactflow";
import {
  NODE_META, resolveNodeType,
  type NodeType, type CanonicalNodeType, type EndpointDef,
  type ConditionContent, type WebhookContent, type EndpointMapping,
} from "@/lib/flowTypes";

interface NodeEditorPanelProps {
  node: Node;
  endpointCatalog: EndpointDef[];
  onApply: (nodeId: string, data: Partial<Node["data"]>) => void;
  onCancel: () => void;
  onDelete: (nodeId: string) => void;
}

export default function NodeEditorPanel({
  node, endpointCatalog, onApply, onCancel, onDelete,
}: NodeEditorPanelProps) {
  const [nodeType, setNodeType] = useState<CanonicalNodeType>(resolveNodeType((node.data.nodeType ?? "screen") as NodeType));
  const meta = NODE_META[nodeType] ?? NODE_META.screen;
  const [content, setContent] = useState<Record<string, unknown>>({ ...node.data.content });

  useEffect(() => {
    setNodeType(resolveNodeType((node.data.nodeType ?? "screen") as NodeType));
    setContent({ ...node.data.content });
  }, [node.id, node.data.content, node.data.nodeType]);

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

  function handleApply() {
    onApply(node.id, { nodeType, content, label: (content.label as string) ?? node.data.label });
  }

  const inputCls = "w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400";
  const labelCls = "text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1";

  return (
    <div className="w-72 flex-shrink-0 bg-white rounded-xl border shadow-sm flex flex-col overflow-hidden">
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

      {/* Fields */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
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
