/**
 * Auto-layout engine for flow nodes.
 *
 * Provides layout algorithms for positioning nodes when imported
 * or when a fresh flow is created.
 *
 * Current strategy: Grid layout with support for hierarchical positioning.
 */

import { FlowDefinition, Position, PositionMap } from './flowTypes';

// ─── Configuration ────────────────────────────────────────────────────────────

const GRID_SPACING_X = 300;
const GRID_SPACING_Y = 200;
const COLS_PER_ROW = 4;

interface LayoutOptions {
  /** Grid column count before wrapping */
  colsPerRow?: number;
  /** Horizontal spacing between nodes (pixels) */
  spacingX?: number;
  /** Vertical spacing between nodes (pixels) */
  spacingY?: number;
  /** Starting X position */
  startX?: number;
  /** Starting Y position */
  startY?: number;
}

// ─── Grid layout (default, simple) ────────────────────────────────────────────

/**
 * Simple grid layout: arrange all nodes in a grid pattern.
 * Useful for imports and when no hierarchy information is available.
 *
 * @param definition Flow definition to layout
 * @param options Layout configuration
 * @returns Definition with nodePositions populated
 */
export function layoutAsGrid(
  definition: FlowDefinition,
  options: LayoutOptions = {}
): FlowDefinition {
  const {
    colsPerRow = COLS_PER_ROW,
    spacingX = GRID_SPACING_X,
    spacingY = GRID_SPACING_Y,
    startX = 50,
    startY = 50,
  } = options;

  if (!definition.nodes || definition.nodes.length === 0) {
    return definition;
  }

  const nodePositions: PositionMap = {};

  definition.nodes.forEach((node, index) => {
    const row = Math.floor(index / colsPerRow);
    const col = index % colsPerRow;

    nodePositions[node.id] = {
      x: startX + col * spacingX,
      y: startY + row * spacingY,
    };
  });

  return {
    ...definition,
    nodePositions,
  };
}

// ─── Hierarchical layout (experimental) ───────────────────────────────────────

/**
 * Hierarchical layout: arrange nodes based on their distance from entry point.
 * Nodes closer to the start appear higher, creating a top-down flow.
 *
 * @param definition Flow definition to layout
 * @param options Layout configuration
 * @returns Definition with nodePositions populated
 */
export function layoutAsHierarchy(
  definition: FlowDefinition,
  options: LayoutOptions = {}
): FlowDefinition {
  const {
    spacingX = GRID_SPACING_X,
    spacingY = GRID_SPACING_Y,
    startX = 50,
    startY = 50,
  } = options;

  if (!definition.nodes || definition.nodes.length === 0) {
    return definition;
  }

  const nodePositions: PositionMap = {};
  const levels = new Map<string, number>(); // nodeId -> hierarchy level
  const nodeMap = new Map(definition.nodes.map((n) => [n.id, n]));

  // BFS to determine hierarchy levels
  const queue: { nodeId: string; level: number }[] = [
    { nodeId: definition.entry_point, level: 0 },
  ];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const { nodeId, level } = queue.shift()!;

    if (visited.has(nodeId)) continue;
    visited.add(nodeId);

    levels.set(nodeId, level);

    const node = nodeMap.get(nodeId);
    if (!node) continue;

    // Enqueue next nodes
    if (node.next && !visited.has(node.next)) {
      queue.push({ nodeId: node.next, level: level + 1 });
    }

    if (node.branches) {
      Object.values(node.branches).forEach((targetId) => {
        if (targetId && !visited.has(targetId as string)) {
          queue.push({ nodeId: targetId as string, level: level + 1 });
        }
      });
    }
  }

  // Group nodes by level
  const levelGroups = new Map<number, string[]>();
  levels.forEach((level, nodeId) => {
    if (!levelGroups.has(level)) {
      levelGroups.set(level, []);
    }
    levelGroups.get(level)!.push(nodeId);
  });

  // Assign positions based on level and position within level
  levelGroups.forEach((nodeIds, level) => {
    const y = startY + level * spacingY;
    const totalWidth = nodeIds.length * spacingX;
    const centerX = startX + (nodeIds.length - 1) * (spacingX / 2);

    nodeIds.forEach((nodeId, index) => {
      const x = centerX - ((nodeIds.length - 1) * spacingX) / 2 + index * spacingX;
      nodePositions[nodeId] = { x, y };
    });
  });

  // For any nodes not visited (orphaned), use grid layout
  definition.nodes.forEach((node) => {
    if (!nodePositions[node.id]) {
      nodePositions[node.id] = { x: startX, y: startY + 600 };
    }
  });

  return {
    ...definition,
    nodePositions,
  };
}

