'use strict';
/**
 * WabaFlowService — core business logic for the WABA Flow Integration module.
 *
 * Responsibilities:
 *   validateWabaJson(json)           → { valid, errors }
 *   importFromWaba(json)             → internal FlowDefinition shape
 *   exportToWaba(flowVersion)        → Meta WABA-compatible JSON
 *   enrichDefinition(def, intMaps)   → merge integration refs into node configs
 *   simulateFlow(def, input)         → step-by-step dry-run (no side-effects)
 *
 * Node types recognized: message, input, menu, condition, action, delay, end
 * (mapped from Meta WABA screen types: text_input, opt_in, dropdown, footer, etc.)
 */

const logger = require('../utils/logger');

// ─────────────────────────────────────────────────────────────────────────────
// WABA → internal type mapping
// ─────────────────────────────────────────────────────────────────────────────
const WABA_COMPONENT_TO_NODE_TYPE = {
  TextHeading:   'message',
  TextBody:      'message',
  TextCaption:   'message',
  TextInput:     'input',
  TextArea:      'input',
  DatePicker:    'input',
  CheckboxGroup: 'menu',
  RadioButtonsGroup: 'menu',
  Dropdown:      'menu',
  OptIn:         'input',
  Image:         'message',
  Footer:        'message',
  EmbeddedLink:  'action',
};

const VALID_INTERNAL_NODE_TYPES = new Set([
  'message', 'input', 'menu', 'condition', 'action', 'delay', 'end', 'start', 'handoff', 'llm',
]);

// ─────────────────────────────────────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate an internal FlowVersion definition JSON.
 * Returns { valid: boolean, errors: string[], warnings: string[] }
 */
