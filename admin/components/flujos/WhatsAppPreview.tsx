"use client";
import type { Node, Edge } from "reactflow";
import { resolveNodeType, type NodeType, type ScreenContent, type InputContent } from "@/lib/flowTypes";

interface WhatsAppPreviewProps {
  nodes: Node[];
  edges: Edge[];
  compact?: boolean;
}

function PhoneFrame({ children, compact }: { children: React.ReactNode; compact?: boolean }) {
  if (compact) {
    return (
      <div className="bg-[#e5ddd5] rounded-xl p-3 w-full max-w-[300px] mx-auto space-y-2 overflow-y-auto">
        {children}
      </div>
    );
  }
  return (
    <div className="flex justify-center">
      <div
        className="relative bg-[#e5ddd5] rounded-[2.5rem] shadow-2xl overflow-hidden"
        style={{ width: 300, minHeight: 520, border: "10px solid #1a1a1a" }}
      >
        {/* Notch */}
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-24 h-5 bg-black rounded-b-xl z-10" />
        {/* Status bar */}
        <div className="bg-[#075e54] text-white text-[10px] px-4 pt-6 pb-2 flex items-center gap-2">
          <div className="w-7 h-7 rounded-full bg-white/30 flex items-center justify-center text-base">🤖</div>
          <div>
            <p className="font-semibold text-sm leading-tight">Chatbot</p>
            <p className="text-white/70 text-[10px]">en línea</p>
          </div>
        </div>
        {/* Chat area */}
        <div className="px-2 py-3 space-y-2 overflow-y-auto" style={{ maxHeight: 400 }}>
          {children}
        </div>
      </div>
    </div>
  );
}

function BubbleBot({ text }: { text: string }) {
  return (
    <div className="flex items-end gap-1 max-w-[85%]">
      <div className="bg-white rounded-2xl rounded-tl-sm px-3 py-2 shadow text-sm text-gray-800 leading-snug">
        {text}
      </div>
    </div>
  );
}

function BubbleButtons({ options }: { options: string[] }) {
  return (
    <div className="flex flex-wrap gap-1.5 max-w-[85%]">
      {options.map((o, i) => (
        <button key={i} className="bg-white border border-[#075e54] text-[#075e54] text-xs rounded-full px-3 py-1 shadow">
          {o}
        </button>
      ))}
    </div>
  );
}

function InputField({ placeholder }: { placeholder: string }) {
  return (
    <div className="ml-auto max-w-[85%] bg-[#dcf8c6] rounded-2xl rounded-br-sm px-3 py-2 shadow text-sm text-gray-700 italic">
      [{placeholder}]
    </div>
  );
}

export default function WhatsAppPreview({ nodes, edges, compact }: WhatsAppPreviewProps) {
  // Build an ordered traversal starting from start/first node
  const startNode = nodes.find(n => {
    const t = resolveNodeType((n.data.nodeType ?? "screen") as NodeType);
    return t === "start";
  }) ?? nodes[0];

  if (!nodes.length || !startNode) {
    return (
      <div className="flex items-center justify-center py-12 text-gray-400 text-sm">
        No hay nodos para previsualizar
      </div>
    );
  }

  // BFS traversal up to 10 nodes to avoid infinite loops
  const visited = new Set<string>();
  const ordered: Node[] = [];
  const queue = [startNode.id];
  while (queue.length && ordered.length < 10) {
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const node = nodes.find(n => n.id === id);
    if (node) ordered.push(node);
    // Find outgoing edges
    edges
      .filter(e => e.source === id)
      .forEach(e => { if (!visited.has(e.target)) queue.push(e.target); });
  }

  const bubbles: React.ReactNode[] = [];

  for (const node of ordered) {
    const nodeType = resolveNodeType((node.data.nodeType ?? "screen") as NodeType);
    const c = node.data.content ?? {};

    if (nodeType === "start") {
      bubbles.push(<BubbleBot key={node.id} text={(c.label as string) || "Hola 👋"} />);
    } else if (nodeType === "screen") {
      const sc = c as ScreenContent;
      const title = sc.title || sc.label || "Pantalla";
      bubbles.push(<BubbleBot key={node.id} text={`📱 *${title}*`} />);
    } else if (nodeType === "input") {
      const ic = c as InputContent;
      bubbles.push(<BubbleBot key={`${node.id}-q`} text={ic.placeholder || ic.label || "Ingresa tu respuesta:"} />);
      bubbles.push(<InputField key={`${node.id}-a`} placeholder={ic.name || "respuesta"} />);
    } else if (nodeType === "condition") {
      const trueLabel = (c as { trueLabel?: string }).trueLabel ?? "Sí";
      const falseLabel = (c as { falseLabel?: string }).falseLabel ?? "No";
      bubbles.push(<BubbleBot key={`${node.id}-q`} text={(c.label as string) || "¿Confirmar?"} />);
      bubbles.push(<BubbleButtons key={`${node.id}-opts`} options={[trueLabel, falseLabel]} />);
    } else if (nodeType === "webhook") {
      bubbles.push(<BubbleBot key={node.id} text={`⚙️ ${(c.label as string) || "Procesando..."}`} />);
    } else if (nodeType === "end") {
      bubbles.push(<BubbleBot key={node.id} text={(c.message as string) || (c.label as string) || "✅ Fin del flujo"} />);
    }
  }

  if (ordered.length < nodes.length) {
    bubbles.push(
      <p key="more" className="text-center text-[10px] text-gray-400">
        +{nodes.length - ordered.length} nodo(s) más…
      </p>
    );
  }

  return <PhoneFrame compact={compact}>{bubbles}</PhoneFrame>;
}