// ─── Force-directed layout simulation (advanced, opt-in) ──────────────────────

/**
 * Simplified force-directed layout: simulates spring forces between connected nodes.
 * Provides more organic spacing but is more computationally expensive.
 *
 * @param definition Flow definition to layout
 * @param options Layout configuration + iterations
 * @returns Definition with nodePositions populated
 */
export function layoutAsForceDirected(
  definition: FlowDefinition,
  options: LayoutOptions & { iterations?: number } = {}
): FlowDefinition {
  const {
    spacingX = GRID_SPACING_X,
    spacingY = GRID_SPACING_Y,
    startX = 50,
    startY = 50,
    iterations = 50,
  } = options;

  if (!definition.nodes || definition.nodes.length === 0) {
    return definition;
  }

  // Initialize positions (grid)
  const nodePositions: PositionMap = {};
  const velocities = new Map<string, { vx: number; vy: number }>();

  definition.nodes.forEach((node, index) => {
    const col = index % 4;
    const row = Math.floor(index / 4);
    const x = startX + col * spacingX;
    const y = startY + row * spacingY;

    nodePositions[node.id] = { x, y };
    velocities.set(node.id, { vx: 0, vy: 0 });
  });

  const nodeMap = new Map(definition.nodes.map((n) => [n.id, n]));

  // Simulation iterations
  for (let iter = 0; iter < iterations; iter++) {
    const forces = new Map<string, { fx: number; fy: number }>();

    // Initialize forces
    definition.nodes.forEach((node) => {
      forces.set(node.id, { fx: 0, fy: 0 });
    });

    // Repulsive forces (all pairs)
    definition.nodes.forEach((nodeA, i) => {
      definition.nodes.forEach((nodeB, j) => {
        if (i >= j) return; // Avoid double-calculation

        const posA = nodePositions[nodeA.id];
        const posB = nodePositions[nodeB.id];

        const dx = posB.x - posA.x;
        const dy = posB.y - posA.y;
        const distance = Math.sqrt(dx * dx + dy * dy) + 1; // Avoid division by zero

        const repulsion = 10000 / (distance * distance);
        const angle = Math.atan2(dy, dx);

        const fx = Math.cos(angle) * repulsion;
        const fy = Math.sin(angle) * repulsion;

        forces.get(nodeA.id)!.fx -= fx;
        forces.get(nodeA.id)!.fy -= fy;
        forces.get(nodeB.id)!.fx += fx;
        forces.get(nodeB.id)!.fy += fy;
      });
    });

    // Attractive forces (connected nodes)
    definition.nodes.forEach((node) => {
      const connectedIds: string[] = [];

      if (node.next) connectedIds.push(node.next);
      if (node.branches) {
        Object.values(node.branches).forEach((id) => {
          if (typeof id === 'string') connectedIds.push(id);
        });
      }

      connectedIds.forEach((connectedId) => {
        const posA = nodePositions[node.id];
        const posB = nodePositions[connectedId];

        if (!posB) return;

        const dx = posB.x - posA.x;
        const dy = posB.y - posA.y;
        const distance = Math.sqrt(dx * dx + dy * dy) + 1;

        const springForce = (distance - spacingX) * 0.05;
        const angle = Math.atan2(dy, dx);

        const fx = Math.cos(angle) * springForce;
        const fy = Math.sin(angle) * springForce;

        forces.get(node.id)!.fx += fx;
        forces.get(node.id)!.fy += fy;
      });
    });

    // Apply forces with damping
    definition.nodes.forEach((node) => {
      const force = forces.get(node.id)!;
      const vel = velocities.get(node.id)!;
      const damping = 0.8;

      vel.vx = (vel.vx + force.fx) * damping;
      vel.vy = (vel.vy + force.fy) * damping;

      const pos = nodePositions[node.id];
      pos.x += vel.vx;
      pos.y += vel.vy;

      // Keep within bounds
      pos.x = Math.max(0, Math.min(pos.x, 2000));
      pos.y = Math.max(0, Math.min(pos.y, 2000));
    });
  }

  return {
    ...definition,
    nodePositions,
  };
}

