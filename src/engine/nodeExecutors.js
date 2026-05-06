'use strict';
/**
 * Node Executors — pure, stateless functions per node type.
 *
 * Each executor receives a context object and returns an ExecutorResult:
 *   {
 *     output       : object    // the response payload to send to the user
 *     nextNodeId   : string|null  // resolved next node (may differ from node.next)
 *     updatedVars  : object    // variables to merge into execution.variables
 *     terminal     : boolean   // true = end/handoff, close execution
 *     fallback     : boolean   // true = hand off to human agent
 *   }
 *
 * Executors do NOT write to the DB — that is the responsibility of ContextStore.
 * Executors do NOT call the LLM directly — they receive the llmService as a
 * dependency injection to keep them testable without network calls.
 *
 * Supported node types:
 *   start, message, input, menu, condition, action, task, llm, delay, end, handoff
 */

const logger = require('../utils/logger');

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve template strings like "Hola {{name}}" against a variables map.
 * Unknown variables are left as-is.
 */
function resolveTemplate(template, variables) {
  if (typeof template !== 'string') return template;
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    return Object.prototype.hasOwnProperty.call(variables, key)
      ? String(variables[key])
      : `{{${key}}}`;
  });
}

/**
 * Resolve all string values inside a (potentially nested) config object.
 */
function resolveConfig(config, variables) {
  if (typeof config === 'string') return resolveTemplate(config, variables);
  if (Array.isArray(config)) return config.map((item) => resolveConfig(item, variables));
  if (config && typeof config === 'object') {
    const result = {};
    for (const [k, v] of Object.entries(config)) {
      result[k] = resolveConfig(v, variables);
    }
    return result;
  }
  return config;
}

// ─────────────────────────────────────────────────────────────────────────────
// Individual executors
// ─────────────────────────────────────────────────────────────────────────────

/**
 * start — entry point node, just advances to next.
 */
async function executeStart({ node }) {
  return {
    output     : null,
    nextNodeId : node.next,
    updatedVars: {},
    terminal   : false,
    fallback   : false,
  };
}

/**
 * message — sends a text/media/template message to the user.
 */
async function executeMessage({ node, variables }) {
  const cfg = resolveConfig(node.config, variables);
  return {
    output     : { type: 'text', text: cfg.text ?? '' },
    nextNodeId : node.next,
    updatedVars: {},
    terminal   : false,
    fallback   : false,
  };
}

/**
 * menu — sends a button/list menu and waits for selection.
 * Navigation: branches[buttonId] → next node. Falls back to node.next.
 */
async function executeMenu({ node, input, variables }) {
  const cfg = resolveConfig(node.config, variables);

  // If input matches a branch key (button id), route there
  const nextFromBranch = input ? node.branches[input] ?? null : null;

  return {
    output: {
      type   : cfg.buttons?.length <= 3 ? 'buttons' : 'list',
      text   : cfg.text ?? '',
      buttons: cfg.buttons ?? [],
      sections: cfg.sections ?? [],
    },
    nextNodeId : nextFromBranch ?? node.next,
    updatedVars: {},
    terminal   : false,
    fallback   : false,
  };
}

/**
 * input — captures user text into a variable.
 * Uses llm_classification if defined and input is free text.
 */
async function executeInput({ node, input, variables, llmService, tenantId }) {
  const cfg = resolveConfig(node.config, variables);
  const updatedVars = {};

  // Store captured value in named variable
  if (cfg.variable && input != null) {
    updatedVars[cfg.variable] = input;
  }

  // LLM classification for free-text routing
  let nextNodeId = node.next;
  if (node.llm_classification?.intents?.length && input?.trim() && llmService) {
    try {
      const intent = await llmService.classifyIntent(
        tenantId,
        input.trim(),
        node.llm_classification.intents,
      );
      if (intent && node.branches[intent]) {
        nextNodeId = node.branches[intent];
      }
    } catch (err) {
      logger.warn({ tenantId, nodeId: node.id, message: err.message }, 'nodeExecutors.input: classifyIntent failed');
    }
  } else if (input != null && node.branches[input]) {
    // Direct branch match (button reply)
    nextNodeId = node.branches[input];
  }

  return {
    output     : cfg.prompt ? { type: 'text', text: cfg.prompt } : null,
    nextNodeId,
    updatedVars,
    terminal   : false,
    fallback   : false,
  };
}

