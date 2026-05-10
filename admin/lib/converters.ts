/**
 * Bidirectional converters between internal FlowDefinition format
 * and ReactFlow nodes/edges format.
 *
 * These functions enable seamless translation without losing fidelity.
 */

import { FlowDefinition, NodeDef, FlowNode, FlowEdge, Position, PositionMap } from './flowTypes';

// ─── Constants ─────────────────────────────────────────────────────────────────

const GRID_SPACING_X = 250;
const GRID_SPACING_Y = 150;

interface FlattenedNode {
  node: NodeDef;
  parentId: string | null;
  depth: number;
  childCount: number;
  order: number;
}

function flattenDefinitionNodes(nodes: NodeDef[], parentId: string | null = null, depth = 0): FlattenedNode[] {
  return nodes.flatMap((node, index) => {
    const resolvedParentId = node.parentId ?? parentId;
    const childNodes = Array.isArray(node.children) ? node.children : [];
    const current: FlattenedNode = {
      node,
      parentId: resolvedParentId,
      depth,
      childCount: childNodes.length,
      order: index,
    };

    return [
      current,
      ...flattenDefinitionNodes(childNodes, node.id, depth + 1),
    ];
  });
}

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
  const flattenedNodes = flattenDefinitionNodes(definition.nodes);

  return flattenedNodes.map(({ node, parentId, depth, childCount, order }) => {
    const fallbackPosition = parentId
      ? { x: 48 + depth * 24, y: 120 + order * GRID_SPACING_Y }
      : { x: order * GRID_SPACING_X, y: depth * GRID_SPACING_Y };
    const position = positions[node.id] || fallbackPosition;

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
        parentId,
        hierarchy: {
          depth,
          childCount,
          isParent: childCount > 0,
          isChild: depth > 0,
        },
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
  const flattenedNodes = flattenDefinitionNodes(definition.nodes);
  const nodeIds = new Set(flattenedNodes.map(({ node }) => node.id));

  flattenedNodes.forEach(({ node }) => {
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

function mapNodeTree(nodes: NodeDef[], updater: (node: NodeDef) => NodeDef): NodeDef[] {
  return nodes.map((node) => {
    const updatedNode = updater(node);
    return {
      ...updatedNode,
      children: updatedNode.children ? mapNodeTree(updatedNode.children, updater) : updatedNode.children,
    };
  });
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
  const flattenedNodes = flattenDefinitionNodes(definition.nodes);
  const nodesById = new Map(flattenedNodes.map(({ node, parentId }) => [node.id, {
    ...node,
    parentId,
    next: undefined,
    branches: undefined,
  }]));

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

  const updatedNodes = mapNodeTree(definition.nodes, (node) => {
    const updatedNode = nodesById.get(node.id);
    if (!updatedNode) {
      return node;
    }

    return {
      ...updatedNode,
      branches:
        updatedNode.branches && Object.keys(updatedNode.branches).length > 0
          ? updatedNode.branches
          : undefined,
    };
  });

  return {
    ...definition,
    nodes: updatedNodes,
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
