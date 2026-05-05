"use client";
import { memo } from "react";
import { Handle, Position, type NodeProps } from "reactflow";
import { NODE_META, resolveNodeType, type NodeType } from "@/lib/flowTypes";

interface FlowNodeData {
  label?: string;
  nodeType?: NodeType;
  content?: Record<string, unknown>;
}

function FlowNode({ data, selected }: NodeProps<FlowNodeData>) {
  const nodeType = resolveNodeType((data.nodeType ?? "screen") as NodeType);
  const meta = NODE_META[nodeType] ?? NODE_META.screen;
  const label = data.content?.label as string || data.label || meta.label;
  const subtitle = (() => {
    if (nodeType === "screen") return (data.content?.screenId as string) || "";
    if (nodeType === "input")  return (data.content?.name as string) || "";
    if (nodeType === "condition") return (data.content?.variable as string) || "";
    if (nodeType === "webhook") return (data.content?.endpoint as Record<string, string>)?.endpointId || "";
    return "";
  })();

  return (
    <div
      className="rounded-xl shadow-md min-w-[160px] max-w-[220px]"
      style={{
        border: `2px solid ${selected ? meta.color : "#e5e7eb"}`,
        background: selected ? meta.bg : "#fff",
        transition: "border-color 0.15s, background 0.15s",
      }}
    >
      {/* Top handle */}
      {nodeType !== "start" && (
        <Handle type="target" position={Position.Top} style={{ background: meta.color, borderColor: "#fff" }} />
      )}

      {/* Header */}
      <div
        className="px-3 py-1.5 rounded-t-lg text-white text-[11px] font-semibold uppercase tracking-wide"
        style={{ background: meta.color }}
      >
        {meta.label}
      </div>

      {/* Body */}
      <div className="px-3 py-2 space-y-0.5">
        <p className="text-sm font-medium text-gray-800 truncate">{label}</p>
        {subtitle && (
          <p className="text-[10px] text-gray-400 font-mono truncate">{subtitle}</p>
        )}
      </div>

      {/* Bottom handle — condition has two outputs */}
      {nodeType === "condition" ? (
        <>
          <Handle
            type="source" position={Position.Bottom} id="true"
            style={{ left: "30%", background: "#16a34a", borderColor: "#fff" }}
          />
          <Handle
            type="source" position={Position.Bottom} id="false"
            style={{ left: "70%", background: "#dc2626", borderColor: "#fff" }}
          />
        </>
      ) : nodeType !== "end" ? (
        <Handle type="source" position={Position.Bottom} style={{ background: meta.color, borderColor: "#fff" }} />
      ) : null}
    </div>
  );
}

export default memo(FlowNode);
