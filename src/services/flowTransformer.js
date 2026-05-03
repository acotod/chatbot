'use strict';
/**
 * Flow Transformer — bidirectional conversion engine.
 *
 * UI Graph (nodes + edges)  ⇄  Meta WhatsApp Flow JSON
 *
 * Meta JSON contract:
 * {
 *   "version": "7.1",
 *   "data_api_version": "3.0",
 *   "routing_model": { "SCREEN_ID": ["NEXT_SCREEN_ID", ...] },
 *   "screens": [ { id, title, terminal?, layout: { type, children } } ]
 * }
 *
 * Node types:
 *   start | screen | input | condition | webhook | end
 *   (legacy: message → screen, question → input, action → webhook)
 */

const logger = require('../utils/logger');

// ─── Constants ────────────────────────────────────────────────────────────────

const META_VERSION          = '7.1';
const META_DATA_API_VERSION = '3.0';
const META_LAYOUT_TYPE      = 'SingleColumnLayout';
const SCREEN_ID_RE          = /^[A-Z0-9_]+$/;

const LEGACY_TYPE_MAP = {
  message:  'screen',
  question: 'input',
  action:   'webhook',
};

function resolveType(type) {
  return LEGACY_TYPE_MAP[type] ?? type;
}

// ─── Diagnostics ──────────────────────────────────────────────────────────────

function diag(severity, code, message, nodeId, fix) {
  return { severity, code, message, ...(nodeId ? { nodeId } : {}), ...(fix ? { fix } : {}) };
}

// ─── JSON → UI (parse) ────────────────────────────────────────────────────────

/**
 * Convert a Meta WhatsApp Flow JSON into ReactFlow nodes + edges.
 *
 * @param {object} json  Parsed Meta Flow JSON
 * @returns {{ nodes: object[], edges: object[], startNodeId: string|null, diagnostics: object[] }}
 */
function parseMetaJsonToGraph(json) {
  const diagnostics = [];

  if (!json || typeof json !== 'object') {
    return {
      nodes: [], edges: [],
      startNodeId: null,
      diagnostics: [diag('error', 'INVALID_ROOT', 'The input is not a valid JSON object')],
    };
  }

  const screens = Array.isArray(json.screens) ? json.screens : [];
  const routingModel = (json.routing_model && typeof json.routing_model === 'object')
    ? json.routing_model
    : {};

  if (screens.length === 0) {
    diagnostics.push(diag('error', 'NO_SCREENS', 'The flow has no screens'));
  }

  // Build nodes — one per screen
  const CARD_W = 200;
  const CARD_H = 80;
  const GAP_X  = 280;
  const GAP_Y  = 140;

  const nodes = [];
  const screenIdToNodeId = {};

  screens.forEach((screen, idx) => {
    const screenId = screen.id ?? `SCREEN_${idx}`;
    const nodeId   = `screen-${screenId}`;
    screenIdToNodeId[screenId] = nodeId;

    // Determine canonical node type
    let nodeType = 'screen';
    const children = screen.layout?.children ?? [];
    const flat     = flatComponents(children);

    const hasInput    = flat.some(c => ['TextInput', 'TextArea', 'Dropdown', 'RadioButtonsGroup', 'CheckboxGroup', 'DatePicker'].includes(c.type));
    const hasTerminal = screen.terminal === true || flat.some(c => c.type === 'Footer' && c['on-click-action']?.name === 'complete');

    if (idx === 0 && (screen.id === 'INIT' || screen.id === 'START' || screen.id === 'WELCOME')) {
      nodeType = 'start';
    } else if (hasTerminal && !hasInput) {
      nodeType = 'end';
    } else if (hasInput) {
      nodeType = 'input';
    }

    // Arrange in a grid: 3 columns
    const col = idx % 3;
    const row = Math.floor(idx / 3);

    nodes.push({
      id:       nodeId,
      type:     'default',
      position: { x: col * (CARD_W + GAP_X), y: row * (CARD_H + GAP_Y) },
      data: {
        label:    screen.title ?? screenId,
        nodeType,
        content: {
          label:      screen.title ?? screenId,
          screenId,
          title:      screen.title ?? '',
          components: children,
          terminal:   screen.terminal ?? false,
        },
      },
    });

    if (!screen.id) {
      diagnostics.push(diag('warning', 'MISSING_SCREEN_ID', `Screen at index ${idx} has no id; using auto-id "${screenId}"`, nodeId));
    }
  });

  // Start node override: if none was set by heuristic, mark first
  let startNodeId = null;
  const startNode = nodes.find(n => n.data.nodeType === 'start') ?? nodes[0] ?? null;
  if (startNode) {
    startNodeId = startNode.id;
    startNode.data.nodeType = startNode.data.nodeType === 'start' ? 'start' : 'start';
    if (nodes[0] && nodes[0].id !== startNode.id) {
      diagnostics.push(diag('info', 'START_INFERRED', `No INIT screen found; treating "${nodes[0].id}" as start`));
    }
  }

  // Build edges from routing_model
  const edges = [];
  let edgeIdx = 0;

  Object.entries(routingModel).forEach(([fromScreenId, targets]) => {
    const sourceNodeId = screenIdToNodeId[fromScreenId];
    if (!sourceNodeId) {
      diagnostics.push(diag('warning', 'ORPHAN_ROUTE', `routing_model references unknown screen "${fromScreenId}"`));
      return;
    }
    const targetList = Array.isArray(targets) ? targets : [targets];
    targetList.forEach((toScreenId) => {
      const targetNodeId = screenIdToNodeId[toScreenId];
      if (!targetNodeId) {
        diagnostics.push(diag('warning', 'BROKEN_EDGE', `routing_model "${fromScreenId}" → "${toScreenId}" but target screen not found`));
        return;
      }
      edges.push({
        id:       `e-${edgeIdx++}`,
        source:   sourceNodeId,
        target:   targetNodeId,
        animated: true,
      });
    });
  });

  // Detect orphan nodes (no incoming edges except start)
  const targetNodeIds = new Set(edges.map(e => e.target));
  nodes.forEach(n => {
    if (n.data.nodeType !== 'start' && !targetNodeIds.has(n.id)) {
      diagnostics.push(diag('warning', 'ORPHAN_NODE', `Node "${n.data.label}" (${n.id}) has no incoming connections`, n.id, 'Connect it to a preceding node'));
    }
  });

  return { nodes, edges, startNodeId, diagnostics };
}