/**
 * condition — evaluates a boolean expression over variables.
 * Supported syntax: "{{var}} == value", "{{var}} > number", "{{var}} != value"
 * Branches: node.branches.true → next if truthy, node.branches.false → next if falsy.
 */
async function executeCondition({ node, variables }) {
  const expr     = node.config?.expression ?? '';
  const resolved = resolveTemplate(expr, variables);
  let   result   = false;

  try {
    // Safe evaluation: only allow simple comparisons, no eval()
    const match = resolved.match(/^(.+?)\s*(==|!=|>=|<=|>|<)\s*(.+)$/);
    if (match) {
      const [, lhs, op, rhs] = match;
      const l = _coerce(lhs.trim());
      const r = _coerce(rhs.trim());
      // eslint-disable-next-line eqeqeq
      if (op === '==')  result = l == r;
      else if (op === '!=')  result = l != r;  // eslint-disable-line eqeqeq
      else if (op === '>')   result = l > r;
      else if (op === '>=')  result = l >= r;
      else if (op === '<')   result = l < r;
      else if (op === '<=')  result = l <= r;
    }
  } catch (err) {
    logger.warn({ nodeId: node.id, expr, message: err.message }, 'nodeExecutors.condition: eval error');
  }

  const branch   = result ? 'true' : 'false';
  const nextNodeId = node.branches[branch] ?? node.next;

  return { output: null, nextNodeId, updatedVars: {}, terminal: false, fallback: false };
}

/** Coerce string to number or boolean when possible. */
function _coerce(val) {
  if (val === 'true')  return true;
  if (val === 'false') return false;
  const n = Number(val);
  return Number.isNaN(n) ? val : n;
}

/**
 * action — calls an external integration (webhook / REST API).
 * node.config.integration_ref → name of Integration record for this tenant.
 * Response fields are merged into variables via response_mapping.
 */
async function executeAction({ node, variables, integrationRunner, tenantId }) {
  const cfg           = resolveConfig(node.config, variables);
  const integrationRef = cfg.integration_ref;

  if (!integrationRef || !integrationRunner) {
    logger.warn({ tenantId, nodeId: node.id }, 'nodeExecutors.action: no integration_ref or runner');
    return { output: null, nextNodeId: node.next, updatedVars: {}, terminal: false, fallback: false };
  }

  let updatedVars = {};
  try {
    const { responseVars } = await integrationRunner.run(tenantId, integrationRef, variables, {
      conversationId: variables.conversation_id ?? null,
      nodeRef: node.id ?? null,
      nodeType: node.type ?? 'action',
      trigger: 'flow_node',
    });
    updatedVars = responseVars ?? {};
  } catch (err) {
    logger.error({ tenantId, nodeId: node.id, integrationRef, message: err.message }, 'nodeExecutors.action: integration failed');
    // Route to error branch if defined, otherwise continue
    const nextNodeId = node.branches.error ?? node.next;
    return { output: null, nextNodeId, updatedVars: {}, terminal: false, fallback: false };
  }

  return { output: null, nextNodeId: node.next, updatedVars, terminal: false, fallback: false };
}

/**
 * task — orchestration hook for human-in-the-loop work.
 * Supported actions:
 *   create_task   => asks flowEngine to create/reuse a solicitud
 *   wait_for_task => asks flowEngine to pause until status target is reached
 */
async function executeTask({ node, variables }) {
  const cfg = resolveConfig(node.config, variables);
  const action = String(cfg.action ?? '').trim().toLowerCase();

  if (!action || !['create_task', 'wait_for_task'].includes(action)) {
    return {
      output     : null,
      nextNodeId : node.next,
      updatedVars: {},
      terminal   : false,
      fallback   : false,
    };
  }

  return {
    output     : null,
    nextNodeId : node.next,
    updatedVars: {},
    terminal   : false,
    fallback   : false,
    control    : {
      type: 'task',
      action,
      config: cfg,
    },
  };
}

/**
 * llm — generates a dynamic text reply via LLM and injects it into the response.
 */
