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
const crmSync                 = require('./crmSync');
const logger                  = require('../utils/logger');

const prisma = new PrismaClient();
const FLOW_UX_OVERRIDES_KEY = 'flow_ux_overrides';
const FLOW_UX_OVERRIDES_TTL_MS = 30 * 1000;
const flowUxOverridesCache = new Map();

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
 * @param {object}      [opts.conversationMeta] - persisted marker for conversation origin/scope
 * @returns {Promise<{ nodeId: string, content: object } | null>}
 */
async function executeStep({ tenantId, currentNodeId, input, userId, sessionKey, _conversationId, conversationMeta }) {
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

  // ── Conversation event-sourcing: ensure an active Conversation row exists ─
  // conversationId is propagated through recursive calls so we don't re-create.
  const userKey = sessionKey ?? (userId != null ? String(userId) : null);
  let conversationId = _conversationId ?? null;
  if (!conversationId && userKey) {
    conversationId = await convLogger.getOrCreate(
      tenantId, userKey, flowDef.flowId, flowDef.versionId ?? null, { contextMeta: conversationMeta },
    );
  }

  const isInitialExecution =
    flowDef.source === 'version' &&
    userId != null &&
    !state.executionId &&
    !state.currentNodeRef;

  let variables = state.variables ?? {};
  if (conversationId && variables.conversation_id == null) {
    variables = { ...variables, conversation_id: conversationId };
  }
  if (isInitialExecution) {
    variables = await _bootstrapExecutionVariables({
      tenantId,
      flowId: flowDef.flowId,
      definitionVariables: flowDef.variables,
      sessionKey,
      conversationId,
      variables,
    });
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

  // Per-tenant/per-node UX customization. This allows business-specific copy
  // and interactive layouts without code changes.
  const effectiveOutput = await _applyTenantNodeUxOverride({
    tenantId,
    nodeRef: resolvedNodeRef,
    output: execResult.output,
  });
  if (effectiveOutput !== execResult.output) {
    execResult = { ...execResult, output: effectiveOutput };
  }

  // Best-effort CRM enrichment from flow-captured values (e.g. input crmField=nombre).
  if (userId != null && execResult.crmTouch?.nombre) {
    crmSync.touch({
      userId,
      prisma: db.getPrismaClient(),
      canal: 'chatbot',
      nombre: execResult.crmTouch.nombre,
    }).catch(() => {});
  }

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
      // Do not forward previous user input when auto-advancing internal nodes.
      input: null,
      userId,
      sessionKey,
      _conversationId: conversationId,
      conversationMeta,
    });
  }

  if (!execResult.output && !execResult.terminal && !execResult.paused) {
    // Condition/action nodes with no output — advance silently
    if (execResult.nextNodeId) {
      return executeStep({
        tenantId,
        currentNodeId  : _toIntOrNull(execResult.nextNodeId),
        // Avoid consuming the same user input in the next node (e.g. menu -> input).
        input: null,
        userId,
        sessionKey,
        _conversationId: conversationId,
        conversationMeta,
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
      return;

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

function _sanitizeOutputShape(rawOutput, fallbackOutput) {
  if (!rawOutput || typeof rawOutput !== 'object' || Array.isArray(rawOutput)) {
    return fallbackOutput;
  }

  const next = { ...rawOutput };

  if (next.type != null) next.type = String(next.type);
  if (next.text != null) next.text = String(next.text);

  if (Array.isArray(next.buttons)) {
    next.buttons = next.buttons
      .filter((btn) => btn && typeof btn === 'object')
      .map((btn) => ({
        id: String(btn.id ?? '').trim(),
        title: String(btn.title ?? '').trim(),
      }))
      .filter((btn) => btn.id && btn.title);
  }

  if (!Array.isArray(next.buttons)) delete next.buttons;
  if (!Array.isArray(next.sections)) delete next.sections;

  return next;
}

function _buildNodeOverrideCandidates(nodeRef) {
  const ref = String(nodeRef ?? '').trim();
  if (!ref) return [];

  const candidates = [ref];
  if (/^\d+$/.test(ref)) {
    candidates.push(`node_${ref}`);
  } else {
    const match = ref.match(/^node_(\d+)$/i);
    if (match) candidates.push(String(Number(match[1])));
  }

  return [...new Set(candidates)];
}

async function _getTenantFlowUxOverrides(tenantId) {
  if (!tenantId) return null;

  const now = Date.now();
  const cached = flowUxOverridesCache.get(tenantId);
  if (cached && now < cached.expiresAt) {
    return cached.value;
  }

  let parsed = null;
  try {
    const row = await db.getConfig(tenantId, FLOW_UX_OVERRIDES_KEY);
    const value = row?.valor;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      parsed = value;
    }
  } catch (err) {
    logger.warn({ tenantId, message: err.message }, 'flowEngine: failed to load flow_ux_overrides config');
  }

  flowUxOverridesCache.set(tenantId, {
    value: parsed,
    expiresAt: now + FLOW_UX_OVERRIDES_TTL_MS,
  });

  return parsed;
}

async function _applyTenantNodeUxOverride({ tenantId, nodeRef, output }) {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return output;

  const cfg = await _getTenantFlowUxOverrides(tenantId);
  if (!cfg) return output;

  const nodeMap = (cfg.nodes && typeof cfg.nodes === 'object' && !Array.isArray(cfg.nodes))
    ? cfg.nodes
    : cfg;

  const candidates = _buildNodeOverrideCandidates(nodeRef);
  let nodeOverride = null;
  for (const key of candidates) {
    if (nodeMap[key] && typeof nodeMap[key] === 'object' && !Array.isArray(nodeMap[key])) {
      nodeOverride = nodeMap[key];
      break;
    }
  }

  if (!nodeOverride) return output;

  if (nodeOverride.output && typeof nodeOverride.output === 'object' && !Array.isArray(nodeOverride.output)) {
    return _sanitizeOutputShape(nodeOverride.output, output);
  }

  const patched = { ...output };
  if (nodeOverride.type != null) patched.type = String(nodeOverride.type);
  if (nodeOverride.text != null) patched.text = String(nodeOverride.text);
  if (Array.isArray(nodeOverride.buttons)) patched.buttons = nodeOverride.buttons;
  if (Array.isArray(nodeOverride.sections)) patched.sections = nodeOverride.sections;

  return _sanitizeOutputShape(patched, output);
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

  merged = await _runSessionInitEndpoints(tenantId, merged, variables?.conversation_id ?? null);
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

async function _runSessionInitEndpoints(tenantId, variables, conversationId = null) {
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
        const { responseVars } = await integrationRunner.run(tenantId, integrationRef, merged, {
          conversationId,
          nodeRef: null,
          nodeType: 'session_init',
          trigger: 'session_init',
        });
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

  const pickFirstText = (...candidates) => {
    for (const candidate of candidates) {
      const text = String(candidate ?? '').trim();
      if (text) return text;
    }
    return null;
  };

  if (action === 'create_task') {
    const resolvedAssignTo = await _resolveTaskAssignTo({ tenantId, cfg, variables });
    const mergedTaskVariables = {
      ...(variables ?? {}),
      ...(updatedVarsBase ?? {}),
    };

    const taskCustomerName = pickFirstText(
      cfg.nombre,
      cfg.customer_name,
      cfg.name,
      mergedTaskVariables.appointment_customer_name,
      mergedTaskVariables.nombre,
      mergedTaskVariables.name,
      mergedTaskVariables.user_name,
      mergedTaskVariables.full_name,
      mergedTaskVariables.cliente_nombre,
    );

    const taskCustomerNotes = pickFirstText(
      cfg.customer_notes,
      cfg.notes,
      cfg.note,
      mergedTaskVariables.appointment_notes_summary,
      mergedTaskVariables.customer_notes,
      mergedTaskVariables.notes,
      mergedTaskVariables.notas,
    );

    const taskSchedule = pickFirstText(
      cfg.horario,
      mergedTaskVariables.horario,
      mergedTaskVariables.appointment_start,
      mergedTaskVariables.agenda_hora_seleccionada,
    );

    const created = await db.createOrReuseFlowTask({
      tenantId,
      userId,
      flowId: flowDef.flowId,
      conversationId,
      flowNodeRef: nodeRef,
      sessionKey,
      title: cfg.title,
      assignTo: resolvedAssignTo,
      priority: cfg.priority,
      nombre: taskCustomerName,
      customerNotes: taskCustomerNotes,
      horario: taskSchedule,
      variables: mergedTaskVariables,
      requestedStatus: cfg.status,
    });

    const solicitud = created?.solicitud ?? null;
    const updatedVars = {
      ...updatedVarsBase,
      task_id: solicitud?.id ?? null,
      task_status: solicitud?.estado ?? null,
      task_origin: solicitud?.origin ?? 'bot',
      task_assigned_agente_id: solicitud?.agenteId ?? null,
    };

    const allowUserMessageOverride = node?.type === 'task' && cfg.user_message;

    return {
      ...execResult,
      output: allowUserMessageOverride ? { type: 'text', text: String(cfg.user_message) } : execResult.output,
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

function _extractPositiveInt(value) {
  if (value == null) return null;
  const match = String(value).match(/(\d+)/);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

async function _pickLeastLoadAgentId(tenantId, { puestoId = null, puestoNombre = null } = {}) {
  const where = { tenantId, estado: 'activo' };

  if (Number.isInteger(puestoId) && puestoId > 0) {
    where.puestoId = puestoId;
  } else if (puestoNombre && String(puestoNombre).trim()) {
    where.puesto = {
      nombre: {
        equals: String(puestoNombre).trim(),
        mode: 'insensitive',
      },
    };
  }

  const activeAgents = await prisma.agente.findMany({
    where,
    select: { id: true },
  });

  if (!activeAgents.length) return null;

  const agentIds = activeAgents.map((agent) => agent.id);
  const grouped = await prisma.solicitud.groupBy({
    by: ['agenteId'],
    where: {
      tenantId,
      agenteId: { in: agentIds },
      estado: { in: ['open', 'in_progress', 'pending_info'] },
    },
    _count: { _all: true },
  });

  const workload = new Map(grouped.map((row) => [Number(row.agenteId), Number(row._count?._all ?? 0)]));

  const sorted = [...agentIds].sort((a, b) => {
    const loadA = workload.get(a) ?? 0;
    const loadB = workload.get(b) ?? 0;
    if (loadA !== loadB) return loadA - loadB;
    return a - b;
  });

  return sorted[0] ?? null;
}

async function _resolveTaskAssignTo({ tenantId, cfg, variables }) {
  const mode = String(cfg.assignment_mode ?? cfg.assign_mode ?? '').trim().toLowerCase();

  if (!mode || mode === 'none' || mode === 'unassigned') {
    return cfg.assign_to ?? null;
  }

  if (mode === 'fixed') {
    return cfg.assign_to ?? null;
  }

  if (mode === 'variable') {
    const variableName = String(cfg.assign_to_var ?? '').trim();
    if (!variableName) return null;
    return variables?.[variableName] ?? null;
  }

  if (mode === 'least_load') {
    try {
      return await _pickLeastLoadAgentId(tenantId);
    } catch (err) {
      logger.warn({ tenantId, message: err.message }, 'flowEngine: failed to resolve least-load assignment');
      return null;
    }
  }

  if (mode === 'by_puesto' || mode === 'puesto') {
    const parsedPuestoId = _extractPositiveInt(
      cfg.assign_to_puesto_id
      ?? cfg.agente_puesto_id
      ?? cfg.puesto_id
      ?? null,
    );

    const puestoNombre = String(
      cfg.assign_to_puesto_nombre
      ?? cfg.agente_puesto_nombre
      ?? cfg.puesto_nombre
      ?? '',
    ).trim();

    try {
      return await _pickLeastLoadAgentId(tenantId, {
        puestoId: parsedPuestoId,
        puestoNombre,
      });
    } catch (err) {
      logger.warn({ tenantId, message: err.message }, 'flowEngine: failed to resolve puesto assignment');
      return null;
    }
  }

  // Backward compatibility: legacy config directly using assign_to.
  const direct = _extractPositiveInt(cfg.assign_to);
  if (direct) return direct;

  return cfg.assign_to ?? null;
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


