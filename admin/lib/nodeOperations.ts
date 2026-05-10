/**
 * Node operations - utilities for delete, duplicate, and other node manipulations
 */

import { FlowDefinition, NodeDef, Position } from '@/lib/flowTypes';

// ─── Delete node ──────────────────────────────────────────────────────────────

/**
 * Delete a node from the flow definition.
 *
 * This function:
 * 1. Removes the node from the nodes array
 * 2. Removes references to this node in next/branches of other nodes
 * 3. Removes the node position
 * 4. Warns if the entry_point is deleted
 */
export function deleteNode(definition: FlowDefinition, nodeId: string): {
  updatedDefinition: FlowDefinition;
  warnings: string[];
} {
  const warnings: string[] = [];

  // Check if deleting entry point
  if (definition.entry_point === nodeId) {
    warnings.push(`⚠️ Nodo de entrada será retirado. Por favor, designar nuevo punto de entrada.`);
  }

  // Filter out the node
  const updatedNodes = definition.nodes.filter((n) => n.id !== nodeId);

  // Remove references to this node
  updatedNodes.forEach((node) => {
    if (node.next === nodeId) {
      node.next = undefined;
    }
    if (node.branches) {
      Object.keys(node.branches).forEach((key) => {
        if (node.branches![key] === nodeId) {
          delete node.branches[key];
        }
      });
      // Clean up empty branches object
      if (Object.keys(node.branches).length === 0) {
        node.branches = undefined;
      }
    }
  });

  // Remove position
  const nodePositions = { ...(definition.nodePositions || {}) };
  delete nodePositions[nodeId];

  return {
    updatedDefinition: {
      ...definition,
      nodes: updatedNodes,
      nodePositions: Object.keys(nodePositions).length > 0 ? nodePositions : undefined,
      // If entry point was deleted, set to first node (or keep it - will be validated later)
      entry_point:
        definition.entry_point === nodeId && updatedNodes.length > 0
          ? updatedNodes[0].id
          : definition.entry_point,
    },
    warnings,
  };
}

// ─── Duplicate node ───────────────────────────────────────────────────────────

/**
 * Duplicate a node in the flow definition.
 *
 * This function:
 * 1. Clones the node with a new ID (adds _copy suffix + index)
 * 2. Clears the new node's next and branches (to avoid circular refs)
 * 3. Positions it nearby (offset from original)
 */
export function duplicateNode(definition: FlowDefinition, nodeId: string): {
  updatedDefinition: FlowDefinition;
  newNodeId: string;
} {
  const sourceNode = definition.nodes.find((n) => n.id === nodeId);
  if (!sourceNode) {
    throw new Error(`Node ${nodeId} not found`);
  }

  // Generate new ID
  let newId = `${nodeId}_copy`;
  let counter = 1;
  while (definition.nodes.some((n) => n.id === newId)) {
    newId = `${nodeId}_copy_${counter}`;
    counter++;
  }

  // Clone node and clear routing (to avoid circular connections)
  const clonedNode: NodeDef = {
    ...sourceNode,
    id: newId,
    next: undefined,
    branches: undefined,
  };

  // Get position of original
  const originalPos = definition.nodePositions?.[nodeId] || { x: 0, y: 0 };
  const newPos: Position = {
    x: originalPos.x + 20,
    y: originalPos.y + 20,
  };

  const updatedNodes = [...definition.nodes, clonedNode];
  const updatedPositions = {
    ...(definition.nodePositions || {}),
    [newId]: newPos,
  };

  return {
    updatedDefinition: {
      ...definition,
      nodes: updatedNodes,
      nodePositions: updatedPositions,
    },
    newNodeId: newId,
  };
}

// ─── Delete edge ──────────────────────────────────────────────────────────────

/**
 * Delete an edge connection between two nodes.
 *
 * Clears either the 'next' or 'branches' field of the source node.
 */
