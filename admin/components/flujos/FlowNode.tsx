"use client";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Handle, Position, type NodeProps } from "reactflow";
import { MoreVertical, Pencil, PlugZap, TestTube2, Trash2, Variable } from "lucide-react";
import { NODE_META, resolveNodeType, type NodeType } from "@/lib/flowTypes";

interface FlowNodeData {
  label?: string;
  nodeType?: NodeType;
  content?: Record<string, unknown>;
  connectionModeActive?: boolean;
  connectionSourceActive?: boolean;
  connectTargetValid?: boolean;
  validationState?: "ok" | "warning" | "error";
}

function FlowNode({ data, selected }: NodeProps<FlowNodeData>) {
  const nodeType = resolveNodeType((data.nodeType ?? "screen") as NodeType);
  const meta = NODE_META[nodeType] ?? NODE_META.screen;
  const label = data.content?.label as string || data.label || meta.label;
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const menuBtnRef = useRef<HTMLButtonElement | null>(null);
  const connectionModeActive = !!data.connectionModeActive;
  const connectionSourceActive = !!data.connectionSourceActive;
  const connectTargetValid = !!data.connectTargetValid;
  const validationState = data.validationState;
  const subtitle = (() => {
    if (nodeType === "screen") return (data.content?.screenId as string) || "";
    if (nodeType === "input")  return (data.content?.name as string) || "";
    if (nodeType === "condition") return (data.content?.variable as string) || "";
    if (nodeType === "webhook") return (data.content?.endpoint as Record<string, string>)?.endpointId || "";
    return "";
  })();
  const quickActions = useMemo(() => {
    return [
      { id: "edit", label: "Editar nodo", icon: Pencil },
      { id: "webhook", label: "Configurar API/Webhook", icon: PlugZap },
      { id: "vars", label: "Ver variables", icon: Variable },
      { id: "test", label: "Run test", icon: TestTube2 },
      { id: "delete", label: "Eliminar", icon: Trash2 },
    ];
  }, []);

  function toggleMenu() {
    if (!menuBtnRef.current) return;
    if (menuOpen) {
      setMenuOpen(false);
      return;
    }
    const rect = menuBtnRef.current.getBoundingClientRect();
    setMenuPos({ top: rect.bottom + 8, left: rect.right - 210 });
    setMenuOpen(true);
  }

  useEffect(() => {
    if (!menuOpen) return;
    function onDocClick(event: MouseEvent) {
      const target = event.target as Node | null;
      if (menuBtnRef.current && target && menuBtnRef.current.contains(target as globalThis.Node)) return;
      setMenuOpen(false);
    }
    window.addEventListener("mousedown", onDocClick);
    return () => window.removeEventListener("mousedown", onDocClick);
  }, [menuOpen]);

  return (
    <div
      className="rounded-xl shadow-md min-w-[180px] max-w-[250px]"
      style={{
        border: `2px solid ${
          validationState === "error"
            ? "#ef4444"
            : connectionSourceActive
              ? "#2563eb"
              : selected
                ? meta.color
                : connectionModeActive && connectTargetValid
                  ? "#22c55e"
                  : "#e5e7eb"
        }`,
        background: connectionSourceActive
          ? "#eff6ff"
          : connectionModeActive && connectTargetValid
            ? "#f0fdf4"
            : selected
              ? meta.bg
              : "#fff",
        opacity: connectionModeActive && !connectTargetValid && !connectionSourceActive ? 0.55 : 1,
        transition: "border-color 0.15s, background 0.15s, opacity 0.15s",
      }}
    >
      {/* Top handle */}
      {nodeType !== "start" && (
        <Handle
          type="target"
          position={Position.Left}
          style={{ background: meta.color, borderColor: "#fff", width: 11, height: 11, left: -6 }}
        />
      )}

      {/* Header */}
      <div className="px-3 py-2 rounded-t-lg text-white" style={{ background: meta.color }}>
        <div className="flex items-center justify-between gap-2">
          <p className="text-[11px] font-semibold uppercase tracking-wide truncate">{meta.label}</p>
          <button
            ref={menuBtnRef}
            type="button"
            onClick={toggleMenu}
            className="inline-flex items-center justify-center rounded-md p-1 hover:bg-black/15 transition"
            title="Acciones del nodo"
          >
            <MoreVertical className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="px-3 py-2 space-y-1.5">
        <p className="text-sm font-medium text-gray-800 truncate">{label}</p>
        {subtitle && (
          <p className="text-[10px] text-gray-400 font-mono truncate">{subtitle}</p>
        )}
        <div className="inline-flex items-center rounded-full border border-gray-200 px-2 py-0.5 text-[10px] text-gray-500 bg-white">
          {nodeType}
        </div>
      </div>

      {/* Footer */}
      <div className="px-3 pb-2 pt-1 flex items-center justify-between text-[10px] text-gray-500">
        <span>Input</span>
        <div className="flex items-center gap-1.5">
          {validationState && (
            <span
              className="rounded-full px-1.5 py-0.5 font-semibold uppercase tracking-wide"
              style={{
                background: validationState === "error" ? "#fee2e2" : validationState === "warning" ? "#fef3c7" : "#dcfce7",
                color: validationState === "error" ? "#b91c1c" : validationState === "warning" ? "#92400e" : "#166534",
              }}
            >
              {validationState}
            </span>
          )}
          <span>Output</span>
        </div>
      </div>

      {/* Bottom handle — condition has two outputs */}
      {nodeType === "condition" ? (
        <>
          <Handle
            type="source"
            position={Position.Right}
            id="true"
            style={{ top: "38%", background: "#16a34a", borderColor: "#fff", width: 11, height: 11, right: -6 }}
          />
          <Handle
            type="source"
            position={Position.Right}
            id="false"
            style={{ top: "68%", background: "#dc2626", borderColor: "#fff", width: 11, height: 11, right: -6 }}
          />
        </>
      ) : nodeType !== "end" ? (
        <Handle
          type="source"
          position={Position.Right}
          style={{ background: meta.color, borderColor: "#fff", width: 11, height: 11, right: -6 }}
        />
      ) : null}

      {menuOpen && menuPos && createPortal(
        <div
          className="fixed w-[210px] rounded-xl border border-gray-200 bg-white shadow-2xl p-1.5"
          style={{ top: menuPos.top, left: menuPos.left, zIndex: 9999 }}
        >
          {quickActions.map((action) => {
            const Icon = action.icon;
            return (
              <button
                key={action.id}
                type="button"
                onClick={() => setMenuOpen(false)}
                className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-xs text-left hover:bg-gray-50 text-gray-700"
              >
                <Icon className="w-3.5 h-3.5" />
                {action.label}
              </button>
            );
          })}
        </div>,
        document.body,
      )}
    </div>
  );
}

export default memo(FlowNode);
