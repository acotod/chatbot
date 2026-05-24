/**
 * CanvasEditor - Main React Flow wrapper for WABA Flujos visual editor
 *
 * This component wraps ReactFlow and manages canvas state, interactions,
 * and synchronization with the flow definition.
 */

'use client';

import React, { useCallback, useState, useEffect, useRef } from 'react';
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
  ReactFlowProvider,
} from 'reactflow';
import 'reactflow/dist/style.css';

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
  readOnly = false,
  className = '',
}: CanvasEditorProps) {
  const [nodes, setNodes] = useNodesState<FlowNode>([]);
  const [edges, setEdges] = useEdgesState<FlowEdge>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; nodeId: string } | null>(null);
  const [jsonViewNode, setJsonViewNode] = useState<string | null>(null);
  const isSyncingFromDefinitionRef = useRef(false);

  // Initialize nodes and edges from definition
  useEffect(() => {
    isSyncingFromDefinitionRef.current = true;
    const rfNodes = toReactFlowNodes(definition);
    const rfEdges = toReactFlowEdges(definition);

    setNodes(rfNodes);
    setEdges(rfEdges);

    const resetSyncFlag = window.setTimeout(() => {
      isSyncingFromDefinitionRef.current = false;
    }, 0);

    return () => {
      window.clearTimeout(resetSyncFlag);
    };
  }, [definition, setNodes, setEdges]);

  // Handle node position changes
  const handleNodesChange = useCallback(
    (changes: NodeChange[]) => {
      const nextNodes = applyNodeChanges(changes, nodes);
      setNodes(nextNodes);

      if (isSyncingFromDefinitionRef.current) {
        return;
      }

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

      if (isSyncingFromDefinitionRef.current) {
        return;
      }

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

      if (isSyncingFromDefinitionRef.current) {
        return;
      }

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
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedNodeId, handleDeleteNode, handleDuplicateNode]);

  return (
    <div className={`w-full h-full relative ${className}`} style={{ background: '#f0f4f8' }}>
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
        <Background variant={BackgroundVariant.Dots} gap={12} size={1} />
        <Controls showInteractive={!readOnly} />
        <MiniMap position="bottom-right" width={200} height={150} />
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
            className="bg-white rounded-lg p-6 max-w-2xl w-full max-h-96 overflow-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-bold mb-4">Node JSON</h3>
            <pre className="bg-gray-100 p-4 rounded text-sm overflow-auto">
              {JSON.stringify(
                definition.nodes.find((n) => n.id === jsonViewNode),
                null,
                2
              )}
            </pre>
            <button
              onClick={() => setJsonViewNode(null)}
              className="mt-4 px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600"
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
