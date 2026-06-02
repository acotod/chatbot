/**
 * CanvasEditor - Main React Flow wrapper for WABA Flujos visual editor
 *
 * This component wraps ReactFlow and manages canvas state, interactions,
 * and synchronization with the flow definition.
 */

'use client';

import React, { useCallback, useState, useEffect } from 'react';
import ReactFlow, {
  Node,
  addEdge,
  applyNodeChanges,
  applyEdgeChanges,
  useNodesState,
  useEdgesState,
  Connection,
  NodeChange,
  EdgeChange,
  MiniMap,
  Controls,
  Background,
  BackgroundVariant,
  Panel,
  ReactFlowProvider,
  useReactFlow,
} from 'reactflow';
import 'reactflow/dist/style.css';
import { Compass, Crosshair, Keyboard, Maximize2, Minimize2, ZoomIn, ZoomOut } from 'lucide-react';

import { FlowDefinition, FlowNode, FlowEdge } from '@/lib/flowTypes';
import { toReactFlowNodes, toReactFlowEdges, fromReactFlowNodes, fromReactFlowEdges } from '@/lib/converters';
import { deleteNode, duplicateNode } from '@/lib/nodeOperations';

import StartNodeComponent from './nodes/StartNode';
import ScreenNodeComponent from './nodes/ScreenNode';
import InputNodeComponent from './nodes/InputNode';
import ConditionNodeComponent from './nodes/ConditionNode';
import WebhookNodeComponent from './nodes/WebhookNode';
import ActionNodeComponent from './nodes/ActionNode';
import EndNodeComponent from './nodes/EndNode';
import CustomEdge from './CustomEdge';
import ContextMenu from './ContextMenu';

// ─── Node type components mapping ──────────────────────────────────────────

const nodeTypes = {
  start: StartNodeComponent,
  screen: ScreenNodeComponent,
  input: InputNodeComponent,
  condition: ConditionNodeComponent,
  webhook: WebhookNodeComponent,
  action: ActionNodeComponent,
  end: EndNodeComponent,
  custom: StartNodeComponent, // Fallback for unmapped types
};

const edgeTypes = {
  custom: CustomEdge,
  default: CustomEdge,
};

// ─── Component props ──────────────────────────────────────────────────────────

export interface CanvasEditorProps {
  /** The flow definition to render */
  definition: FlowDefinition;

  /** Callback when flow definition changes (nodes, edges, or positions) */
  onChange: (definition: FlowDefinition) => void;

  /** Callback when a node is selected for editing */
  onNodeClick?: (nodeId: string) => void;

  /** Validation state per node id for visual highlighting */
  nodeValidation?: Record<string, { severity: 'error' | 'warning'; messages: string[] }>;

  /** Whether the canvas is in read-only mode */
  readOnly?: boolean;

  /** Custom class name for the canvas container */
  className?: string;
}

// ─── Main component ───────────────────────────────────────────────────────────

