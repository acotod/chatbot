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

const { loadFlowDefinition } = require('../engine/flowLoader');
const { executeNode }         = require('../engine/nodeExecutors');
const contextStore            = require('../engine/contextStore');
const integrationRunner       = require('../engine/integrationRunner');
const logger                  = require('../utils/logger');

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
 * @returns {Promise<{ nodeId: string, content: object } | null>}
 */
async function executeStep({ tenantId, currentNodeId, input, userId, sessionKey }) {
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

  const variables = state.variables ?? {};

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
  } catch (err) {
    logger.error({ tenantId, nodeRef: resolvedNodeRef, message: err.message }, 'flowEngine: node execution error');
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

  // ── For start nodes: auto-advance to entryPoint message ──────────────────
  // start nodes have no output — advance one more step automatically
  if (node.type === 'start' && execResult.nextNodeId) {
    return executeStep({
      tenantId,
      currentNodeId: _toIntOrNull(execResult.nextNodeId),
      input,
      userId,
      sessionKey,
    });
  }

  if (!execResult.output && !execResult.terminal) {
    // Condition/action nodes with no output — advance silently
    if (execResult.nextNodeId) {
      return executeStep({
        tenantId,
        currentNodeId: _toIntOrNull(execResult.nextNodeId),
        input,
        userId,
        sessionKey,
      });
    }
    return null;
  }

  // ── Build nodeId for caller (chatbotRouter stores this as currentNodeId) ──
  const outputNodeId = execResult.nextNodeId
    ? _toIntOrNull(execResult.nextNodeId) ?? execResult.nextNodeId
    : null;

  return {
    nodeId : outputNodeId,
    content: execResult.output,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function _toIntOrNull(ref) {
  if (ref == null) return null;
  const n = parseInt(ref, 10);
  return Number.isNaN(n) ? null : n;
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


