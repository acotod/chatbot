'use strict';
/**
 * Flow Engine — enterprise orchestrator (hybrid JSON-driven + legacy fallback).
 *
 * Architecture (fully decoupled):
 *
 *   FlowLoader        → loads flow definition (JSONB version OR legacy node/edge)
 *   NodeExecutors     → pure stateless functions per node type
 *   ContextStore      → reads/writes execution state (FlowExecution or ConversationContext)
 *   IntegrationRunner → resolves and executes dynamic API integrations
 *
 * Public interface (backward compatible with chatbotRouter):
 *
 *   executeStep({ tenantId, currentNodeId, input })
 *     → { nodeId, content } | null
 *
 * The `currentNodeId` parameter is kept for backward compat.
 * For versioned flows, nodeId is a string (ej: "node_1"); for legacy flows
 * it remains an integer string representation.
 *
 * Node types supported:
 *   start, message, input, menu, condition, action, llm, delay, end, handoff
 *
 * Node content returned (content.type):
 *   "text"    → { type, text }
 *   "buttons" → { type, text, buttons: [{id, title}] }
 *   "list"    → { type, text, sections: [{title, rows: [{id, title}]}] }
 *   "handoff" → { type, text }   triggers human fallback in chatbotRouter
 *   "end"     → { type, text }   ends conversation
 */

const { PrismaClient }        = require('@prisma/client');
const { loadFlowDefinition } = require('../engine/flowLoader');
const { executeNode }         = require('../engine/nodeExecutors');
const contextStore            = require('../engine/contextStore');
const integrationRunner       = require('../engine/integrationRunner');
const convLogger              = require('../engine/conversationLogger');
const { getCatalog }          = require('./endpointCatalog');
const db                      = require('./database');
const logger                  = require('../utils/logger');

const prisma = new PrismaClient();

// ─────────────────────────────────────────────────────────────────────────────
// Public: executeStep
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Execute one conversational step for a tenant user.
 *
 * @param {object}      opts
 * @param {string}      opts.tenantId
 * @param {number|null} opts.currentNodeId  - null = start of conversation (legacy compat)
 * @param {string}      opts.input          - user's message / button id
 * @param {number}      [opts.userId]       - DB user id (needed for ContextStore)
 * @param {string}      [opts.sessionKey]   - phone or other session identifier
 * @param {string}      [opts._conversationId] - internal: propagated through recursion
 * @returns {Promise<{ nodeId: string, content: object } | null>}
 */