async function executeLlm({ node, input, variables, llmService, tenantId }) {
  const cfg = resolveConfig(node.config, variables);

  if (!llmService || !cfg.system_prompt) {
    return {
      output     : { type: 'text', text: cfg.fallback_text ?? '' },
      nextNodeId : node.next,
      updatedVars: {},
      terminal   : false,
      fallback   : false,
    };
  }

  const userMsg = cfg.user_template
    ? resolveTemplate(cfg.user_template, { ...variables, input: input ?? '' })
    : (input ?? '');

  try {
    const result  = await llmService.callLlm(tenantId, cfg.system_prompt, userMsg);
    const replyText = result?.text ?? cfg.fallback_text ?? 'No pude generar una respuesta.';
    return {
      output     : { type: 'text', text: replyText },
      nextNodeId : node.next,
      updatedVars: {},
      terminal   : false,
      fallback   : false,
    };
  } catch (err) {
    logger.error({ tenantId, nodeId: node.id, message: err.message }, 'nodeExecutors.llm: callLlm failed');
    return {
      output     : { type: 'text', text: cfg.fallback_text ?? 'Un agente te atenderá.' },
      nextNodeId : node.branches?.error ?? node.next,
      updatedVars: {},
      terminal   : false,
      fallback   : false,
    };
  }
}

/**
 * delay — introduces a wait before the next node.
 * (In practice a production system would push to a delayed queue;
 *  here we just pass through so the engine remains stateless.)
 */
async function executeDelay({ node }) {
  return { output: null, nextNodeId: node.next, updatedVars: {}, terminal: false, fallback: false };
}

/**
 * end — terminates the flow cleanly.
 */
async function executeEnd({ node, variables }) {
  const cfg = resolveConfig(node.config, variables);
  return {
    output     : { type: 'end', text: cfg.text ?? '' },
    nextNodeId : null,
    updatedVars: {},
    terminal   : true,
    fallback   : false,
  };
}

/**
 * handoff — transfers to human agent.
 */