function validateInternalDefinition(def) {
  const errors = [];
  const warnings = [];

  if (!def || typeof def !== 'object') {
    return { valid: false, errors: ['Definition must be a non-null object'], warnings };
  }
  if (!def.entry_point) errors.push('Missing required field: entry_point');
  if (!Array.isArray(def.nodes) || def.nodes.length === 0) {
    errors.push('Definition must contain at least one node');
    return { valid: errors.length === 0, errors, warnings };
  }

  const nodeIds = new Set(def.nodes.map((n) => n.id));

  // Verify entry_point exists
  if (def.entry_point && !nodeIds.has(def.entry_point)) {
    errors.push(`entry_point "${def.entry_point}" does not match any node id`);
  }

  const endNodes = [];

  def.nodes.forEach((node, idx) => {
    const prefix = `Node[${idx}] (id="${node.id}")`;

    if (!node.id) errors.push(`Node at index ${idx} is missing "id"`);
    if (!node.type) errors.push(`${prefix}: missing "type"`);
    else if (!VALID_INTERNAL_NODE_TYPES.has(node.type)) {
      errors.push(`${prefix}: unknown type "${node.type}"`);
    }
    if (!node.config || typeof node.config !== 'object') {
      errors.push(`${prefix}: missing or invalid "config" object`);
    }

    // Type-specific validations
    if (node.type === 'message' && !node.config?.text) {
      warnings.push(`${prefix}: message node has no "config.text"`);
    }
    if (node.type === 'action') {
      if (!node.config?.integration_ref && !node.config?.endpoint) {
        errors.push(`${prefix}: action node must have "config.integration_ref" or "config.endpoint"`);
      }
    }
    if (node.type === 'condition') {
      if (!node.config?.expression) {
        errors.push(`${prefix}: condition node must have "config.expression"`);
      }
      if (!node.branches || Object.keys(node.branches || {}).length === 0) {
        errors.push(`${prefix}: condition node must define at least one branch`);
      }
    }
    if (node.type === 'menu') {
      if (!Array.isArray(node.config?.options) || node.config.options.length === 0) {
        errors.push(`${prefix}: menu node must have non-empty "config.options" array`);
      }
    }
    if (node.type === 'end') endNodes.push(node.id);

    // Validate next / branch references
    if (node.next && !nodeIds.has(node.next)) {
      errors.push(`${prefix}: "next" references unknown node "${node.next}"`);
    }
    if (node.branches) {
      Object.entries(node.branches).forEach(([condition, targetId]) => {
        if (!nodeIds.has(targetId)) {
          errors.push(`${prefix}: branch "${condition}" references unknown node "${targetId}"`);
        }
      });
    }
  });

  if (endNodes.length === 0) {
    warnings.push('Flow has no "end" node — conversation may never terminate');
  }

  // Cycle detection (simple DFS)
  const cycleErr = _detectCycles(def);
  if (cycleErr) errors.push(cycleErr);

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * Validate a raw WABA Meta Flows JSON (version 7+).
 */
function validateWabaJson(wabaJson) {
  const errors = [];
  const warnings = [];

  if (!wabaJson || typeof wabaJson !== 'object') {
    return { valid: false, errors: ['WABA JSON must be a non-null object'], warnings };
  }
  if (!wabaJson.version) warnings.push('Missing "version" field — defaulting to 7.1');
  if (!Array.isArray(wabaJson.screens) || wabaJson.screens.length === 0) {
    errors.push('WABA JSON must contain at least one screen in "screens" array');
    return { valid: false, errors, warnings };
  }

  const screenIds = new Set(wabaJson.screens.map((s) => s.id));

  wabaJson.screens.forEach((screen, idx) => {
    const prefix = `Screen[${idx}] (id="${screen.id}")`;
    if (!screen.id) errors.push(`Screen at index ${idx} missing "id"`);
    if (!screen.title) warnings.push(`${prefix}: missing "title"`);
    if (!Array.isArray(screen.layout?.children) && !Array.isArray(screen.children)) {
      warnings.push(`${prefix}: no children/layout components found`);
    }

    // Validate on_click_action routing
    const children = screen.layout?.children ?? screen.children ?? [];
    children.forEach((comp) => {
      if (comp.on_click_action?.navigate) {
        const target = comp.on_click_action.navigate.screen ?? comp.on_click_action.navigate;
        if (target && !screenIds.has(target)) {
          errors.push(`${prefix} → component "${comp.name ?? comp.type}": navigate targets unknown screen "${target}"`);
        }
      }
    });
  });

  return { valid: errors.length === 0, errors, warnings };
}

// ─────────────────────────────────────────────────────────────────────────────
// Import: WABA JSON → internal FlowDefinition
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert a Meta WABA Flows JSON to the internal FlowVersion definition shape.
 * @param {object} wabaJson  - raw WABA JSON
 * @param {string} [flowName]
 * @returns {{ definition: object, nodeCount: number, warnings: string[] }}
 */
function importFromWaba(wabaJson, flowName) {
  const warnings = [];
  const screens = wabaJson.screens ?? [];
  const nodes = [];

  screens.forEach((screen, idx) => {
    const nodeId = `node_${idx + 1}`;
    const children = screen.layout?.children ?? screen.children ?? [];

    // Determine primary type from components
    const hasInput = children.some((c) => ['TextInput', 'TextArea', 'DatePicker', 'OptIn'].includes(c.type));
    const hasMenu  = children.some((c) => ['Dropdown', 'RadioButtonsGroup', 'CheckboxGroup'].includes(c.type));
    const isEnd    = screen.terminal === true || idx === screens.length - 1;

    let nodeType = 'message';
    if (isEnd && !hasInput && !hasMenu) nodeType = 'end';
    else if (hasMenu) nodeType = 'menu';
    else if (hasInput) nodeType = 'input';

    // Extract text content (first TextHeading or TextBody)
    const textComp = children.find((c) => ['TextHeading', 'TextBody', 'TextCaption'].includes(c.type));
    const text = textComp?.text ?? screen.title ?? `Screen ${idx + 1}`;

    // Extract options for menu nodes
    const menuComp = children.find((c) => ['Dropdown', 'RadioButtonsGroup', 'CheckboxGroup'].includes(c.type));
    const options = menuComp?.data_source?.map((o) => ({
      id: String(o.id ?? o.value ?? o),
      title: String(o.title ?? o.label ?? o),
    })) ?? [];

    // Extract input variable name
    const inputComp = children.find((c) => ['TextInput', 'TextArea', 'DatePicker'].includes(c.type));
    const inputVar = inputComp?.name ?? null;

    // Determine next node
    const footerComp = children.find((c) => c.type === 'Footer');
    let nextScreenId = null;
    if (footerComp?.on_click_action?.navigate?.screen) {
      nextScreenId = footerComp.on_click_action.navigate.screen;
    }
    const nextIdx = nextScreenId
      ? screens.findIndex((s) => s.id === nextScreenId)
      : idx + 1;
    const next = nextIdx >= 0 && nextIdx < screens.length && !isEnd
      ? `node_${nextIdx + 1}`
      : null;

    const config = { text };
    if (nodeType === 'menu' && options.length) config.options = options;
    if (nodeType === 'input' && inputVar) config.variable = inputVar;
    if (screen.data_api_version) config.data_api_version = screen.data_api_version;

    // Preserve original screen data in config for round-trip fidelity
    config._waba_screen = screen;

    nodes.push({
      id: nodeId,
      type: nodeType,
      config,
      next,
      branches: {},
      _waba_screen_id: screen.id,
    });
  });

  if (nodes.length > 0 && nodes[nodes.length - 1].type !== 'end') {
    nodes[nodes.length - 1].type = 'end';
    nodes[nodes.length - 1].next = null;
    warnings.push('Last screen was auto-converted to "end" node');
  }

  const definition = {
    version: wabaJson.version ?? '7.1',
    entry_point: nodes[0]?.id ?? 'node_1',
    nodes,
    variables: {},
    integrations: {},
    metadata: {
      imported_from: 'waba',
      waba_version: wabaJson.version,
      flow_name: flowName ?? wabaJson.routing_model?.entry_screen ?? 'Imported Flow',
      screen_count: screens.length,
    },
  };

  return { definition, nodeCount: nodes.length, warnings };
}

// ─────────────────────────────────────────────────────────────────────────────
// Export: internal FlowDefinition → WABA JSON
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert an internal FlowVersion definition back to Meta WABA Flows JSON.
 */
function exportToWaba(definition) {
  const nodes = definition.nodes ?? [];
  const screens = [];

  nodes.forEach((node) => {
    // If we have the original WABA screen preserved, use it for round-trip fidelity
    if (node.config?._waba_screen) {
      screens.push({ ...node.config._waba_screen });
      return;
    }

    // Otherwise, synthesize a screen from the node definition
    const screen = {
      id:       node._waba_screen_id ?? node.id,
      title:    node.config?.title ?? node.config?.text ?? `Screen ${node.id}`,
      terminal: node.type === 'end',
      layout: {
        type: 'SingleColumnLayout',
        children: [],
      },
    };

    if (node.config?.text) {
      screen.layout.children.push({
        type: 'TextBody',
        text: node.config.text,
      });
    }

    if (node.type === 'input' && node.config?.variable) {
      screen.layout.children.push({
        type: 'TextInput',
        label: node.config.label ?? node.config.variable,
        name: node.config.variable,
        required: true,
        'input-type': node.config.input_type ?? 'text',
      });
    }

    if (node.type === 'menu' && Array.isArray(node.config?.options)) {
      screen.layout.children.push({
        type: 'Dropdown',
        label: node.config.label ?? 'Selecciona una opción',
        name: `${node.id}_selection`,
        required: true,
        data_source: node.config.options.map((o) => ({
          id: o.id,
          title: o.title,
        })),
      });
    }

    // Add footer with navigation
    if (node.type !== 'end' && node.next) {
      screen.layout.children.push({
        type: 'Footer',
        label: node.config?.button_label ?? 'Continuar',
        on_click_action: {
          name: 'navigate',
          navigate: {
            screen: node.next,
          },
          payload: {},
        },
      });
    } else if (node.type === 'end') {
      screen.layout.children.push({
        type: 'Footer',
        label: node.config?.button_label ?? 'Finalizar',
        on_click_action: {
          name: 'complete',
          payload: {},
        },
      });
    }

    screens.push(screen);
  });

  return {
    version: definition.version ?? '7.1',
    data_api_version: definition.data_api_version ?? '3.0',
    routing_model: {
      entry_screen: nodes[0]?._waba_screen_id ?? nodes[0]?.id ?? 'SCREEN_1',
    },
    screens,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Enrichment: merge integration references into node configs
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Enrich flow definition nodes with integration config snapshots.
 * action nodes with config.integration_ref get a resolved config.integration_config injected.
 *
 * @param {object} definition - internal flow definition
 * @param {Map<string,object>} integrationMap  - name → Integration DB record
 * @returns {object} enriched definition (shallow copy)
 */
function enrichDefinition(definition, integrationMap) {
  const enrichedNodes = definition.nodes.map((node) => {
    if (node.type !== 'action') return node;
    const ref = node.config?.integration_ref;
    if (!ref) return node;
    const intConfig = integrationMap.get(ref);
    if (!intConfig) {
      logger.warn({ ref }, 'wabaFlowService: integration_ref not found');
      return node;
    }
    return {
      ...node,
      config: {
        ...node.config,
        _integration_config: {
          endpoint: intConfig.config?.endpoint,
          method:   intConfig.config?.method ?? 'POST',
          headers:  intConfig.config?.headers ?? {},
        },
      },
    };
  });
  return { ...definition, nodes: enrichedNodes };
}

// ─────────────────────────────────────────────────────────────────────────────
// Simulation: dry-run without side effects
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Simulate a flow given a sequence of user inputs.
 * Returns a step-by-step trace: [ { nodeId, nodeType, output, input } ]
 */
function simulateFlow(definition, inputs = []) {
  const nodesMap = Object.fromEntries((definition.nodes ?? []).map((n) => [n.id, n]));
  const trace = [];
  const variables = { ...(definition.variables ?? {}) };

  let currentId = definition.entry_point;
  let inputIdx = 0;
  const MAX_STEPS = 50; // guard against infinite loops
  let steps = 0;

  while (currentId && steps < MAX_STEPS) {
    steps++;
    const node = nodesMap[currentId];
    if (!node) {
      trace.push({ error: `Unknown node: ${currentId}` });
      break;
    }

    const userInput = inputs[inputIdx] ?? null;
    const step = { nodeId: node.id, nodeType: node.type, input: userInput, output: null };

    switch (node.type) {
      case 'message':
        step.output = { type: 'text', text: _resolveTemplate(node.config?.text ?? '', variables) };
        currentId = node.next;
        break;

      case 'input': {
        step.output = { type: 'input_prompt', text: node.config?.text ?? '' };
        if (userInput !== null) {
          const varName = node.config?.variable ?? `input_${node.id}`;
          variables[varName] = userInput;
          step.variable_captured = { [varName]: userInput };
          inputIdx++;
        } else {
          step.waiting_for_input = true;
        }
        currentId = userInput !== null ? node.next : null;
        break;
      }

      case 'menu': {
        step.output = {
          type: 'buttons',
          text: node.config?.text ?? '',
          options: node.config?.options ?? [],
        };
        if (userInput !== null) {
          const selected = (node.config?.options ?? []).find(
            (o) => o.id === userInput || o.title === userInput
          );
          const branchKey = selected?.id ?? userInput;
          currentId = node.branches?.[branchKey] ?? node.next;
          step.selected = branchKey;
          inputIdx++;
        } else {
          step.waiting_for_input = true;
          currentId = null;
        }
        break;
      }

      case 'condition': {
        const expr = node.config?.expression ?? 'false';
        // Safe evaluation: only allow variable references
        const result = _evalCondition(expr, variables);
        const branchKey = result ? 'true' : 'false';
        currentId = node.branches?.[branchKey] ?? node.next;
        step.output = { type: 'condition', expression: expr, result, next: currentId };
        break;
      }

      case 'action':
        step.output = {
          type: 'api_call_simulated',
          endpoint: node.config?._integration_config?.endpoint ?? node.config?.endpoint ?? '[integration]',
          method: node.config?._integration_config?.method ?? node.config?.method ?? 'POST',
          note: 'Simulated — no real HTTP call made',
        };
        currentId = node.next;
        break;

      case 'delay':
        step.output = { type: 'delay', ms: node.config?.ms ?? 1000 };
        currentId = node.next;
        break;

      case 'end':
        step.output = { type: 'end', text: node.config?.text ?? 'Conversación finalizada' };
        currentId = null;
        break;

      default:
        step.output = { type: 'unknown', raw: node };
        currentId = node.next;
    }

    trace.push(step);
    if (!currentId) break;
  }

  if (steps >= MAX_STEPS) {
    trace.push({ error: 'Simulation aborted: maximum step limit reached (possible cycle)' });
  }

  return { trace, finalVariables: variables, stepCount: trace.length };
}

// ─────────────────────────────────────────────────────────────────────────────
// Private helpers
// ─────────────────────────────────────────────────────────────────────────────

function _resolveTemplate(text, variables) {
  if (!text) return '';
  return text.replace(/\{\{(\w+)\}\}/g, (_, key) => variables[key] ?? `{{${key}}}`);
}

function _evalCondition(expression, variables) {
  // Simple safe evaluation: only support "variable op value" patterns
  try {
    const safeExpr = expression.replace(/{{(\w+)}}/g, (_, k) => {
      const val = variables[k];
      return typeof val === 'string' ? `"${val}"` : String(val ?? 'null');
    });
    // eslint-disable-next-line no-new-func
    return Boolean(new Function('return (' + safeExpr + ')')());
  } catch {
    return false;
  }
}

function _detectCycles(def) {
  const nodes = Object.fromEntries((def.nodes ?? []).map((n) => [n.id, n]));
  const visited = new Set();
  const stack = new Set();

  function dfs(id) {
    if (stack.has(id)) return `Cycle detected involving node "${id}"`;
    if (visited.has(id)) return null;
    visited.add(id);
    stack.add(id);
    const node = nodes[id];
    if (!node) return null;
    const nexts = [node.next, ...Object.values(node.branches ?? {})].filter(Boolean);
    for (const nxt of nexts) {
      const err = dfs(nxt);
      if (err) return err;
    }
    stack.delete(id);
    return null;
  }

  return dfs(def.entry_point) ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────────────
module.exports = {
  validateInternalDefinition,
  validateWabaJson,
  importFromWaba,
  exportToWaba,
  enrichDefinition,
  simulateFlow,
};