async function executeStep({ tenantId, currentNodeId, input, userId, sessionKey, _conversationId }) {
  // Lazy-load LLM service to avoid circular imports
  const llmService = require('./llmService');

  // ── Load flow definition ─────────────────────────────────────────────────
  const flowDef = await loadFlowDefinition(tenantId);
  if (!flowDef) {
    logger.warn({ tenantId }, 'flowEngine: no active flow found');
    return null;
  }

  // ── Resolve current node ─────────────────────────────────────────────────
  // For versioned flows: load state from FlowExecution.
  // For legacy flows: currentNodeId is the DB integer passed by chatbotRouter.
  let resolvedNodeRef = null;

  if (flowDef.source === 'version' && userId != null) {
    const state = await contextStore.getState(tenantId, userId, 'version', flowDef.flowId);
    resolvedNodeRef = state.currentNodeRef;
  } else {
    // Legacy: convert integer id → string key used in nodesMap
    resolvedNodeRef = currentNodeId != null ? String(currentNodeId) : null;
  }

  // ── Determine the node to execute ────────────────────────────────────────
  // null = start of conversation → use entryPoint
  if (!resolvedNodeRef) {
    resolvedNodeRef = flowDef.entryPoint;
  }

  const node = flowDef.nodesMap[resolvedNodeRef];
  if (!node) {
    logger.warn({ tenantId, resolvedNodeRef }, 'flowEngine: node not found in definition');
    return null;
  }

  // ── Get current execution state (variables, executionId) ─────────────────
  let state = { source: flowDef.source === 'version' ? 'execution' : 'legacy',
                executionId: null, variables: {}, currentNodeId: null };

  if (userId != null) {
    state = await contextStore.getState(tenantId, userId, flowDef.source, flowDef.flowId);
  }

  const isInitialExecution =
    flowDef.source === 'version' &&
    userId != null &&
    !state.executionId &&
    !state.currentNodeRef;

  let variables = state.variables ?? {};
  if (isInitialExecution) {
    variables = await _bootstrapExecutionVariables({
      tenantId,
      flowId: flowDef.flowId,
      definitionVariables: flowDef.variables,
      sessionKey,
      variables,
    });
  }

  // ── Conversation event-sourcing: ensure an active Conversation row exists ─
  // conversationId is propagated through recursive calls so we don't re-create.
  const userKey = sessionKey ?? (userId != null ? String(userId) : null);
  let conversationId = _conversationId ?? null;
  if (!conversationId && userKey) {
    conversationId = await convLogger.getOrCreate(
      tenantId, userKey, flowDef.flowId, flowDef.versionId ?? null,
    );
  }

  // ── Execute the node ─────────────────────────────────────────────────────
  const t0 = Date.now();
  let execResult;

  try {
    execResult = await executeNode(node, {
      input,
      variables,
      tenantId,
      llmService,
      integrationRunner,
    });

    if (execResult?.control?.type === 'task') {
      execResult = await _handleTaskControl({
        tenantId,
        flowDef,
        node,
        nodeRef: resolvedNodeRef,
        execResult,
        variables,
        updatedVarsBase: execResult.updatedVars ?? {},
        conversationId,
        userId,
        sessionKey,
      });
    }
  } catch (err) {
    logger.error({ tenantId, nodeRef: resolvedNodeRef, message: err.message }, 'flowEngine: node execution error');
    // Log error event before returning
    await convLogger.log(conversationId, tenantId, resolvedNodeRef,
      convLogger.EVENT.FLOW_ERROR, { error_message: err.message, node_type: node.type });
    return null;
  }

  const durationMs = Date.now() - t0;

  // ── Merge updated variables ───────────────────────────────────────────────
  const updatedVars = { ...variables, ...(execResult.updatedVars ?? {}) };

  // ── Persist state ─────────────────────────────────────────────────────────
  if (userId != null) {
    const nextRef  = execResult.terminal ? null : (execResult.nextNodeId ?? null);
    const { executionId } = await contextStore.saveState(tenantId, userId, {
      source        : state.source,
      executionId   : state.executionId,
      flowId        : flowDef.flowId,
      flowVersionId : flowDef.versionId,
      sessionKey    : sessionKey ?? String(userId),
      currentNodeRef: nextRef,
      currentNodeId : nextRef != null ? _toIntOrNull(nextRef) : null,
      variables     : updatedVars,
      terminal      : execResult.terminal,
    });

    // Append execution log for versioned flows
    if (state.source === 'execution' || flowDef.source === 'version') {
      await contextStore.appendLog(executionId ?? state.executionId, tenantId, {
        nodeRef     : resolvedNodeRef,
        nodeType    : node.type,
        input       : input != null ? { raw: input } : null,
        output      : execResult.output,
        durationMs,
        status      : 'ok',
        errorMessage: null,
      });
    }
  }

  // ── Log conversation event ────────────────────────────────────────────────
  await _logNodeEvent(conversationId, tenantId, resolvedNodeRef, node, input, execResult, updatedVars, durationMs);

  // If terminal: end the conversation
  if (execResult.terminal && conversationId) {
    const finalStatus = node.type === 'handoff' ? 'abandoned' : 'completed';
    await convLogger.end(conversationId, finalStatus, { variables: updatedVars });
  } else if (conversationId && userKey) {
    // Update context snapshot so the conversations row reflects current state
    await convLogger.updateContext(conversationId, {
      current_node: execResult.nextNodeId ?? resolvedNodeRef,
      variables   : updatedVars,
    });
  }

  // ── For start nodes: auto-advance to entryPoint message ──────────────────
  // start nodes have no output — advance one more step automatically
  if (node.type === 'start' && execResult.nextNodeId) {
    return executeStep({
      tenantId,
      currentNodeId  : _toIntOrNull(execResult.nextNodeId),
      input,
      userId,
      sessionKey,
      _conversationId: conversationId,
    });
  }

  if (!execResult.output && !execResult.terminal && !execResult.paused) {
    // Condition/action nodes with no output — advance silently
    if (execResult.nextNodeId) {
      return executeStep({
        tenantId,
        currentNodeId  : _toIntOrNull(execResult.nextNodeId),
        input,
        userId,
        sessionKey,
        _conversationId: conversationId,
      });
    }
    return null;
  }

  // ── Build nodeId for caller (chatbotRouter stores this as currentNodeId) ──
  const outputNodeId = execResult.nextNodeId
    ? _toIntOrNull(execResult.nextNodeId) ?? execResult.nextNodeId
    : null;

  return {
    nodeId         : outputNodeId,
    content        : execResult.output,
    conversationId,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Derive the conversation event type and payload from a node execution result.
 * Best-effort: errors are swallowed by convLogger.log internally.
 */
async function _logNodeEvent(conversationId, tenantId, nodeRef, node, input, execResult, updatedVars, durationMs) {
  if (!conversationId) return;

  const { EVENT } = convLogger;
  let eventType;
  let payload;

  switch (node.type) {
    case 'start':
      eventType = EVENT.FLOW_START;
      payload   = { node_ref: nodeRef };
      break;

    case 'message':
      eventType = EVENT.MESSAGE_SENT;
      payload   = { node_type: 'message', text: execResult.output?.text ?? null };
      break;

    case 'input':
      if (execResult.output) {
        // Showing the question to the user
        eventType = EVENT.MESSAGE_SENT;
        payload   = { node_type: 'input', text: execResult.output.text ?? null };
      } else {
        // Receiving user's answer
        eventType = EVENT.USER_INPUT;
        payload   = {
          raw_input   : input ?? null,
          variable_set: node.config?.variable ?? null,
          value       : updatedVars[node.config?.variable] ?? null,
        };
      }
      break;

    case 'menu':
      if (execResult.output) {
        eventType = EVENT.MESSAGE_SENT;
        payload   = {
          node_type: 'menu',
          text     : execResult.output.text ?? null,
          options  : execResult.output.buttons ?? execResult.output.sections ?? null,
        };
      } else {
        eventType = EVENT.MENU_SELECTION;
        payload   = {
          selected_id : input ?? null,
          next_node   : execResult.nextNodeId ?? null,
        };
      }
      break;

    case 'condition':
      eventType = EVENT.CONDITION_EVAL;
      payload   = {
        result   : execResult.nextNodeId != null,
        next_node: execResult.nextNodeId ?? null,
      };
      break;

    case 'action':
      eventType = EVENT.API_CALL;
      payload   = {
        integration_ref: node.config?.integration ?? null,
        duration_ms    : durationMs,
        response_vars  : execResult.updatedVars ?? {},
      };
      break;

    case 'task': {
      const action = execResult?.control?.action ?? node.config?.action ?? 'task';
      if (action === 'create_task') {
        eventType = EVENT.TASK_CREATED;
      } else if (execResult?.paused) {
        eventType = EVENT.TASK_WAITING;
      } else {
        eventType = EVENT.TASK_COMPLETED;
      }
      payload = {
        action,
        task_id: updatedVars?.task_id ?? null,
        task_status: updatedVars?.task_status ?? null,
        title: node.config?.title ?? null,
      };
      break;
    }

    case 'llm':
      eventType = EVENT.LLM_CALL;
      payload   = {
        node_type: 'llm',
        duration_ms: durationMs,
        output   : execResult.output?.text ?? null,
      };
      break;

    case 'end':
      eventType = EVENT.FLOW_END;
      payload   = { final_variables: updatedVars };
      break;

    case 'handoff':
      eventType = EVENT.FLOW_HANDOFF;
      payload   = { reason: node.config?.reason ?? 'handoff', text: execResult.output?.text ?? null };
      break;

    case 'calendar': {
      const calAction = node.action || node.config?.action || 'show_availability';
      if (calAction === 'show_availability') {
        eventType = EVENT.CALENDAR_AVAILABILITY_SHOWN;
        payload   = { calendar_id: node.config?.calendar_id ?? null, slots_shown: execResult.output?.buttons?.length ?? 0 };
      } else if (calAction === 'select_slot') {
        eventType = input ? EVENT.CALENDAR_SLOT_SELECTED : EVENT.CALENDAR_AVAILABILITY_SHOWN;
        payload   = { calendar_id: node.config?.calendar_id ?? null, slot_id: input ?? null, appointment_id: updatedVars?.appointment_id ?? null };
      } else if (calAction === 'create_appointment' || calAction === 'select_slot') {
        eventType = EVENT.APPOINTMENT_CREATED;
        payload   = { appointment_id: updatedVars?.appointment_id ?? null, calendar_id: node.config?.calendar_id ?? null };
      } else if (calAction === 'reschedule_appointment') {
        eventType = EVENT.APPOINTMENT_RESCHEDULED;
        payload   = { appointment_id: updatedVars?.appointment_id ?? null };
      } else if (calAction === 'cancel_appointment') {
        eventType = EVENT.APPOINTMENT_CANCELLED;
        payload   = { appointment_id: node.config?.appointment_id ?? updatedVars?.appointment_id ?? null };
      } else {
        eventType = EVENT.MESSAGE_SENT;
        payload   = { node_type: 'calendar', action: calAction };
      }
      break;
    }

    default:
      eventType = EVENT.MESSAGE_SENT;
      payload   = { node_type: node.type };
  }

  await convLogger.log(conversationId, tenantId, nodeRef, eventType, payload);
}

function _toIntOrNull(ref) {
  if (ref == null) return null;
  const n = parseInt(ref, 10);
  return Number.isNaN(n) ? null : n;
}

async function _bootstrapExecutionVariables({ tenantId, flowId, definitionVariables, sessionKey, variables }) {
  const definitionDefaults = _extractDefinitionDefaults(definitionVariables);
  const dbDefaults = await _loadDefaultVariables(tenantId, flowId);

  let merged = {
    ...definitionDefaults,
    ...dbDefaults,
    ...(variables ?? {}),
  };

  if (sessionKey) {
    if (merged.session_key == null) merged.session_key = sessionKey;
    if (merged.telefono == null) merged.telefono = sessionKey;
  }

  merged = await _runSessionInitEndpoints(tenantId, merged);
  return merged;
}

async function _loadDefaultVariables(tenantId, flowId) {
  try {
    const variables = await prisma.flowVariable.findMany({
      where: {
        tenantId,
        OR: [
          { scope: 'global', flowId: null },
          { scope: 'flow', flowId },
        ],
      },
      select: {
        nombre: true,
        valorDefault: true,
        flowId: true,
      },
      orderBy: [
        { flowId: 'asc' },
        { id: 'asc' },
      ],
    });

    return variables.reduce((acc, variable) => {
      acc[variable.nombre] = variable.valorDefault ?? null;
      return acc;
    }, {});
  } catch (err) {
    logger.warn({ tenantId, flowId, message: err.message }, 'flowEngine: failed to load default variables');
    return {};
  }
}

function _extractDefinitionDefaults(definitionVariables) {
  if (!definitionVariables || typeof definitionVariables !== 'object') return {};

  return Object.entries(definitionVariables).reduce((acc, [name, value]) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (Object.prototype.hasOwnProperty.call(value, 'valorDefault')) {
        acc[name] = value.valorDefault;
        return acc;
      }
      if (Object.prototype.hasOwnProperty.call(value, 'default')) {
        acc[name] = value.default;
        return acc;
      }
      if (Object.prototype.hasOwnProperty.call(value, 'value')) {
        acc[name] = value.value;
        return acc;
      }
    }

    acc[name] = value;
    return acc;
  }, {});
}

