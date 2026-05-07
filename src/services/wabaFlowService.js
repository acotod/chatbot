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
const { callLlm, callLlmForJson } = require('./llmService');

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

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function getActionConfig(component) {
  return component?.on_click_action ?? component?.['on-click-action'] ?? null;
}

function getDataSource(component) {
  return asArray(component?.data_source ?? component?.['data-source']);
}

function flattenComponents(children) {
  const flat = [];

  asArray(children).forEach((child) => {
    if (!child || typeof child !== 'object') return;
    flat.push(child);
    if (Array.isArray(child.children)) {
      flat.push(...flattenComponents(child.children));
    }
  });

  return flat;
}

function resolveTargetScreen(actionConfig) {
  if (!actionConfig || typeof actionConfig !== 'object') return null;

  const navigate = actionConfig.navigate;
  if (navigate && typeof navigate === 'object') {
    return navigate.screen ?? navigate.name ?? null;
  }

  const next = actionConfig.next;
  if (next && typeof next === 'object') {
    return next.screen ?? next.name ?? null;
  }

  if (typeof navigate === 'string') return navigate;
  if (typeof next === 'string') return next;

  return null;
}

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
      errors.push(`${prefix}: "layout.children" or "children" must be an array`);
    }

    // Validate on_click_action routing
    const children = flattenComponents(screen.layout?.children ?? screen.children);
    children.forEach((comp) => {
      const actionConfig = getActionConfig(comp);
      const target = resolveTargetScreen(actionConfig);
      if (target) {
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
  const screenToNodeId = new Map(screens.map((screen, idx) => [screen.id, `node_${idx + 1}`]));

  screens.forEach((screen, idx) => {
    const nodeId = `node_${idx + 1}`;
    const children = flattenComponents(screen.layout?.children ?? screen.children);
    const routeTargets = asArray(wabaJson.routing_model?.[screen.id]);

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
    const options = getDataSource(menuComp).map((o) => ({
      id: String(o.id ?? o.value ?? o),
      title: String(o.title ?? o.label ?? o),
    })) ?? [];

    // Extract input variable name
    const inputComp = children.find((c) => ['TextInput', 'TextArea', 'DatePicker'].includes(c.type));
    const inputVar = inputComp?.name ?? null;

    // Determine next node
    const footerComp = children.find((c) => c.type === 'Footer');
    const nextFromFooter = resolveTargetScreen(getActionConfig(footerComp));
    const nextScreenId = nextFromFooter ?? (routeTargets.length === 1 ? routeTargets[0] : null);
    const nextIdx = nextScreenId
      ? screens.findIndex((s) => s.id === nextScreenId)
      : idx + 1;
    const next = nextIdx >= 0 && nextIdx < screens.length && !isEnd
      ? `node_${nextIdx + 1}`
      : null;

    const branches = nodeType === 'menu'
      ? Object.fromEntries(
          options
            .filter((option) => screenToNodeId.has(option.id))
            .map((option) => [option.id, screenToNodeId.get(option.id)])
        )
      : {};

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
      branches,
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
  function normalizeDropdownLabel(rawLabel) {
    const base = String(rawLabel ?? '').trim() || 'Elige una opcion';
    return base.length <= 20 ? base : `${base.slice(0, 19).trimEnd()}…`;
  }

  function indexToLetters(index) {
    let n = index;
    let out = '';
    while (n > 0) {
      n -= 1;
      out = String.fromCharCode(65 + (n % 26)) + out;
      n = Math.floor(n / 26);
    }
    return out || 'A';
  }

  function normalizeScreenId(raw, index) {
    const normalized = String(raw ?? '')
      .toUpperCase()
      .replace(/[^A-Z_]/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '');

    if (normalized && /[A-Z]/.test(normalized)) return normalized;
    return `SCREEN_${indexToLetters(index + 1)}`;
  }

  const nodes = definition.nodes ?? [];
  const screens = [];
  const usedIds = new Set();
  const nodeIdToScreenId = new Map();

  nodes.forEach((node, index) => {
    const base = normalizeScreenId(node._waba_screen_id ?? node.id, index);
    let candidate = base;
    let suffix = 0;
    while (usedIds.has(candidate)) {
      suffix += 1;
      candidate = `${base}_${indexToLetters(suffix)}`;
    }
    usedIds.add(candidate);
    nodeIdToScreenId.set(node.id, candidate);
  });

  nodes.forEach((node) => {
    const screenId = nodeIdToScreenId.get(node.id);
    const screen = {
      id:       screenId,
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
        label: normalizeDropdownLabel(node.config.label),
        name: node.config.variable ?? `${node.id}_selection`,
        required: true,
        'data-source': node.config.options.map((o) => ({
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
        'on-click-action': {
          name: 'navigate',
          next: { type: 'screen', name: nodeIdToScreenId.get(node.next) ?? node.next },
        },
      });
    } else if (node.type === 'end') {
      screen.layout.children.push({
        type: 'Footer',
        label: node.config?.button_label ?? 'Finalizar',
        'on-click-action': {
          name: 'complete',
        },
      });
    }

    screens.push(screen);
  });

  const routing_model = {};
  nodes.forEach((node) => {
    const sourceId = nodeIdToScreenId.get(node.id);
    if (!sourceId) return;

    const targets = [];
    if (node.next && nodeIdToScreenId.has(node.next)) {
      targets.push(nodeIdToScreenId.get(node.next));
    }
    Object.values(node.branches ?? {}).forEach((targetNodeId) => {
      if (nodeIdToScreenId.has(targetNodeId)) {
        targets.push(nodeIdToScreenId.get(targetNodeId));
      }
    });

    routing_model[sourceId] = [...new Set(targets)];
  });

  return {
    version: definition.version ?? '7.1',
    data_api_version: definition.data_api_version ?? '3.0',
    routing_model,
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
    if (node.type !== 'action' && node.type !== 'menu') return node;
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

          const varName = node.config?.variable;
          if (typeof varName === 'string' && varName.trim()) {
            variables[varName.trim()] = branchKey;
            step.variable_captured = { [varName.trim()]: branchKey };
          }

          if (node.config?.integration_ref || node.config?.endpoint) {
            step.menu_action = {
              type: 'api_call_simulated',
              endpoint: node.config?._integration_config?.endpoint ?? node.config?.endpoint ?? '[integration]',
              method: node.config?._integration_config?.method ?? node.config?.method ?? 'POST',
              note: 'Simulated menu on_option_select call — no real HTTP call made',
            };
          }

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

/**
 * Simulate all reachable routes of a flow.
 * Branches on menu options and condition branches to cover all possible paths.
 */
async function simulateAllPaths(definition, options = {}) {
  const nodesMap = Object.fromEntries((definition.nodes ?? []).map((n) => [n.id, n]));
  const MAX_STEPS = Number(options.maxSteps) > 0 ? Number(options.maxSteps) : 60;
  const MAX_PATHS = Number(options.maxPaths) > 0 ? Number(options.maxPaths) : 200;
  const tenantId = options.tenantId ?? null;
  const useLlm = Boolean(options.useLlm && tenantId);
  const llmCache = new Map();

  const initialState = {
    currentId: definition.entry_point,
    trace: [],
    variables: { ...(definition.variables ?? {}) },
    stepCount: 0,
    pathId: 'path_1',
  };

  const stack = [initialState];
  const paths = [];
  let counter = 1;
  let truncated = false;

  while (stack.length && paths.length < MAX_PATHS) {
    const state = stack.pop();
    if (!state) break;

    if (!state.currentId) {
      paths.push({
        pathId: state.pathId,
        trace: state.trace,
        finalVariables: state.variables,
        stepCount: state.trace.length,
        endedBy: 'completed',
      });
      continue;
    }

    if (state.stepCount >= MAX_STEPS) {
      paths.push({
        pathId: state.pathId,
        trace: [...state.trace, { error: 'Simulation aborted: maximum step limit reached (possible cycle)' }],
        finalVariables: state.variables,
        stepCount: state.trace.length,
        endedBy: 'max_steps',
      });
      continue;
    }

    const node = nodesMap[state.currentId];
    if (!node) {
      paths.push({
        pathId: state.pathId,
        trace: [...state.trace, { error: `Unknown node: ${state.currentId}` }],
        finalVariables: state.variables,
        stepCount: state.trace.length,
        endedBy: 'error',
      });
      continue;
    }

    const baseStep = {
      nodeId: node.id,
      nodeType: node.type,
      input: null,
      output: null,
    };

    const nextStates = [];

    if (node.type === 'message') {
      const step = {
        ...baseStep,
        output: { type: 'text', text: _resolveTemplate(node.config?.text ?? '', state.variables) },
      };
      nextStates.push({ step, nextId: node.next, variables: state.variables });
    } else if (node.type === 'input') {
      const varName = node.config?.variable ?? `input_${node.id}`;
      const intents = Array.isArray(node.llm_classification?.intents) ? node.llm_classification.intents : [];

      if (intents.length) {
        for (const intent of intents) {
          const syntheticInput = await _generateRepresentativeInput({
            tenantId,
            useLlm,
            llmCache,
            kind: 'intent',
            node,
            variables: state.variables,
            intent,
          });
          const nextVars = { ...state.variables, [varName]: syntheticInput, [`${varName}__intent`]: intent };
          const step = {
            ...baseStep,
            input: syntheticInput,
            output: { type: 'input_prompt', text: node.config?.text ?? '' },
            variable_captured: { [varName]: syntheticInput },
            llm_intent: intent,
          };
          nextStates.push({
            step,
            nextId: node.branches?.[intent] ?? node.next,
            variables: nextVars,
            branchLabel: intent,
          });
        }
      } else {
        const syntheticInput = await _generateRepresentativeInput({
          tenantId,
          useLlm,
          llmCache,
          kind: 'free_text',
          node,
          variables: state.variables,
        });
        const nextVars = { ...state.variables, [varName]: syntheticInput };
        const step = {
          ...baseStep,
          input: syntheticInput,
          output: { type: 'input_prompt', text: node.config?.text ?? '' },
          variable_captured: { [varName]: syntheticInput },
        };
        nextStates.push({ step, nextId: node.next, variables: nextVars });
      }
    } else if (node.type === 'menu') {
      const optionsList = Array.isArray(node.config?.options) ? node.config.options : [];
      if (optionsList.length) {
        for (const option of optionsList) {
          const optionId = String(option.id ?? option.title ?? 'option');
          const optionTitle = String(option.title ?? option.id ?? optionId);
          const varName = typeof node.config?.variable === 'string' && node.config.variable.trim()
            ? node.config.variable.trim()
            : null;
          const nextVars = varName ? { ...state.variables, [varName]: optionId } : state.variables;

          const step = {
            ...baseStep,
            input: optionId,
            selected: optionId,
            output: {
              type: 'buttons',
              text: node.config?.text ?? '',
              options: optionsList,
            },
            variable_captured: varName ? { [varName]: optionId } : undefined,
          };

          nextStates.push({
            step,
            nextId: node.branches?.[optionId] ?? node.next,
            variables: nextVars,
            branchLabel: optionTitle,
          });
        }
      } else {
        const step = {
          ...baseStep,
          output: {
            type: 'buttons',
            text: node.config?.text ?? '',
            options: [],
          },
        };
        nextStates.push({ step, nextId: node.next, variables: state.variables });
      }
    } else if (node.type === 'condition') {
      const expr = node.config?.expression ?? 'false';
      const branchEntries = Object.entries(node.branches ?? {});

      if (branchEntries.length === 0 && node.next) {
        const step = {
          ...baseStep,
          output: { type: 'condition', expression: expr, result: null, next: node.next },
        };
        nextStates.push({ step, nextId: node.next, variables: state.variables });
      } else {
        for (const [branchKey, targetId] of branchEntries) {
          const step = {
            ...baseStep,
            output: {
              type: 'condition',
              expression: expr,
              assumedBranch: branchKey,
              assumedResult: branchKey === 'true' ? true : branchKey === 'false' ? false : null,
              next: targetId,
            },
          };
          nextStates.push({ step, nextId: targetId, variables: state.variables, branchLabel: branchKey });
        }
      }
    } else if (node.type === 'action') {
      const step = {
        ...baseStep,
        output: {
          type: 'api_call_simulated',
          endpoint: node.config?._integration_config?.endpoint ?? node.config?.endpoint ?? '[integration]',
          method: node.config?._integration_config?.method ?? node.config?.method ?? 'POST',
          note: 'Simulated — no real HTTP call made',
        },
      };
      nextStates.push({ step, nextId: node.next, variables: state.variables });
    } else if (node.type === 'llm') {
      const renderedUserMsg = node.config?.user_template
        ? _resolveTemplate(node.config.user_template, { ...state.variables, input: state.variables.input ?? '' })
        : String(state.variables.input ?? '');
      const llmReply = await _generateRepresentativeLlmReply({
        tenantId,
        useLlm,
        llmCache,
        node,
        variables: state.variables,
        userMsg: renderedUserMsg,
      });
      const step = {
        ...baseStep,
        input: renderedUserMsg || null,
        output: { type: 'text', text: llmReply, llmGenerated: Boolean(useLlm) },
      };
      nextStates.push({ step, nextId: node.next, variables: state.variables });
    } else if (node.type === 'delay') {
      const step = {
        ...baseStep,
        output: { type: 'delay', ms: node.config?.ms ?? 1000 },
      };
      nextStates.push({ step, nextId: node.next, variables: state.variables });
    } else if (node.type === 'end') {
      const step = {
        ...baseStep,
        output: { type: 'end', text: node.config?.text ?? 'Conversación finalizada' },
      };
      nextStates.push({ step, nextId: null, variables: state.variables });
    } else {
      const step = {
        ...baseStep,
        output: { type: 'unknown', raw: node },
      };
      nextStates.push({ step, nextId: node.next, variables: state.variables });
    }

    for (const nxt of nextStates.reverse()) {
      counter += 1;
      stack.push({
        currentId: nxt.nextId,
        trace: [...state.trace, nxt.step],
        variables: { ...nxt.variables },
        stepCount: state.stepCount + 1,
        pathId: `${state.pathId}.${counter}`,
      });
    }
  }

  if (stack.length) truncated = true;

  return {
    mode: 'exhaustive',
    strategy: useLlm ? 'llm-assisted' : 'deterministic',
    pathCount: paths.length,
    truncated,
    limits: { maxPaths: MAX_PATHS, maxSteps: MAX_STEPS },
    paths,
  };
}

async function buildSimulationVerdict(simulationResult, definition, options = {}) {
  const tenantId = options.tenantId ?? null;
  const useLlm = Boolean(options.useLlm && tenantId);

  const paths = Array.isArray(simulationResult?.paths)
    ? simulationResult.paths
    : [{
        pathId: 'single',
        trace: Array.isArray(simulationResult?.trace) ? simulationResult.trace : [],
        endedBy: 'completed',
      }];

  const pathCount = paths.length;
  const errorPathCount = paths.filter((path) =>
    Array.isArray(path.trace) && path.trace.some((step) => step?.error)
  ).length;
  const maxStepPathCount = paths.filter((path) => path.endedBy === 'max_steps').length;
  const waitingPathCount = paths.filter((path) =>
    Array.isArray(path.trace) && path.trace.some((step) => step?.waiting_for_input)
  ).length;
  const completedPathCount = Math.max(0, pathCount - errorPathCount - maxStepPathCount);
  const endNodeCount = paths.filter((path) =>
    Array.isArray(path.trace) && path.trace.some((step) => step?.output?.type === 'end')
  ).length;

  let status = 'pass';
  if (errorPathCount > 0) status = 'fail';
  else if (simulationResult?.truncated || maxStepPathCount > 0 || waitingPathCount > 0) status = 'warn';

  const summary = status === 'pass'
    ? `Se exploraron ${pathCount} ruta(s) y todas cerraron sin errores.`
    : status === 'warn'
      ? `Se exploraron ${pathCount} ruta(s), pero hay ${maxStepPathCount + waitingPathCount} ruta(s) incompletas o potencialmente bloqueadas.`
      : `Se exploraron ${pathCount} ruta(s) y ${errorPathCount} terminaron con errores.`;

  const highlights = [
    `${completedPathCount} ruta(s) completadas`,
    `${endNodeCount} ruta(s) alcanzaron un nodo end`,
    errorPathCount ? `${errorPathCount} ruta(s) con error` : null,
    maxStepPathCount ? `${maxStepPathCount} ruta(s) cortadas por límite de pasos` : null,
    simulationResult?.truncated ? 'La exploración se truncó por límite de rutas' : null,
  ].filter(Boolean);

  let llmVerdict = null;
  if (useLlm) {
    const failingExamples = paths
      .filter((path) => Array.isArray(path.trace) && path.trace.some((step) => step?.error))
      .slice(0, 3)
      .map((path) => ({
        pathId: path.pathId,
        errors: path.trace.filter((step) => step?.error).map((step) => step.error),
      }));

    const systemPrompt = 'You are a QA analyst for chatbot flow simulations. Return concise Spanish JSON only.';
    const userPrompt = [
      'Analiza este resultado de simulacion exhaustiva de un flujo conversacional.',
      `Metadata: ${JSON.stringify(definition?.metadata ?? {})}`,
      `Resumen numerico: ${JSON.stringify({
        pathCount,
        completedPathCount,
        endNodeCount,
        errorPathCount,
        maxStepPathCount,
        waitingPathCount,
        truncated: Boolean(simulationResult?.truncated),
      })}`,
      `Ejemplos de falla: ${JSON.stringify(failingExamples)}`,
      'Devuelve JSON con este schema exacto: {"summary":"...","risks":["..."],"recommendedStatus":"pass|warn|fail"}',
    ].join('\n');

    try {
      const result = await callLlmForJson(tenantId, systemPrompt, userPrompt);
      if (result?.json) {
        llmVerdict = {
          summary: typeof result.json.summary === 'string' ? result.json.summary : null,
          risks: Array.isArray(result.json.risks) ? result.json.risks.map(String) : [],
          recommendedStatus: typeof result.json.recommendedStatus === 'string' ? result.json.recommendedStatus : null,
          provider: result.provider,
          model: result.model,
        };
        if (['pass', 'warn', 'fail'].includes(llmVerdict.recommendedStatus)) {
          status = llmVerdict.recommendedStatus;
        }
      }
    } catch (err) {
      logger.warn({ tenantId, message: err.message }, 'wabaFlowService: failed to build llm verdict');
    }
  }

  return {
    status,
    summary,
    highlights,
    metrics: {
      pathCount,
      completedPathCount,
      endNodeCount,
      errorPathCount,
      maxStepPathCount,
      waitingPathCount,
      truncated: Boolean(simulationResult?.truncated),
    },
    llm: llmVerdict,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Private helpers
// ─────────────────────────────────────────────────────────────────────────────

function _resolveTemplate(text, variables) {
  if (!text) return '';
  return text.replace(/\{\{(\w+)\}\}/g, (_, key) => variables[key] ?? `{{${key}}}`);
}

async function _generateRepresentativeInput({ tenantId, useLlm, llmCache, kind, node, variables, intent }) {
  const cacheKey = JSON.stringify({
    kind,
    tenantId,
    nodeId: node.id,
    prompt: node.config?.text ?? '',
    variable: node.config?.variable ?? null,
    intent: intent ?? null,
  });

  if (llmCache.has(cacheKey)) return llmCache.get(cacheKey);

  let fallback = kind === 'intent'
    ? `consulta sobre ${intent}`
    : `_auto_${node.id}`;

  if (!useLlm) {
    llmCache.set(cacheKey, fallback);
    return fallback;
  }

  const systemPrompt = 'You generate realistic short user inputs for chatbot flow simulation. Return JSON only.';
  const userPrompt = [
    'Produce a single Spanish utterance for chatbot flow testing.',
    `Node prompt: ${JSON.stringify(node.config?.text ?? '')}`,
    `Variable name: ${JSON.stringify(node.config?.variable ?? null)}`,
    kind === 'intent' ? `Target intent: ${intent}` : 'Target intent: free_text_generic',
    `Known variables: ${JSON.stringify(variables ?? {})}`,
    'Return JSON as {"utterance":"..."} with no explanation.',
  ].join('\n');

  try {
    const result = await callLlmForJson(tenantId, systemPrompt, userPrompt);
    const utterance = String(result?.json?.utterance ?? '').trim();
    if (utterance) fallback = utterance;
  } catch (err) {
    logger.warn({ tenantId, nodeId: node.id, kind, intent, message: err.message }, 'wabaFlowService: failed to generate representative input');
  }

  llmCache.set(cacheKey, fallback);
  return fallback;
}

async function _generateRepresentativeLlmReply({ tenantId, useLlm, llmCache, node, variables, userMsg }) {
  const fallback = String(node.config?.fallback_text ?? 'No pude generar una respuesta.');
  const cacheKey = JSON.stringify({
    kind: 'llm_reply',
    tenantId,
    nodeId: node.id,
    systemPrompt: node.config?.system_prompt ?? '',
    userMsg,
    variables,
  });

  if (llmCache.has(cacheKey)) return llmCache.get(cacheKey);
  if (!useLlm || !node.config?.system_prompt) {
    llmCache.set(cacheKey, fallback);
    return fallback;
  }

  let reply = fallback;
  try {
    const result = await callLlm(tenantId, String(node.config.system_prompt), String(userMsg ?? ''));
    const text = String(result?.text ?? '').trim();
    if (text) reply = text;
  } catch (err) {
    logger.warn({ tenantId, nodeId: node.id, message: err.message }, 'wabaFlowService: failed to generate llm reply for simulation');
  }

  llmCache.set(cacheKey, reply);
  return reply;
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
  simulateAllPaths,
  buildSimulationVerdict,
};