function CanvasEditorInner({
  definition,
  onChange,
  onNodeClick,
  nodeValidation = {},
  readOnly = false,
  className = '',
}: CanvasEditorProps) {
  const { fitView, zoomIn, zoomOut } = useReactFlow();
  const [nodes, setNodes] = useNodesState<FlowNode>([]);
  const [edges, setEdges] = useEdgesState<FlowEdge>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; nodeId: string } | null>(null);
  const [jsonViewNode, setJsonViewNode] = useState<string | null>(null);
  const [showShortcuts, setShowShortcuts] = useState(false);

  // Initialize nodes and edges from definition
  useEffect(() => {
    const rfNodes = toReactFlowNodes(definition).map((node) => ({
      ...node,
      data: {
        ...node.data,
        validation: nodeValidation[node.id],
      },
    }));
    const rfEdges = toReactFlowEdges(definition);

    setNodes(rfNodes);
    setEdges(rfEdges);
  }, [definition, nodeValidation, setNodes, setEdges]);

  const errorNodeCount = Object.values(nodeValidation).filter((item) => item.severity === 'error').length;
  const warningNodeCount = Object.values(nodeValidation).filter((item) => item.severity === 'warning').length;

  // Handle node position changes
  const handleNodesChange = useCallback(
    (changes: NodeChange[]) => {
      const nextNodes = applyNodeChanges(changes, nodes);
      setNodes(nextNodes);

      // Detect if this is a position change
      const positionChanges = changes.filter((c) => c.type === 'position' && 'position' in c);
      if (positionChanges.length > 0) {
        const { updatedDefinition } = fromReactFlowNodes(nextNodes, definition);
        onChange(updatedDefinition);
      }
    },
    [nodes, definition, onChange, setNodes]
  );

  // Handle edge changes (connections added/removed)
  const handleEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      const nextEdges = applyEdgeChanges(changes, edges);
      setEdges(nextEdges);

      // Keep flow routing in sync after edge mutations
      const structuralChanges = changes.some((change) => change.type !== 'select');
      if (structuralChanges) {
        const updatedDef = fromReactFlowEdges(nextEdges, definition);
        onChange(updatedDef);
      }
    },
    [edges, definition, onChange, setEdges]
  );

  // Handle new edge connection
  const handleConnect = useCallback(
    (connection: Connection) => {
      const newEdge = addEdge(connection, edges);
      setEdges(newEdge);

      // Update definition
      const updatedDef = fromReactFlowEdges(newEdge, definition);
      onChange(updatedDef);
    },
    [edges, definition, onChange, setEdges]
  );

  // Handle node click for editing or context menu
  const handleNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      setSelectedNodeId(node.id);
      onNodeClick?.(node.id);
    },
    [onNodeClick]
  );

  // Handle right-click for context menu
  const handleNodeContextMenu = useCallback(
    (e: React.MouseEvent, node: Node) => {
      e.preventDefault();
      setSelectedNodeId(node.id);
      setContextMenu({
        x: e.clientX,
        y: e.clientY,
        nodeId: node.id,
      });
    },
    []
  );

  // Delete node handler
  const handleDeleteNode = useCallback(
    (nodeId: string) => {
      const { updatedDefinition, warnings } = deleteNode(definition, nodeId);
      
      if (warnings.length > 0) {
        console.warn(warnings.join('\n'));
      }

      onChange(updatedDefinition);
      setSelectedNodeId(null);
    },
    [definition, onChange]
  );

  // Duplicate node handler
  const handleDuplicateNode = useCallback(
    (nodeId: string) => {
      const { updatedDefinition, newNodeId } = duplicateNode(definition, nodeId);
      onChange(updatedDefinition);
      setSelectedNodeId(newNodeId);
    },
    [definition, onChange]
  );

  // View JSON handler
  const handleViewJson = useCallback(
    (nodeId: string) => {
      setJsonViewNode(nodeId);
    },
    []
  );

  // Pane click: deselect
  const handlePaneClick = useCallback(() => {
    setSelectedNodeId(null);
    setContextMenu(null);
  }, []);

  const selectedNode = nodes.find((node) => node.id === selectedNodeId);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!selectedNodeId) return;

      // Delete key
      if (e.key === 'Delete') {
        e.preventDefault();
        handleDeleteNode(selectedNodeId);
      }

      // Ctrl/Cmd+D for duplicate
      if ((e.ctrlKey || e.metaKey) && e.key === 'd') {
        e.preventDefault();
        handleDuplicateNode(selectedNodeId);
      }

      // Escape to deselect
      if (e.key === 'Escape') {
        setSelectedNodeId(null);
        setContextMenu(null);
        setShowShortcuts(false);
      }

      // Toggle shortcuts helper
      if (e.key === '?') {
        e.preventDefault();
        setShowShortcuts((prev) => !prev);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedNodeId, handleDeleteNode, handleDuplicateNode]);

  return (
    <div className={`w-full h-full relative ${className}`} style={{ background: '#ffffff' }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={handleNodesChange}
        onEdgesChange={handleEdgesChange}
        onConnect={handleConnect}
        onNodeClick={handleNodeClick}
        onNodeContextMenu={handleNodeContextMenu}
        onPaneClick={handlePaneClick}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        attributionPosition="bottom-left"
      >
        <Background variant={BackgroundVariant.Dots} gap={16} size={1} color="#d8e2eb" />
        <Controls showInteractive={!readOnly} className="!rounded-xl !border !border-slate-200 !bg-white !shadow-sm" />
        <MiniMap
          position="bottom-right"
          width={210}
          height={140}
          pannable
          zoomable
          className="!rounded-xl !border !border-slate-200 !bg-white !shadow-sm"
          nodeColor={(node) => (node.id === selectedNodeId ? '#0D2B3E' : '#00BFAE')}
          maskColor="rgba(13, 43, 62, 0.06)"
        />

        <Panel position="top-left" className="m-3 max-w-sm rounded-2xl border border-slate-200 bg-white/95 p-3 shadow-sm backdrop-blur">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Flow Workspace</p>
              <p className="text-sm font-semibold text-slate-800">Visor operacional</p>
            </div>
            <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${readOnly ? 'bg-amber-100 text-amber-700' : 'bg-emerald-100 text-emerald-700'}`}>
              {readOnly ? 'Solo lectura' : 'Editable'}
            </span>
          </div>

          <div className="mt-2 grid grid-cols-3 gap-2 text-[11px]">
            <div className="rounded-lg border border-slate-200 bg-white px-2 py-1.5">
              <p className="text-slate-500">Nodos</p>
              <p className="text-sm font-semibold text-slate-800">{nodes.length}</p>
            </div>
            <div className="rounded-lg border border-slate-200 bg-white px-2 py-1.5">
              <p className="text-slate-500">Conexiones</p>
              <p className="text-sm font-semibold text-slate-800">{edges.length}</p>
            </div>
            <div className="rounded-lg border border-slate-200 bg-white px-2 py-1.5">
              <p className="text-slate-500">Activo</p>
              <p className="truncate text-sm font-semibold text-slate-800">{selectedNode?.id ?? 'Ninguno'}</p>
            </div>
          </div>

          {(errorNodeCount > 0 || warningNodeCount > 0) && (
            <div className="mt-2 rounded-xl border border-slate-200 bg-slate-50 p-2 text-[11px] text-slate-700">
              <p className="font-semibold text-slate-700">Validacion visual</p>
              <p className="text-red-700">Errores: {errorNodeCount}</p>
              <p className="text-amber-700">Warnings: {warningNodeCount}</p>
            </div>
          )}

          {showShortcuts && (
            <div className="mt-2 rounded-xl border border-slate-200 bg-slate-50 p-2 text-[11px] text-slate-600">
              <p><span className="font-semibold text-slate-700">Delete</span> elimina nodo</p>
              <p><span className="font-semibold text-slate-700">Ctrl/Cmd + D</span> duplica nodo</p>
              <p><span className="font-semibold text-slate-700">Esc</span> limpia selección</p>
              <p><span className="font-semibold text-slate-700">?</span> muestra/oculta esta ayuda</p>
            </div>
          )}
        </Panel>

        <Panel position="top-right" className="m-3 rounded-2xl border border-slate-200 bg-white/95 p-2 shadow-sm backdrop-blur">
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => fitView({ duration: 250, padding: 0.2 })}
              className="rounded-lg border border-slate-200 bg-white p-2 text-slate-600 transition hover:border-[#00BFAE] hover:text-[#0D2B3E]"
              title="Ajustar al lienzo"
            >
              <Maximize2 className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => zoomIn({ duration: 180 })}
              className="rounded-lg border border-slate-200 bg-white p-2 text-slate-600 transition hover:border-[#00BFAE] hover:text-[#0D2B3E]"
              title="Acercar"
            >
              <ZoomIn className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => zoomOut({ duration: 180 })}
              className="rounded-lg border border-slate-200 bg-white p-2 text-slate-600 transition hover:border-[#00BFAE] hover:text-[#0D2B3E]"
              title="Alejar"
            >
              <ZoomOut className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => setShowShortcuts((prev) => !prev)}
              className={`rounded-lg border p-2 transition ${showShortcuts ? 'border-[#00BFAE] bg-[#E8FBF8] text-[#0D2B3E]' : 'border-slate-200 bg-white text-slate-600 hover:border-[#00BFAE] hover:text-[#0D2B3E]'}`}
              title="Atajos de teclado"
            >
              <Keyboard className="h-4 w-4" />
            </button>
          </div>
        </Panel>

        <Panel position="bottom-left" className="mb-6 ml-3 rounded-xl border border-slate-200 bg-white/95 px-3 py-2 text-[11px] text-slate-600 shadow-sm backdrop-blur">
          <div className="flex items-center gap-2">
            <Compass className="h-3.5 w-3.5 text-slate-500" />
            <span>Arrastra para mover nodos</span>
            <span className="text-slate-300">|</span>
            <Crosshair className="h-3.5 w-3.5 text-slate-500" />
            <span>Click derecho para acciones rápidas</span>
            <span className="text-slate-300">|</span>
            <Minimize2 className="h-3.5 w-3.5 text-slate-500" />
            <span>Scroll para zoom</span>
          </div>
        </Panel>
      </ReactFlow>

      {/* Context menu */}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          nodeId={contextMenu.nodeId}
          onEdit={(nodeId) => {
            setSelectedNodeId(nodeId);
            onNodeClick?.(nodeId);
            setContextMenu(null);
          }}
          onDelete={handleDeleteNode}
          onDuplicate={handleDuplicateNode}
          onViewJson={handleViewJson}
          onClose={() => setContextMenu(null)}
        />
      )}

      {/* JSON view modal (simplified - can be enhanced) */}
      {jsonViewNode && (
        <div
          className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center"
          onClick={() => setJsonViewNode(null)}
        >
          <div
            className="bg-white rounded-2xl p-6 max-w-2xl w-full max-h-96 overflow-auto border border-slate-200 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-semibold mb-4 text-slate-800">Node JSON</h3>
            <pre className="bg-slate-50 p-4 rounded-xl text-sm overflow-auto border border-slate-200">
              {JSON.stringify(
                definition.nodes.find((n) => n.id === jsonViewNode),
                null,
                2
              )}
            </pre>
            <button
              onClick={() => setJsonViewNode(null)}
              className="mt-4 px-4 py-2 rounded-xl border border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
            >
              Cerrar
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Wrapper component with ReactFlowProvider ─────────────────────────────────

/**
 * CanvasEditor component - main export
 *
 * Usage:
 * ```tsx
 * <CanvasEditor
 *   definition={flowDef}
 *   onChange={setFlowDef}
 *   onNodeClick={(id) => openEditModal(id)}
 * />
 * ```
 */
export const CanvasEditor: React.FC<CanvasEditorProps> = (props) => {
  return (
    <ReactFlowProvider>
      <CanvasEditorInner {...props} />
    </ReactFlowProvider>
  );
};

export default CanvasEditor;