async function _runSessionInitEndpoints(tenantId, variables) {
  let catalog;

  try {
    catalog = await getCatalog(tenantId);
  } catch (err) {
    logger.warn({ tenantId, message: err.message }, 'flowEngine: failed to load endpoint catalog');
    return variables;
  }

  const sessionInitEndpoints = Array.isArray(catalog?.endpoints)
    ? catalog.endpoints.filter((endpoint) => endpoint?.sessionInit)
    : [];

  if (sessionInitEndpoints.length === 0) return variables;

  let merged = { ...variables };

  for (const endpoint of sessionInitEndpoints) {
    const candidateRefs = [...new Set([endpoint?.id, endpoint?.name].filter(Boolean))];
    let resolved = false;

    for (const integrationRef of candidateRefs) {
      try {
        const { responseVars } = await integrationRunner.run(tenantId, integrationRef, merged);
        merged = { ...merged, ...(responseVars ?? {}) };
        resolved = true;
        break;
      } catch (err) {
        logger.warn({ tenantId, integrationRef, message: err.message }, 'flowEngine: session init integration failed');
      }
    }

    if (!resolved) {
      logger.warn(
        { tenantId, endpointId: endpoint?.id, endpointName: endpoint?.name },
        'flowEngine: no session init integration could be resolved'
      );
    }
  }

  return merged;
}