// ─── UI → JSON (export) ───────────────────────────────────────────────────────

/**
 * Build a Meta-compatible WhatsApp Flow JSON from ReactFlow nodes + edges.
 *
 * @param {object[]} rfNodes     ReactFlow node objects (with data.content)
 * @param {object[]} rfEdges     ReactFlow edge objects
 * @param {object[]} endpointCatalog  Available endpoint definitions
 * @returns {{ json: object, validation: { errors: object[], warnings: object[] } }}
 */
function buildMetaJsonFromGraph(rfNodes, rfEdges, endpointCatalog = []) {
  const errors   = [];
  const warnings = [];

  // ── 1. Validate basic structure ────────────────────────────────────────────

  if (!Array.isArray(rfNodes) || rfNodes.length === 0) {
    errors.push(diag('error', 'NO_NODES', 'Flow has no nodes'));
    return { json: null, validation: { errors, warnings } };
  }

  const startNodes = rfNodes.filter(n => resolveType(n.data?.nodeType) === 'start');
  if (startNodes.length === 0) {
    errors.push(diag('error', 'NO_START', 'Flow must have exactly one start node', null, 'Add a node of type "start"'));
  }
  if (startNodes.length > 1) {
    errors.push(diag('error', 'MANY_STARTS', 'Flow has more than one start node', null, 'Remove extra start nodes'));
  }

  const endNodes = rfNodes.filter(n => resolveType(n.data?.nodeType) === 'end');
  if (endNodes.length === 0) {
    warnings.push(diag('warning', 'NO_END', 'Flow has no end node — users may get stuck'));
  }

  // ── 2. Detect cycles (DFS) ────────────────────────────────────────────────

  const adjList = {};
  rfNodes.forEach(n => { adjList[n.id] = []; });
  rfEdges.forEach(e => {
    if (adjList[e.source]) adjList[e.source].push(e.target);
  });

  const hasCycle = detectCycle(adjList);
  if (hasCycle) {
    warnings.push(diag('warning', 'CYCLE_DETECTED', 'Flow contains a cycle — ensure it has an exit path', null, 'Add a condition node to break the loop'));
  }

  // ── 3. Detect orphan nodes ────────────────────────────────────────────────

  const reachable = new Set();
  const startNode = startNodes[0];
  if (startNode) {
    dfsReachable(startNode.id, adjList, reachable);
  }

  rfNodes.forEach(n => {
    const type = resolveType(n.data?.nodeType);
    if (type !== 'start' && !reachable.has(n.id)) {
      warnings.push(diag('warning', 'UNREACHABLE_NODE', `Node "${n.data?.label ?? n.id}" is not reachable from start`, n.id, 'Connect it or remove it'));
    }
  });

  // ── 4. Build screen list + routing_model ──────────────────────────────────

  const screens       = [];
  const routingModel  = {};
  const catalogIndex  = Object.fromEntries((endpointCatalog ?? []).map(ep => [ep.id, ep]));

  // Assign stable screenId to each node
  const nodeIdToScreenId = {};
  rfNodes.forEach((n, idx) => {
    const content   = n.data?.content ?? {};
    const type      = resolveType(n.data?.nodeType ?? 'screen');
    let screenId    = typeof content.screenId === 'string' && content.screenId.trim()
      ? content.screenId.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_')
      : null;

    if (!screenId) {
      // Auto-generate from label or type+index
      const base = ((content.label ?? content.title ?? type) + '_' + idx)
        .toUpperCase().replace(/[^A-Z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
      screenId = base || `SCREEN_${idx}`;
    }

    // Ensure uniqueness
    let unique = screenId;
    let counter = 2;
    while (Object.values(nodeIdToScreenId).includes(unique)) {
      unique = `${screenId}_${counter++}`;
    }
    nodeIdToScreenId[n.id] = unique;
  });

  // Build screens
  rfNodes.forEach(n => {
    const type    = resolveType(n.data?.nodeType ?? 'screen');
    const content = n.data?.content ?? {};
    const sId     = nodeIdToScreenId[n.id];

    if (type === 'end') {
      // Terminal screen
      screens.push(buildEndScreen(sId, content));
      return;
    }

    if (type === 'start') {
      // Start screen uses its connected screen's content or a simple welcome
      screens.push(buildStartScreen(sId, content));
      return;
    }

    if (type === 'condition') {
      // Condition nodes become virtual routing — they don't generate a visible screen
      // They just affect routing_model; we still add a placeholder screen so routing works
      screens.push(buildConditionScreen(sId, content));
      return;
    }

    if (type === 'webhook') {
      // Webhook node: validate endpoint exists
      const endpointId = content.endpoint?.endpointId;
      if (endpointId && !catalogIndex[endpointId]) {
        errors.push(diag('error', 'UNKNOWN_ENDPOINT',
          `Webhook node "${content.label ?? sId}" references unknown endpoint "${endpointId}"`,
          n.id, 'Check the endpoint catalog'));
      }
      screens.push(buildWebhookScreen(sId, content, catalogIndex));
      return;
    }

    if (type === 'input') {
      screens.push(buildInputScreen(sId, content));
      return;
    }

    // Default: screen
    screens.push(buildScreenNode(sId, content));
  });

  // Build routing_model from edges
  rfEdges.forEach(e => {
    const fromSId = nodeIdToScreenId[e.source];
    const toSId   = nodeIdToScreenId[e.target];
    if (!fromSId || !toSId) return;
    if (!routingModel[fromSId]) routingModel[fromSId] = [];
    if (!routingModel[fromSId].includes(toSId)) {
      routingModel[fromSId].push(toSId);
    }
  });

  // ── 5. Final validation check ─────────────────────────────────────────────

  if (errors.length > 0) {
    return { json: null, validation: { errors, warnings } };
  }

  const metaJson = {
    version:          META_VERSION,
    data_api_version: META_DATA_API_VERSION,
    routing_model:    routingModel,
    screens,
  };

  return { json: metaJson, validation: { errors, warnings } };
}

// ─── Screen builders ──────────────────────────────────────────────────────────

function buildStartScreen(screenId, content) {
  return {
    id:    screenId,
    title: content.title || content.label || 'Inicio',
    layout: {
      type:     META_LAYOUT_TYPE,
      children: [
        { type: 'TextHeading', text: content.title || content.label || 'Bienvenido' },
        ...(content.body ? [{ type: 'TextBody', text: content.body }] : []),
        {
          type:   'Footer',
          label:  'Continuar',
          'on-click-action': { name: 'navigate', next: { type: 'screen', name: '__NEXT__' } },
        },
      ],
    },
  };
}

function buildScreenNode(screenId, content) {
  const components = Array.isArray(content.components) && content.components.length > 0
    ? content.components
    : [
        { type: 'TextBody', text: content.body || content.label || screenId },
        {
          type:  'Footer',
          label: 'Continuar',
          'on-click-action': { name: 'navigate', next: { type: 'screen', name: '__NEXT__' } },
        },
      ];
  return {
    id:    screenId,
    title: content.title || content.label || screenId,
    layout: { type: META_LAYOUT_TYPE, children: components },
  };
}

function buildInputScreen(screenId, content) {
  const inputType = content.inputType ?? 'text';
  const fieldName = content.name ?? 'respuesta';

  let inputComp;
  if (inputType === 'select' && Array.isArray(content.options)) {
    inputComp = {
      type:           'Dropdown',
      label:          content.label || 'Selecciona una opción',
      name:           fieldName,
      'data-source':  content.options.map(o => ({ id: String(o.id), title: String(o.title) })),
    };
  } else {
    inputComp = {
      type:        'TextInput',
      label:       content.placeholder || content.label || 'Tu respuesta',
      name:        fieldName,
      'input-type': inputType === 'number' ? 'number' : inputType === 'email' ? 'email' : inputType === 'phone' ? 'phone' : 'text',
      required:    content.required ?? true,
    };
  }

  return {
    id:    screenId,
    title: content.title || content.label || screenId,
    layout: {
      type:     META_LAYOUT_TYPE,
      children: [
        { type: 'Form', name: `${fieldName}_form`, children: [inputComp] },
        {
          type:   'Footer',
          label:  'Continuar',
          'on-click-action': { name: 'data_exchange' },
        },
      ],
    },
  };
}

function buildConditionScreen(screenId, content) {
  // Condition nodes are routing-only; they show a minimal screen
  return {
    id:    screenId,
    title: content.label || 'Validación',
    layout: {
      type:     META_LAYOUT_TYPE,
      children: [
        { type: 'TextBody', text: content.variable ? `Evaluando: ${content.variable}` : 'Validando condición...' },
        {
          type:   'Footer',
          label:  'Continuar',
          'on-click-action': { name: 'data_exchange' },
        },
      ],
    },
  };
}

function buildWebhookScreen(screenId, content, catalogIndex) {
  const endpointId = content.endpoint?.endpointId;
  const ep         = endpointId ? catalogIndex[endpointId] : null;

  return {
    id:    screenId,
    title: content.label || 'Consulta',
    layout: {
      type:     META_LAYOUT_TYPE,
      children: [
        { type: 'TextBody', text: ep ? `Consultando: ${ep.name}` : 'Procesando...' },
        {
          type:   'Footer',
          label:  'Continuar',
          'on-click-action': { name: 'data_exchange' },
        },
      ],
    },
    ...(ep ? {
      data: {
        endpoint_id:      endpointId,
        body:             content.endpoint?.body ?? {},
        response_mapping: content.endpoint?.responseMapping ?? {},
      },
    } : {}),
  };
}

function buildEndScreen(screenId, content) {
  return {
    id:       screenId,
    title:    content.title || content.label || 'Fin',
    terminal: true,
    layout: {
      type:     META_LAYOUT_TYPE,
      children: [
        { type: 'TextHeading', text: content.label || 'Gracias' },
        ...(content.message ? [{ type: 'TextBody', text: content.message }] : []),
        {
          type:   'Footer',
          label:  'Finalizar',
          'on-click-action': { name: 'complete' },
        },
      ],
    },
  };
}

// ─── Graph utilities ──────────────────────────────────────────────────────────

function detectCycle(adjList) {
  const visited = new Set();
  const inStack = new Set();
  const dfs = (node) => {
    if (inStack.has(node)) return true;
    if (visited.has(node))  return false;
    visited.add(node);
    inStack.add(node);
    for (const neighbor of (adjList[node] ?? [])) {
      if (dfs(neighbor)) return true;
    }
    inStack.delete(node);
    return false;
  };
  return Object.keys(adjList).some(n => dfs(n));
}

function dfsReachable(start, adjList, visited) {
  if (visited.has(start)) return;
  visited.add(start);
  (adjList[start] ?? []).forEach(n => dfsReachable(n, adjList, visited));
}

function flatComponents(children, result = []) {
  if (!Array.isArray(children)) return result;
  children.forEach(c => {
    if (!c) return;
    result.push(c);
    if (c.type === 'Form' && Array.isArray(c.children)) flatComponents(c.children, result);
  });
  return result;
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  parseMetaJsonToGraph,
  buildMetaJsonFromGraph,
  META_VERSION,
  META_DATA_API_VERSION,
};
