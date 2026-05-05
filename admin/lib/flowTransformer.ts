/**
 * Flow Transformer — frontend counterpart.
 * Pure functions to convert between ReactFlow graph and Meta WhatsApp Flow JSON.
 * Mirrors the backend flowTransformer.js for use in the browser without network calls.
 */

import type { Node, Edge } from 'reactflow';
import type {
  MetaFlowJson,
  MetaScreen,
  MetaComponent,
  EndpointDef,
  ParseFlowResult,
  ExportFlowResult,
  FlowDiagnostic,
  NodeContent,
  ScreenContent,
  InputContent,
  ConditionContent,
  WebhookContent,
  EndContent,
} from './flowTypes';
import { resolveNodeType } from './flowTypes';

const META_VERSION           = '7.1' as const;
const META_DATA_API_VERSION  = '3.0' as const;
const META_LAYOUT_TYPE       = 'SingleColumnLayout' as const;

// ─── Diagnostics helper ───────────────────────────────────────────────────────

function diag(
  severity: FlowDiagnostic['severity'],
  code: string,
  message: string,
  nodeId?: string,
  fix?: string,
): FlowDiagnostic {
  return { severity, code, message, ...(nodeId ? { nodeId } : {}), ...(fix ? { fix } : {}) };
}

// ─── JSON → UI ────────────────────────────────────────────────────────────────

