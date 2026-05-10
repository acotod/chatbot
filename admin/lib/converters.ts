/**
 * Bidirectional converters between internal FlowDefinition format
 * and ReactFlow nodes/edges format.
 *
 * These functions enable seamless translation without losing fidelity.
 */

import { FlowDefinition, NodeDef, FlowNode, FlowEdge, Position, PositionMap } from './flowTypes';

// ─── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_NODE_WIDTH = 180;
const DEFAULT_NODE_HEIGHT = 80;
const GRID_SPACING_X = 250;
const GRID_SPACING_Y = 150;

// ─── Convert FlowDefinition → ReactFlow nodes ──────────────────────────────────

/**
 * Transform a flow definition into ReactFlow nodes.
 * Each node gets a position from nodePositions or auto-layout defaults.
 */
export function toReactFlowNodes(definition: FlowDefinition): FlowNode[] {
  if (!definition.nodes || definition.nodes.length === 0) {
    return [];
  }

  const positions = definition.nodePositions || {};

  return definition.nodes.map((node) => {
    const position = positions[node.id] || { x: 0, y: 0 };

    return {
      id: node.id,
      type: 'custom', // Custom node component type
      data: {
        id: node.id,
        type: node.type,
        label: node.config?.label || node.config?.text || node.id,
        config: node.config,
        next: node.next,
        branches: node.branches,
      },
      position,
      draggable: true,
    };
  });
}

// ─── Convert FlowDefinition → ReactFlow edges ──────────────────────────────────

/**
 * Transform a flow definition into ReactFlow edges.
 * Edges are derived from node.next and node.branches references.
 */
export function toReactFlowEdges(definition: FlowDefinition): FlowEdge[] {
  const edges: FlowEdge[] = [];
  const nodeIds = new Set(definition.nodes.map((n) => n.id));

  definition.nodes.forEach((node) => {
    // Linear next edge
    if (node.next && nodeIds.has(node.next)) {
      edges.push({
        id: `${node.id}-next-${node.next}`,
        source: node.id,
        target: node.next,
        data: {
          label: 'next',
        },
      });
    }

    // Branch edges (for condition/menu nodes)
    if (node.branches) {
      Object.entries(node.branches).forEach(([branchKey, targetNodeId]) => {
        if (nodeIds.has(targetNodeId as string)) {
          edges.push({
            id: `${node.id}-branch-${branchKey}-${targetNodeId}`,
            source: node.id,
            target: targetNodeId as string,
            data: {
              branch: branchKey,
              label: branchKey,
            },
          });
        }
      });
    }
  });

  return edges;
}

// ─── Convert ReactFlow nodes → FlowDefinition update ──────────────────────────

/**
 * Extract node positions and properties from ReactFlow nodes.
 * Returns an updated definition with new nodePositions.
 */
export function fromReactFlowNodes(
  nodes: FlowNode[],
  definition: FlowDefinition
): {
  updatedDefinition: FlowDefinition;
  nodePositions: PositionMap;
} {
  const nodePositions: PositionMap = {};

  nodes.forEach((rfNode) => {
    nodePositions[rfNode.id] = {
      x: rfNode.position.x,
      y: rfNode.position.y,
    };
  });

  const updatedDefinition: FlowDefinition = {
    ...definition,
    nodePositions,
  };

  return { updatedDefinition, nodePositions };
}

// ─── Convert ReactFlow edges → FlowDefinition update ──────────────────────────

/**
 * Apply edge changes back to the flow definition.
 * Updates node.next and node.branches based on edge connections.
 *
 * Note: This function is called when edges are modified on the canvas.
 * Removed edges result in clearing the corresponding next/branches fields.
 */
export function fromReactFlowEdges(
  edges: FlowEdge[],
  definition: FlowDefinition
): FlowDefinition {
  const nodesById = new Map(definition.nodes.map((n) => [n.id, { ...n }]));

  // Clear all next/branches first
  nodesById.forEach((node) => {
    node.next = undefined;
    node.branches = {};
  });

  // Rebuild from edges
  edges.forEach((edge) => {
    const sourceNode = nodesById.get(edge.source);
    if (!sourceNode) return;

    if (edge.data?.branch) {
      // This is a branch edge (from condition/menu)
      if (!sourceNode.branches) {
        sourceNode.branches = {};
      }
      sourceNode.branches[edge.data.branch] = edge.target;
    } else {
      // This is a linear next edge
      sourceNode.next = edge.target;
    }
  });

  return {
    ...definition,
    nodes: Array.from(nodesById.values()),
  };
}

// ─── Add or update a single node position ──────────────────────────────────────

/**
 * Update or add a node position in the definition.
 * Useful for minor position adjustments without full re-layout.
 */
export function updateNodePosition(
  definition: FlowDefinition,
  nodeId: string,
  position: Position
): FlowDefinition {
  return {
    ...definition,
    nodePositions: {
      ...(definition.nodePositions || {}),
      [nodeId]: position,
    },
  };
}

// ─── Get node positions or empty map ──────────────────────────────────────────

export function getNodePositions(definition: FlowDefinition): PositionMap {
  return definition.nodePositions || {};
}

// ─── Check if definition has positions ────────────────────────────────────────

export function hasNodePositions(definition: FlowDefinition): boolean {
  return definition.nodePositions ? Object.keys(definition.nodePositions).length > 0 : false;
}