export function deleteEdge(
  definition: FlowDefinition,
  sourceNodeId: string,
  targetNodeId: string,
  branchKey?: string
): FlowDefinition {
  const sourceNode = definition.nodes.find((n) => n.id === sourceNodeId);
  if (!sourceNode) return definition;

  const updatedNodes = definition.nodes.map((n) => {
    if (n.id !== sourceNodeId) return n;

    const updated = { ...n };

    if (branchKey !== undefined) {
      // Remove from branches
      if (updated.branches) {
        delete updated.branches[branchKey];
        if (Object.keys(updated.branches).length === 0) {
          updated.branches = undefined;
        }
      }
    } else {
      // Remove from next (linear connection)
      if (updated.next === targetNodeId) {
        updated.next = undefined;
      }
    }

    return updated;
  });

  return {
    ...definition,
    nodes: updatedNodes,
  };
}

// ─── Validate node connectivity ───────────────────────────────────────────────

export interface ValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Validate the flow structure:
 * - Entry point exists and points to valid node
 * - All node references (next, branches) point to existing nodes
 * - No cycles in the flow
 */
export function validateFlowStructure(definition: FlowDefinition): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const nodeIds = new Set(definition.nodes.map((n) => n.id));

  // Check entry point
  if (!definition.entry_point) {
    errors.push('Punto de entrada no definido');
  } else if (!nodeIds.has(definition.entry_point)) {
    errors.push(`Punto de entrada ${definition.entry_point} no existe`);
  }

  // Check all next/branches references
  definition.nodes.forEach((node) => {
    if (node.next && !nodeIds.has(node.next)) {
      errors.push(`Nodo ${node.id}: referencia inválida 'next' a ${node.next}`);
    }

    if (node.branches) {
      Object.entries(node.branches).forEach(([key, targetId]) => {
        if (!nodeIds.has(targetId as string)) {
          errors.push(`Nodo ${node.id}: rama '${key}' referencia nodo inexistente ${targetId}`);
        }
      });
    }
  });

  // Check for cycles (simple DFS)
  const visited = new Set<string>();
  const recursionStack = new Set<string>();

  function hasCycle(nodeId: string): boolean {
    if (!nodeIds.has(nodeId)) return false;

    visited.add(nodeId);
    recursionStack.add(nodeId);

    const node = definition.nodes.find((n) => n.id === nodeId);
    if (!node) return false;

    const nextNodes: string[] = [];
    if (node.next) nextNodes.push(node.next);
    if (node.branches) {
      Object.values(node.branches).forEach((id) => {
        if (typeof id === 'string') nextNodes.push(id);
      });
    }

    for (const next of nextNodes) {
      if (!visited.has(next)) {
        if (hasCycle(next)) return true;
      } else if (recursionStack.has(next)) {
        return true;
      }
    }

    recursionStack.delete(nodeId);
    return false;
  }

  if (hasCycle(definition.entry_point)) {
    warnings.push('⚠️ Se detectó ciclo en el flujo. Revisar rutas condicionales.');
  }

  return {
    isValid: errors.length === 0,
    errors,
    warnings,
  };
}

// ─── Find orphaned nodes ──────────────────────────────────────────────────────

/**
 * Find nodes that are not reachable from the entry point.
 * These are "orphaned" nodes that won't be executed.
 */
export function findOrphanedNodes(definition: FlowDefinition): string[] {
  if (!definition.nodes.length || !definition.entry_point) return [];

  const reachable = new Set<string>();
  const queue = [definition.entry_point];
  const nodeMap = new Map(definition.nodes.map((n) => [n.id, n]));

  while (queue.length > 0) {
    const nodeId = queue.shift()!;
    if (reachable.has(nodeId)) continue;

    reachable.add(nodeId);

    const node = nodeMap.get(nodeId);
    if (!node) continue;

    if (node.next && !reachable.has(node.next)) {
      queue.push(node.next);
    }

    if (node.branches) {
      Object.values(node.branches).forEach((id) => {
        if (typeof id === 'string' && !reachable.has(id)) {
          queue.push(id);
        }
      });
    }
  }

  return definition.nodes
    .filter((n) => !reachable.has(n.id))
    .map((n) => n.id);
}
