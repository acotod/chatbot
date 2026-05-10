/**
 * Node operations - utilities for delete, duplicate, and other node manipulations
 */

import { FlowDefinition, NodeDef, Position } from '@/lib/flowTypes';

function flattenNodes(nodes: NodeDef[]): NodeDef[] {
  return nodes.flatMap((node) => [node, ...flattenNodes(node.children || [])]);
}

function mapNodes(nodes: NodeDef[], mapper: (node: NodeDef) => NodeDef | null): NodeDef[] {
  return nodes.flatMap((node) => {
    const mappedNode = mapper(node);
    if (!mappedNode) {
      return [];
    }

    const childNodes = mappedNode.children ? mapNodes(mappedNode.children, mapper) : undefined;
    return [
      {
        ...mappedNode,
        children: childNodes && childNodes.length > 0 ? childNodes : undefined,
      },
    ];
  });
}

function getFirstNodeId(nodes: NodeDef[]): string | undefined {
  const flattened = flattenNodes(nodes);
  return flattened[0]?.id;
}

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

  if (definition.entry_point === nodeId) {
    warnings.push(`⚠️ Nodo de entrada será retirado. Por favor, designar nuevo punto de entrada.`);
  }

  const prunedNodes = mapNodes(definition.nodes, (node) => (node.id === nodeId ? null : { ...node }));
  const updatedNodes = mapNodes(prunedNodes, (node) => {
    const updatedNode = { ...node };
    if (updatedNode.next === nodeId) {
      updatedNode.next = undefined;
    }
    if (updatedNode.branches) {
      const nextBranches = Object.fromEntries(
        Object.entries(updatedNode.branches).filter(([, targetNodeId]) => targetNodeId !== nodeId)
      );
      updatedNode.branches = Object.keys(nextBranches).length > 0 ? nextBranches : undefined;
    }
    if (updatedNode.parentId === nodeId) {
      updatedNode.parentId = undefined;
    }
    return updatedNode;
  });

  const removedIds = new Set(
    flattenNodes(definition.nodes)
      .filter((node) => node.id === nodeId || node.parentId === nodeId)
      .map((node) => node.id)
  );

  if (!removedIds.has(nodeId)) {
    removedIds.add(nodeId);
  }

  if (flattenNodes(updatedNodes).length === 0) {
    warnings.push('⚠️ El flujo quedó sin nodos tras la eliminación.');
  }

  const nodePositions = { ...(definition.nodePositions || {}) };
  for (const removedId of removedIds) {
    delete nodePositions[removedId];
  }

  const nextEntryPoint = getFirstNodeId(updatedNodes);

  return {
    updatedDefinition: {
      ...definition,
      nodes: updatedNodes,
      nodePositions: Object.keys(nodePositions).length > 0 ? nodePositions : undefined,
      entry_point:
        definition.entry_point === nodeId && nextEntryPoint
          ? nextEntryPoint
          : definition.entry_point,
    },
    warnings,
  };
}

function insertDuplicate(nodes: NodeDef[], nodeId: string, duplicate: NodeDef): NodeDef[] {
  return nodes.flatMap((node) => {
    const updatedNode = {
      ...node,
      children: node.children ? insertDuplicate(node.children, nodeId, duplicate) : undefined,
    };

    if (node.id === nodeId) {
      return [updatedNode, duplicate];
    }

    return [updatedNode];
  });
}

function findNode(nodes: NodeDef[], nodeId: string): NodeDef | undefined {
  for (const node of nodes) {
    if (node.id === nodeId) {
      return node;
    }
    const childMatch = node.children ? findNode(node.children, nodeId) : undefined;
    if (childMatch) {
      return childMatch;
    }
  }

  return undefined;
}

function countNodesWithId(nodes: NodeDef[], nodeId: string): number {
  return flattenNodes(nodes).filter((node) => node.id === nodeId).length;
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
  const sourceNode = findNode(definition.nodes, nodeId);
  if (!sourceNode) {
    throw new Error(`Node ${nodeId} not found`);
  }

  // Generate new ID
  let newId = `${nodeId}_copy`;
  let counter = 1;
  while (countNodesWithId(definition.nodes, newId) > 0) {
    newId = `${nodeId}_copy_${counter}`;
    counter++;
  }

  // Clone node and clear routing (to avoid circular connections)
  const clonedNode: NodeDef = {
    ...sourceNode,
    id: newId,
    next: undefined,
    branches: undefined,
    children: undefined,
  };

  // Get position of original
  const originalPos = definition.nodePositions?.[nodeId] || { x: 0, y: 0 };
  const newPos: Position = {
    x: originalPos.x + 20,
    y: originalPos.y + 20,
  };

  const updatedNodes = insertDuplicate(definition.nodes, nodeId, clonedNode);
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
  const sourceNode = findNode(definition.nodes, sourceNodeId);
  if (!sourceNode) return definition;

  const updatedNodes = mapNodes(definition.nodes, (n) => {
    if (n.id !== sourceNodeId) return { ...n };

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
  const flattenedNodes = flattenNodes(definition.nodes);
  const nodeIds = new Set(flattenedNodes.map((n) => n.id));

  // Check entry point
  if (!definition.entry_point) {
    errors.push('Punto de entrada no definido');
  } else if (!nodeIds.has(definition.entry_point)) {
    errors.push(`Punto de entrada ${definition.entry_point} no existe`);
  }

  // Check all next/branches references
  flattenedNodes.forEach((node) => {
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

    const node = flattenedNodes.find((candidate) => candidate.id === nodeId);
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
  const flattenedNodes = flattenNodes(definition.nodes);
  const nodeMap = new Map(flattenedNodes.map((n) => [n.id, n]));

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

  return flattenedNodes
    .filter((n) => !reachable.has(n.id))
    .map((n) => n.id);
}