// ─── Preserve existing positions (no-op layout) ───────────────────────────────

/**
 * If a definition already has node positions, preserve them.
 * Useful for ensuring user-arranged layouts are not lost.
 */
export function preserveExisting(definition: FlowDefinition): FlowDefinition {
  if (definition.nodePositions && Object.keys(definition.nodePositions).length > 0) {
    return definition;
  }
  return layoutAsGrid(definition);
}

// ─── Auto-layout: choose best strategy ────────────────────────────────────────

/**
 * Automatically choose and apply the best layout strategy.
 *
 * Strategy:
 * 1. If positions exist, preserve them
 * 2. If flow is small (< 10 nodes) and has clear hierarchy, use hierarchical
 * 3. Otherwise, use grid layout
 *
 * @param definition Flow definition to layout
 * @returns Definition with nodePositions populated
 */
export function autoLayout(definition: FlowDefinition): FlowDefinition {
  // If already positioned, preserve
  if (definition.nodePositions && Object.keys(definition.nodePositions).length > 0) {
    return definition;
  }

  // Determine strategy
  const nodeCount = definition.nodes?.length || 0;

  if (nodeCount === 0) {
    return definition;
  }

  if (nodeCount < 10) {
    // Small flows: try hierarchical for better visualization
    return layoutAsHierarchy(definition);
  }

  // Default: grid layout
  return layoutAsGrid(definition);
}

// ─── Utilities ────────────────────────────────────────────────────────────────

/**
 * Reset all node positions (clear nodePositions map).
 * Useful for "Re-layout" button functionality.
 */
export function clearPositions(definition: FlowDefinition): FlowDefinition {
  return {
    ...definition,
    nodePositions: undefined,
  };
}

/**
 * Recenter all nodes to fit within a bounded area.
 * Useful for ensuring nodes don't drift too far off-screen.
 */
export function recenterPositions(
  definition: FlowDefinition,
  bounds: { width: number; height: number; padding?: number } = {
    width: 1600,
    height: 1000,
    padding: 50,
  }
): FlowDefinition {
  if (!definition.nodePositions || Object.keys(definition.nodePositions).length === 0) {
    return definition;
  }

  const positions = Object.values(definition.nodePositions);
  const minX = Math.min(...positions.map((p) => p.x));
  const minY = Math.min(...positions.map((p) => p.y));
  const maxX = Math.max(...positions.map((p) => p.x));
  const maxY = Math.max(...positions.map((p) => p.y));

  const currentWidth = maxX - minX;
  const currentHeight = maxY - minY;
  const { width, height, padding = 50 } = bounds;

  const availableWidth = width - 2 * padding;
  const availableHeight = height - 2 * padding;

  let scaleX = 1;
  let scaleY = 1;

  if (currentWidth > 0) scaleX = availableWidth / currentWidth;
  if (currentHeight > 0) scaleY = availableHeight / currentHeight;

  const scale = Math.min(scaleX, scaleY, 1); // Don't enlarge
  const offsetX = padding - minX * scale;
  const offsetY = padding - minY * scale;

  const recenteredPositions: PositionMap = {};
  Object.entries(definition.nodePositions).forEach(([nodeId, pos]) => {
    recenteredPositions[nodeId] = {
      x: pos.x * scale + offsetX,
      y: pos.y * scale + offsetY,
    };
  });

  return {
    ...definition,
    nodePositions: recenteredPositions,
  };
}