export function parseMetaJsonToGraph(json: unknown): ParseFlowResult {
  const diagnostics: FlowDiagnostic[] = [];

  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    return {
      action: 'parse_flow',
      nodes: [], edges: [],
      explanation: 'Input inválido',
      diagnostics: [diag('error', 'INVALID_ROOT', 'El input no es un objeto JSON válido')],
    };
  }

  const flow = json as Record<string, unknown>;
  const screens = Array.isArray(flow.screens) ? (flow.screens as Record<string, unknown>[]) : [];
  const routingModel = (flow.routing_model && typeof flow.routing_model === 'object' && !Array.isArray(flow.routing_model))
    ? (flow.routing_model as Record<string, unknown>)
    : {};

  if (screens.length === 0) {
    diagnostics.push(diag('error', 'NO_SCREENS', 'El flujo no tiene pantallas (screens)'));
  }

  const CARD_W = 200;
  const GAP_X  = 280;
  const CARD_H = 80;
  const GAP_Y  = 140;

  const nodes: Node[] = [];
  const screenIdToNodeId: Record<string, string> = {};

  screens.forEach((screen, idx) => {
    const screenId = typeof screen.id === 'string' ? screen.id : `SCREEN_${idx}`;
    const nodeId   = `screen-${screenId}`;
    screenIdToNodeId[screenId] = nodeId;

    const layout     = screen.layout as { children?: MetaComponent[] } | undefined;
    const children   = layout?.children ?? [];
    const flat       = flatComponents(children);

    const hasInput    = flat.some(c => ['TextInput', 'TextArea', 'Dropdown', 'RadioButtonsGroup', 'CheckboxGroup', 'DatePicker'].includes(c.type as string));
    const hasComplete = flat.some(c => c.type === 'Footer' && (c as Record<string, unknown>)['on-click-action'] &&
      ((c as Record<string, unknown>)['on-click-action'] as Record<string, unknown>)?.name === 'complete');

    let nodeType = 'screen';
    if (idx === 0 && (screenId === 'INIT' || screenId === 'START' || screenId === 'WELCOME')) {
      nodeType = 'start';
    } else if (hasComplete && !hasInput) {
      nodeType = 'end';
    } else if (hasInput) {
      nodeType = 'input';
    } else if (screen.terminal === true) {
      nodeType = 'end';
    }

    const col = idx % 3;
    const row = Math.floor(idx / 3);

    const content = hasInput
      ? inferInputContent(screenId, screen.title as string | undefined, children)
      : {
          label:      (screen.title as string) ?? screenId,
          title:      (screen.title as string) ?? '',
          screenId,
          components: children,
          terminal:   screen.terminal as boolean ?? false,
        } satisfies ScreenContent;

    nodes.push({
      id:       nodeId,
      type:     'default',
      position: { x: col * (CARD_W + GAP_X), y: row * (CARD_H + GAP_Y) },
      data: { label: content.label, nodeType, content },
    });

    if (!screen.id) {
      diagnostics.push(diag('warning', 'MISSING_SCREEN_ID', `Pantalla en índice ${idx} no tiene "id"; usando "${screenId}"`, nodeId));
    }
  });

  // Start node
  let startNodeId: string | undefined;
  const startNode = nodes.find(n => n.data.nodeType === 'start') ?? nodes[0];
  if (startNode) {
    startNodeId = startNode.id;
    startNode.data.nodeType = 'start';
  }

  // Build edges from routing_model
  const edges: Edge[] = [];
  let edgeIdx = 0;

  Object.entries(routingModel).forEach(([fromScreenId, targets]) => {
    const sourceNodeId = screenIdToNodeId[fromScreenId];
    if (!sourceNodeId) {
      diagnostics.push(diag('warning', 'ORPHAN_ROUTE', `routing_model referencia pantalla desconocida "${fromScreenId}"`));
      return;
    }
    const targetList = Array.isArray(targets) ? targets : [targets];
    (targetList as string[]).forEach((toScreenId) => {
      const targetNodeId = screenIdToNodeId[toScreenId];
      if (!targetNodeId) {
        diagnostics.push(diag('warning', 'BROKEN_EDGE', `"${fromScreenId}" → "${toScreenId}" apunta a pantalla inexistente`));
        return;
      }
      edges.push({ id: `e-${edgeIdx++}`, source: sourceNodeId, target: targetNodeId, animated: true });
    });
  });

  // Orphan nodes
  const targetNodeIds = new Set(edges.map(e => e.target));
  nodes.forEach(n => {
    if (n.data.nodeType !== 'start' && !targetNodeIds.has(n.id)) {
      diagnostics.push(diag('warning', 'ORPHAN_NODE', `Nodo "${n.data.label}" no tiene conexiones entrantes`, n.id, 'Conectalo a un nodo anterior'));
    }
  });

  const hasErrors = diagnostics.some(d => d.severity === 'error');

  return {
    action: 'parse_flow',
    nodes,
    edges,
    startNodeId,
    diagnostics,
    explanation: hasErrors
      ? `Flujo procesado con ${diagnostics.filter(d => d.severity === 'error').length} error(es)`
      : `Flujo importado: ${nodes.length} nodos, ${edges.length} conexiones`,
  };
}

// ─── UI → JSON ────────────────────────────────────────────────────────────────