async function executeHandoff({ node, variables }) {
  const cfg = resolveConfig(node.config, variables);
  return {
    output     : { type: 'handoff', text: cfg.text ?? 'Un agente te atenderá.' },
    nextNodeId : null,
    updatedVars: {},
    terminal   : true,
    fallback   : true,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Executor registry
// ─────────────────────────────────────────────────────────────────────────────


/**
 * calendar node executor.
 * Supported actions: show_availability, select_slot, create_appointment,
 * reschedule_appointment, cancel_appointment.
 */
async function executeCalendar({ node, input, variables, tenantId }) {
  const calSvc = require('../services/calendarService');
  const cfg    = resolveConfig(node.config || {}, variables);
  const action = node.action || cfg.action || 'show_availability';

  if (action === 'show_availability') {
    if (!cfg.calendar_id) {
      logger.warn({ tenantId, nodeId: node.id }, 'calendar node: missing calendar_id');
      return { output: null, nextNodeId: node.next, updatedVars: {}, terminal: false, fallback: false };
    }
    const slots = await calSvc.getAvailableSlots(cfg.calendar_id, cfg.range_days || 5);
    if (!slots.length) {
      return {
        output: { type: 'text', text: cfg.no_slots_text || 'No hay horarios disponibles. Un agente te contactara.' },
        nextNodeId: (node.branches && node.branches.no_slots) || node.next,
        updatedVars: {}, terminal: false, fallback: false,
      };
    }
    const buttons = slots.slice(0, 10).map(s => ({ id: s.id, title: _formatSlotLabel(s.startTime) }));
    return {
      output: {
        type    : buttons.length <= 3 ? 'buttons' : 'list',
        text    : cfg.prompt || 'Selecciona una fecha y hora:',
        buttons,
        sections: buttons.length > 3 ? [{ title: 'Horarios disponibles', rows: buttons }] : [],
      },
      nextNodeId: node.id, updatedVars: {}, terminal: false, fallback: false,
    };
  }

  if (action === 'select_slot') {
    if (!input) return executeCalendar({ node: Object.assign({}, node, { action: 'show_availability' }), input: null, variables, tenantId });
    const bookResult = await calSvc.bookSlot({
      calendarId: cfg.calendar_id, slotId: input, tenantId,
      userKey: variables.phone || variables.user_key || 'unknown',
      conversationId: variables.conversation_id || null,
      metadata: { user_name: variables.name || null },
    });
    if (bookResult.error) {
      const errText = bookResult.error === 'SLOT_TAKEN'
        ? (cfg.slot_taken_text || 'Ese horario ya fue reservado. Elige otro.')
        : (cfg.error_text || 'No pude completar la reserva. Intenta de nuevo.');
      return { output: { type: 'text', text: errText }, nextNodeId: node.id, updatedVars: {}, terminal: false, fallback: false };
    }
    const a = bookResult.appointment;
    return {
      output: null, nextNodeId: node.next,
      updatedVars: { appointment_id: a.id, appointment_start: a.startTime.toISOString(), appointment_end: a.endTime.toISOString(), appointment_status: 'scheduled' },
      terminal: false, fallback: false,
    };
  }

  if (action === 'create_appointment') {
    const slotId = variables.selected_slot_id || cfg.slot_id;
    if (!slotId || !cfg.calendar_id) {
      return { output: null, nextNodeId: node.next, updatedVars: {}, terminal: false, fallback: false };
    }
    const bookResult = await calSvc.bookSlot({ calendarId: cfg.calendar_id, slotId, tenantId, userKey: variables.phone || 'unknown', conversationId: variables.conversation_id || null, metadata: { user_name: variables.name || null } });
    if (bookResult.error) return { output: null, nextNodeId: (node.branches && node.branches.error) || node.next, updatedVars: {}, terminal: false, fallback: false };
    const a = bookResult.appointment;
    return { output: null, nextNodeId: node.next, updatedVars: { appointment_id: a.id, appointment_start: a.startTime.toISOString(), appointment_end: a.endTime.toISOString(), appointment_status: 'scheduled' }, terminal: false, fallback: false };
  }

  if (action === 'reschedule_appointment') {
    const apptId    = variables.appointment_id;
    const newSlotId = input || variables.new_slot_id;
    if (!apptId || !newSlotId) return { output: null, nextNodeId: node.next, updatedVars: {}, terminal: false, fallback: false };
    const result = await calSvc.rescheduleAppointment(apptId, newSlotId, tenantId);
    if (result.error) return { output: null, nextNodeId: (node.branches && node.branches.error) || node.next, updatedVars: {}, terminal: false, fallback: false };
    const a = result.appointment;
    return { output: null, nextNodeId: node.next, updatedVars: { appointment_id: a.id, appointment_start: a.startTime.toISOString(), appointment_end: a.endTime.toISOString(), appointment_status: 'rescheduled' }, terminal: false, fallback: false };
  }

  if (action === 'cancel_appointment') {
    const apptId = variables.appointment_id || cfg.appointment_id;
    if (!apptId) return { output: null, nextNodeId: node.next, updatedVars: {}, terminal: false, fallback: false };
    const result = await calSvc.cancelAppointment(apptId, tenantId);
    return { output: null, nextNodeId: node.next, updatedVars: result.ok ? { appointment_status: 'cancelled' } : {}, terminal: false, fallback: false };
  }

  logger.warn({ tenantId, nodeId: node.id, action }, 'calendar node: unknown action');
  return { output: null, nextNodeId: node.next, updatedVars: {}, terminal: false, fallback: false };
}

function _formatSlotLabel(date) {
  if (!(date instanceof Date)) date = new Date(date);
  return date.toLocaleDateString('es-MX', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

const EXECUTORS = {
  start    : executeStart,
  message  : executeMessage,
  menu     : executeMenu,
  input    : executeInput,
  condition: executeCondition,
  action   : executeAction,
  task     : executeTask,
  llm      : executeLlm,
  delay    : executeDelay,
  end      : executeEnd,
  handoff  : executeHandoff,
  calendar : executeCalendar,
};

/**
 * Execute a single node.
 *
 * @param {object}  node           - NodeDef from FlowLoader
 * @param {object}  opts
 * @param {string}  opts.input     - Raw user input
 * @param {object}  opts.variables - Current session variables
 * @param {string}  opts.tenantId
 * @param {object}  [opts.llmService]       - injected LLM service
 * @param {object}  [opts.integrationRunner] - injected IntegrationRunner
 * @returns {Promise<ExecutorResult>}
 */
async function executeNode(node, { input, variables, tenantId, llmService, integrationRunner }) {
  const executor = EXECUTORS[node.type];

  if (!executor) {
    logger.warn({ tenantId, nodeType: node.type }, 'nodeExecutors: unknown node type — skipping');
    return { output: null, nextNodeId: node.next, updatedVars: {}, terminal: false, fallback: false };
  }

  return executor({ node, input, variables, tenantId, llmService, integrationRunner });
}

module.exports = { executeNode, resolveTemplate, resolveConfig };