async function _handleTaskControl({
  tenantId,
  flowDef,
  node,
  nodeRef,
  execResult,
  variables,
  updatedVarsBase,
  conversationId,
  userId,
  sessionKey,
}) {
  const action = execResult.control?.action;
  const cfg = execResult.control?.config ?? {};

  if (action === 'create_task') {
    const created = await db.createOrReuseFlowTask({
      tenantId,
      userId,
      flowId: flowDef.flowId,
      conversationId,
      flowNodeRef: nodeRef,
      sessionKey,
      title: cfg.title,
      assignTo: cfg.assign_to,
      priority: cfg.priority,
      variables,
      requestedStatus: cfg.status,
    });

    const solicitud = created?.solicitud ?? null;
    const updatedVars = {
      ...updatedVarsBase,
      task_id: solicitud?.id ?? null,
      task_status: solicitud?.estado ?? null,
      task_origin: solicitud?.origin ?? 'bot',
    };

    return {
      ...execResult,
      output: cfg.user_message ? { type: 'text', text: String(cfg.user_message) } : execResult.output,
      updatedVars,
    };
  }

  if (action === 'wait_for_task') {
    const targetStatus = db.normalizeSolicitudStatus(cfg.status, db.SOLICITUD_STATUS.COMPLETED);
    const variableTaskId = cfg.task_id_var ? variables[cfg.task_id_var] : null;
    const task = await db.findTaskForWait({
      tenantId,
      conversationId,
      userId,
      flowNodeRef: cfg.task_node_ref ?? nodeRef,
      taskId: variableTaskId ?? variables.task_id ?? null,
    });

    const currentStatus = task?.estado ? db.normalizeSolicitudStatus(task.estado, db.SOLICITUD_STATUS.OPEN) : null;
    const matched = currentStatus === targetStatus;

    const updatedVars = {
      ...updatedVarsBase,
      task_id: task?.id ?? variables.task_id ?? null,
      task_status: currentStatus,
    };

    if (matched) {
      return {
        ...execResult,
        updatedVars,
        paused: false,
      };
    }

    return {
      ...execResult,
      nextNodeId: node.id,
      output: cfg.wait_message ? { type: 'text', text: String(cfg.wait_message) } : null,
      updatedVars,
      paused: true,
    };
  }

  return execResult;
}

/**
 * @deprecated  Use executeStep. Kept for any direct callers of getActiveFlow.
 */
async function getActiveFlow(tenantId) {
  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient();
  return prisma.flow.findFirst({
    where  : { tenantId, activo: true },
    include: { nodes: true, edges: true },
    orderBy: { version: 'desc' },
  });
}

module.exports = { executeStep, getActiveFlow };