export function buildMetaJsonFromGraph(
  rfNodes: Node[],
  rfEdges: Edge[],
  endpointCatalog: EndpointDef[] = [],
): ExportFlowResult {
  const errors:   FlowDiagnostic[] = [];
  const warnings: FlowDiagnostic[] = [];

  if (!rfNodes.length) {
    errors.push(diag('error', 'NO_NODES', 'El flujo no tiene nodos'));
    return { action: 'export_json', json: null as unknown as MetaFlowJson, validation: { errors, warnings }, explanation: 'Sin nodos' };
  }

  const startNodes = rfNodes.filter(n => resolveNodeType(n.data?.nodeType) === 'start');
  if (startNodes.length === 0) errors.push(diag('error', 'NO_START', 'Falta nodo de tipo "start"', undefined, 'Agrega un nodo inicio'));
  if (startNodes.length > 1)  errors.push(diag('error', 'MANY_STARTS', 'Hay más de un nodo "start"'));

  const endNodes = rfNodes.filter(n => resolveNodeType(n.data?.nodeType) === 'end');
  if (endNodes.length === 0) warnings.push(diag('warning', 'NO_END', 'El flujo no tiene nodo final — los usuarios podrían quedar atrapados'));

  // Cycle detection
  const adjList: Record<string, string[]> = {};
  rfNodes.forEach(n => { adjList[n.id] = []; });
  rfEdges.forEach(e => { if (adjList[e.source]) adjList[e.source].push(e.target); });
  if (detectCycle(adjList)) {
    warnings.push(diag('warning', 'CYCLE_DETECTED', 'El flujo contiene un ciclo — asegúrate de tener salida terminal', undefined, 'Agrega un nodo condición para romper el ciclo'));
  }

  // Reachability
  const reachable = new Set<string>();
  if (startNodes[0]) dfsReachable(startNodes[0].id, adjList, reachable);
  rfNodes.forEach(n => {
    if (resolveNodeType(n.data?.nodeType) !== 'start' && !reachable.has(n.id)) {
      warnings.push(diag('warning', 'UNREACHABLE_NODE', `Nodo "${n.data?.label ?? n.id}" no es alcanzable desde el inicio`, n.id, 'Conectalo o eliminalo'));
    }
  });

  const catalogIndex: Record<string, EndpointDef> = Object.fromEntries(endpointCatalog.map(ep => [ep.id, ep]));

  // Assign screenIds
  const nodeIdToScreenId: Record<string, string> = {};
  rfNodes.forEach((n, idx) => {
    const content = (n.data?.content ?? {}) as Record<string, unknown>;
    const type    = resolveNodeType(n.data?.nodeType ?? 'screen');
    let screenId  = typeof content.screenId === 'string' && content.screenId.trim()
      ? content.screenId.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_')
      : null;

    if (!screenId) {
      const base = ((content.label ?? content.title ?? type) + '_' + idx)
        .toString().toUpperCase().replace(/[^A-Z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
      screenId = base || `SCREEN_${idx}`;
    }

    let unique = screenId;
    let counter = 2;
    while (Object.values(nodeIdToScreenId).includes(unique)) {
      unique = `${screenId}_${counter++}`;
    }
    nodeIdToScreenId[n.id] = unique;
  });

  // Build screens
  const screens: MetaScreen[] = [];
  rfNodes.forEach(n => {
    const type    = resolveNodeType(n.data?.nodeType ?? 'screen');
    const content = (n.data?.content ?? {}) as NodeContent;
    const sId     = nodeIdToScreenId[n.id];

    if      (type === 'start')     screens.push(buildStartScreen(sId, content as unknown as Record<string, unknown>));
    else if (type === 'end')       screens.push(buildEndScreen(sId, content as EndContent));
    else if (type === 'condition') screens.push(buildConditionScreen(sId, content as ConditionContent));
    else if (type === 'webhook')   screens.push(buildWebhookScreen(sId, content as WebhookContent, catalogIndex, errors, n.id));
    else if (type === 'input')     screens.push(buildInputScreen(sId, content as InputContent));
    else                           screens.push(buildScreenNode(sId, content as ScreenContent));
  });

  // Build routing_model
  const routingModel: Record<string, string[]> = {};
  rfEdges.forEach(e => {
    const from = nodeIdToScreenId[e.source];
    const to   = nodeIdToScreenId[e.target];
    if (!from || !to) return;
    if (!routingModel[from]) routingModel[from] = [];
    if (!routingModel[from].includes(to)) routingModel[from].push(to);
  });

  if (errors.length > 0) {
    return {
      action: 'export_json',
      json:   null as unknown as MetaFlowJson,
      validation: { errors, warnings },
      explanation: `Export falló: ${errors.length} error(es)`,
    };
  }

  const json: MetaFlowJson = {
    version:          META_VERSION,
    data_api_version: META_DATA_API_VERSION,
    routing_model:    routingModel,
    screens,
  };

  return {
    action: 'export_json',
    json,
    validation: { errors, warnings },
    explanation: `JSON Meta listo: ${screens.length} pantalla(s)${warnings.length ? `, ${warnings.length} advertencia(s)` : ''}`,
  };
}

// ─── Screen builders ──────────────────────────────────────────────────────────

function buildStartScreen(screenId: string, c: Record<string, unknown>): MetaScreen {
  return {
    id:    screenId,
    title: String(c.title ?? c.label ?? 'Inicio'),
    layout: {
      type: META_LAYOUT_TYPE,
      children: [
        { type: 'TextHeading', text: String(c.title ?? c.label ?? 'Bienvenido') },
        ...(c.body ? [{ type: 'TextBody', text: String(c.body) }] : []),
        { type: 'Footer', label: 'Continuar', 'on-click-action': { name: 'navigate', next: { type: 'screen', name: '__NEXT__' } } },
      ],
    },
  };
}

function buildScreenNode(screenId: string, c: ScreenContent): MetaScreen {
  const children: MetaComponent[] = Array.isArray(c.components) && c.components.length > 0
    ? c.components
    : [
        { type: 'TextBody', text: (c as unknown as Record<string, unknown>).body as string || c.label || screenId },
        { type: 'Footer', label: 'Continuar', 'on-click-action': { name: 'navigate', next: { type: 'screen', name: '__NEXT__' } } },
      ];
  return { id: screenId, title: c.title || c.label || screenId, layout: { type: META_LAYOUT_TYPE, children } };
}

function buildInputScreen(screenId: string, c: InputContent): MetaScreen {
  const fieldName = c.name ?? 'respuesta';
  let inputComp: MetaComponent;
  if (c.inputType === 'select' && Array.isArray(c.options)) {
    inputComp = {
      type: 'Dropdown', label: c.label || 'Selecciona', name: fieldName,
      'data-source': c.options.map(o => ({ id: String(o.id), title: String(o.title) })),
    };
  } else {
    inputComp = {
      type: 'TextInput', label: c.placeholder || c.label || 'Tu respuesta', name: fieldName,
      'input-type': c.inputType === 'number' ? 'number' : c.inputType === 'email' ? 'email' : c.inputType === 'phone' ? 'phone' : 'text',
      required: c.required ?? true,
    };
  }
  return {
    id: screenId, title: c.title || c.label || screenId,
    layout: {
      type: META_LAYOUT_TYPE,
      children: [
        { type: 'Form', name: `${fieldName}_form`, children: [inputComp] },
        { type: 'Footer', label: 'Continuar', 'on-click-action': { name: 'data_exchange' } },
      ],
    },
  };
}

function buildConditionScreen(screenId: string, c: ConditionContent): MetaScreen {
  return {
    id: screenId, title: c.label || 'Validación',
    layout: {
      type: META_LAYOUT_TYPE,
      children: [
        { type: 'TextBody', text: c.variable ? `Evaluando: ${c.variable}` : 'Validando condición...' },
        { type: 'Footer', label: 'Continuar', 'on-click-action': { name: 'data_exchange' } },
      ],
    },
  };
}

function buildWebhookScreen(
  screenId: string,
  c: WebhookContent,
  catalog: Record<string, EndpointDef>,
  errors: FlowDiagnostic[],
  nodeId: string,
): MetaScreen {
  const ep = c.endpoint?.endpointId ? catalog[c.endpoint.endpointId] : null;
  if (c.endpoint?.endpointId && !ep) {
    errors.push(diag('error', 'UNKNOWN_ENDPOINT', `Webhook "${c.label}" usa endpoint desconocido "${c.endpoint.endpointId}"`, nodeId));
  }
  return {
    id: screenId, title: c.label || 'Consulta',
    layout: {
      type: META_LAYOUT_TYPE,
      children: [
        { type: 'TextBody', text: ep ? `Consultando: ${ep.name}` : 'Procesando...' },
        { type: 'Footer', label: 'Continuar', 'on-click-action': { name: 'data_exchange' } },
      ],
    },
    ...(ep ? { data: { endpoint_id: c.endpoint?.endpointId, body: c.endpoint?.body ?? {}, response_mapping: c.endpoint?.responseMapping ?? {} } } : {}),
  };
}

function buildEndScreen(screenId: string, c: EndContent): MetaScreen {
  return {
    id: screenId, title: c.label || 'Fin', terminal: true,
    layout: {
      type: META_LAYOUT_TYPE,
      children: [
        { type: 'TextHeading', text: c.label || 'Gracias' },
        ...(c.message ? [{ type: 'TextBody', text: c.message }] : []),
        { type: 'Footer', label: 'Finalizar', 'on-click-action': { name: 'complete' } },
      ],
    },
  };
}

// ─── Graph utilities ──────────────────────────────────────────────────────────

function detectCycle(adj: Record<string, string[]>): boolean {
  const visited = new Set<string>();
  const inStack = new Set<string>();
  const dfs = (node: string): boolean => {
    if (inStack.has(node)) return true;
    if (visited.has(node)) return false;
    visited.add(node); inStack.add(node);
    for (const nb of adj[node] ?? []) { if (dfs(nb)) return true; }
    inStack.delete(node);
    return false;
  };
  return Object.keys(adj).some(n => dfs(n));
}

function dfsReachable(start: string, adj: Record<string, string[]>, visited: Set<string>) {
  if (visited.has(start)) return;
  visited.add(start);
  (adj[start] ?? []).forEach(n => dfsReachable(n, adj, visited));
}

function inferInputContent(
  screenId: string,
  title: string | undefined,
  children: MetaComponent[],
): InputContent {
  const flat = flatComponents(children);
  const inputComp = flat.find(c => ['TextInput', 'TextArea', 'Dropdown', 'RadioButtonsGroup', 'CheckboxGroup', 'DatePicker'].includes(c.type as string)) as Record<string, unknown> | undefined;
  const label = title ?? screenId;

  if (!inputComp) {
    return {
      label,
      title: title ?? '',
      screenId,
      inputType: 'text',
      name: 'respuesta',
      placeholder: '',
      required: true,
    };
  }

  const componentType = String(inputComp.type ?? 'TextInput');
  const optionSource = Array.isArray(inputComp['data-source']) ? inputComp['data-source'] as Record<string, unknown>[] : [];
  const options = optionSource
    .map((option, index) => ({
      id: String(option.id ?? index + 1),
      title: String(option.title ?? option.label ?? option.id ?? `Opcion ${index + 1}`),
    }));

  let inputType: InputContent['inputType'] = 'text';
  if (componentType === 'Dropdown' || componentType === 'RadioButtonsGroup' || componentType === 'CheckboxGroup') {
    inputType = 'select';
  } else if (componentType === 'DatePicker') {
    inputType = 'date';
  } else if (componentType === 'TextInput') {
    const rawType = String(inputComp['input-type'] ?? 'text').toLowerCase();
    if (rawType === 'number' || rawType === 'email' || rawType === 'phone') {
      inputType = rawType;
    }
  }

  return {
    label: String(inputComp.label ?? label),
    title: title ?? '',
    screenId,
    inputType,
    name: String(inputComp.name ?? 'respuesta'),
    placeholder: String(inputComp.placeholder ?? inputComp.label ?? ''),
    required: inputComp.required !== false,
    ...(options.length > 0 ? { options } : {}),
  };
}

function flatComponents(children: MetaComponent[], result: MetaComponent[] = []): MetaComponent[] {
  if (!Array.isArray(children)) return result;
  children.forEach(c => {
    if (!c) return;
    result.push(c);
    const fc = c as Record<string, unknown>;
    if (fc.type === 'Form' && Array.isArray(fc.children)) flatComponents(fc.children as MetaComponent[], result);
  });
  return result;
}
